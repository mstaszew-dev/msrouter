/**
 * INTEGRATION test: OpenCode Zen (BigPickle). Hits the REAL Zen endpoint.
 *
 * Gated: only runs when INTEGRATION=1 and OPENCODE_API_KEY is set.
 * Default `npm test` does NOT run this. Run with:
 *   INTEGRATION=1 npx vitest run test/opencode-zen.integration.spec.ts
 *
 * The /zen/v1 free tier requires x-opencode-session (2026-09-11: without it
 * the endpoint 400s with MissingSessionID); this probe mirrors the gateway
 * wiring and sends one (OPENCODE_SESSION_ID pins it, else a random UUID).
 *
 * BigPickle availability is community-reported as flaky; this test documents
 * the current state (live .env carries the pool as OPENCODE_KEY1..6, so the
 * gate accepts either form).
 */

import { randomUUID } from 'node:crypto';

import pino from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';

import { scrubSecrets } from '../src/providers/fetch.js';
import { SingleKeyProvider } from '../src/providers/single-key.js';
import type { ChatRequestBody } from '../src/providers/types.js';

const ZEN_KEY = process.env['OPENCODE_API_KEY'] ?? process.env['OPENCODE_KEY1'];
const RUN = process.env['INTEGRATION'] === '1' && !!ZEN_KEY;
const itOrSkip = RUN ? it : it.skip;

const silent = pino({ level: 'silent' });

const baseBody: ChatRequestBody = {
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
  stream: false,
  max_tokens: 10,
};

describe('OpenCode Zen / BigPickle integration (live)', () => {
  let provider: SingleKeyProvider;

  beforeAll(() => {
    provider = new SingleKeyProvider(
      {
        id: 'opencode-bigpickle',
        baseUrl: process.env['OPENCODE_BASE_URL'] ?? 'https://opencode.ai/zen/v1',
        apiKey: ZEN_KEY,
        defaultModel: 'big-pickle',
        extraHeaders: {
          'x-opencode-session': process.env['OPENCODE_SESSION_ID'] || randomUUID(),
        },
      },
      60_000,
      silent,
    );
  });

  itOrSkip('returns a 200 OK with an OpenAI-shaped completion', async () => {
    const res = await provider.attempt(baseBody, new AbortController().signal, {
      model: 'big-pickle',
    });
    if (res.kind !== 'OK') {
      // Distinguish KEY_FAILURE (auth/credits) from TRANSIENT (timeout/5xx).
      throw new Error(
        `Zen call did not succeed: kind=${res.kind} status=${res.status} msg=${scrubSecrets(res.message ?? '')}`,
      );
    }
    expect(res.response.status).toBe(200);
    const text = scrubSecrets(await res.response.text());
    expect(text.length).toBeGreaterThan(0);
    const json = JSON.parse(text) as { choices?: unknown };
    expect(json).toHaveProperty('choices');
    expect(Array.isArray(json.choices)).toBe(true);
  });
});
