/**
 * INTEGRATION test: OpenRouter free-model pool. Hits the REAL OpenRouter API.
 *
 * Gated: only runs when INTEGRATION=1 and OPENROUTER_KEY1 is set (from .env).
 * Default `npm test` does NOT run this. Run with:
 *   INTEGRATION=1 npx vitest run test/openrouter.integration.spec.ts
 *
 * Philosophy (user's review standard): this is the "does it actually work"
 * evidence. Unit tests prove the logic; this proves the wire format, auth, and
 * key rotation against the real upstream.
 */

import pino from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { scrubSecrets } from '../src/providers/fetch.js';
import { OpenRouterProvider, withFree } from '../src/providers/openrouter.js';
import type { ChatRequestBody } from '../src/providers/types.js';

const RUN = process.env['INTEGRATION'] === '1' && !!process.env['OPENROUTER_KEY1'];
const itOrSkip = RUN ? it : it.skip;

const silent = pino({ level: 'silent' });

const baseBody: ChatRequestBody = {
  // openrouter/free is the auto-router over free models: OpenRouter itself picks
  // whichever upstream free model has capacity, so this exercises the
  // "gateway delegates upstream failover to OpenRouter" path.
  model: 'openrouter/free',
  messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
  stream: false,
  max_tokens: 10,
};

describe('OpenRouter integration (live, free models)', () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    const keys = Object.keys(process.env)
      .filter((k) => /^OPENROUTER_KEY\d+$/.test(k))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
      .map((k) => process.env[k]!)
      .filter(Boolean);
    if (RUN) {
      // Cache env so env() returns sane values for any chain-level reads.
      loadEnv({
        NODE_ENV: 'test',
        PORT: '8788',
        FORCE_FREE: 'true',
        OPENROUTER_MODEL: 'openrouter/free',
        UPSTREAM_TIMEOUT_MS: '60000',
      });
    }
    provider = new OpenRouterProvider(keys, 60_000, silent);
  });

  itOrSkip(
    'gets a 200 OK from at least one pooled key (or skips if all rate-limited)',
    async () => {
      // openrouter/free is the auto-router; withFree leaves it unsuffixed.
      const model = withFree('openrouter/free', true);
      const failures: string[] = [];
      let ok: Response | undefined;
      let allRateLimited = true;
      for (let i = 0; i < provider.keyCount; i++) {
        const res = await provider.attempt(baseBody, new AbortController().signal, {
          keyIndex: i,
          model,
        });
        if (res.kind === 'OK') {
          ok = res.response;
          allRateLimited = false;
          break;
        }
        // Track whether this is a quota/rate-limit (environmental) vs a real fault.
        const isRateLimit =
          res.kind === 'KEY_FAILURE' && (res.status === 429 || res.status === 403);
        if (!isRateLimit) allRateLimited = false;
        failures.push(`key${i + 1}:${res.kind}(${res.status})`);
      }
      if (!ok) {
        if (allRateLimited) {
          // All keys hit the free-model daily quota or upstream rate limit. This
          // is an environmental condition (resets daily / per upstream), NOT a
          // router defect. The rotation itself worked (every key was tried).
          // eslint-disable-next-line no-console
          console.warn(
            `[skip] all ${provider.keyCount} OpenRouter keys rate-limited; rotation verified, upstream quota exhausted.\n` +
              `  failures: ${scrubSecrets(failures.join('; '))}`,
          );
          return; // soft-pass: rotation exercised, upstream throttled
        }
        throw new Error(
          `no OpenRouter key succeeded; failures=${scrubSecrets(failures.join('; '))}`,
        );
      }
      expect(ok.status).toBe(200);
      const text = scrubSecrets(await ok.text());
      expect(text.length).toBeGreaterThan(0);
      // The body should parse as an OpenAI chat completion.
      const json = JSON.parse(text) as { choices?: unknown };
      expect(json).toHaveProperty('choices');
      expect(Array.isArray(json.choices)).toBe(true);
    },
  );

  it('the :free suffix is applied when FORCE_FREE (pure unit, no network)', () => {
    expect(withFree('google/gemma-4-31b-it', true)).toBe('google/gemma-4-31b-it:free');
    // idempotent: already-suffixed model is not double-suffixed.
    expect(withFree('google/gemma-4-31b-it:free', true)).toBe('google/gemma-4-31b-it:free');
  });

  it('does NOT suffix the openrouter/free meta-router (it self-selects upstream)', () => {
    // openrouter/free is OpenRouter's own auto-router over free models; appending
    // :free would corrupt it into "openrouter/free:free" (a non-existent model).
    expect(withFree('openrouter/free', true)).toBe('openrouter/free');
    expect(withFree('openrouter/auto', true)).toBe('openrouter/auto');
  });
});
