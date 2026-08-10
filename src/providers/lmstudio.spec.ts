/**
 * LM Studio (Bionic) provider tests.
 *
 * LM Studio exposes an OpenAI-compatible /v1/chat/completions endpoint
 * (default http://127.0.0.1:1234/v1) that accepts any API key. LmStudioProvider
 * reuses SingleKeyProvider with a placeholder key, so these tests assert the
 * OpenAI-shaped contract: body passthrough with model rewritten, endpoint
 * {base}/chat/completions, and a Bearer placeholder that LM Studio ignores.
 */
import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LmStudioProvider } from './lmstudio.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeProvider(baseUrl = 'http://127.0.0.1:1234/v1') {
  return new LmStudioProvider({ baseUrl, defaultModel: 'google/gemma-4-e2b' }, 5000, silent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseBody = {
  model: 'ignored-alias',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

it('is available without a configured API key', () => {
  expect(makeProvider().available).toBe(true);
});

it('rewrites the model to the chain-resolved id and posts to {base}/chat/completions', async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const p = makeProvider();
  const res = await p.attempt(baseBody, new AbortController().signal, { model: 'google/gemma-4-e2b' });
  expect(res.kind).toBe('OK');
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  expect(body.model).toBe('google/gemma-4-e2b');
  // LM Studio accepts any bearer token; the placeholder is sent as-is.
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer lm-studio');
});

it('resolvedDefaultModel is the configured default', () => {
  expect(makeProvider().resolvedDefaultModel).toBe('google/gemma-4-e2b');
});
