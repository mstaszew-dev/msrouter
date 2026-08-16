/**
 * LM Studio (Bionic) provider tests.
 *
 * LM Studio exposes an OpenAI-compatible /v1/chat/completions endpoint
 * (default http://127.0.0.1:1234/v1) that accepts any API key. LmStudioProvider
 * reuses SingleKeyProvider with a placeholder key, so these tests assert the
 * OpenAI-shaped contract: body passthrough with model rewritten, endpoint
 * {base}/chat/completions, and a Bearer placeholder that LM Studio ignores.
 *
 * Model discovery: LM Studio reports the FULL local path of every loaded GGUF
 * (e.g. /Users/.../Qwen3.5-9B-Q4_K_M.gguf) at GET {base}/models, and which
 * model is loaded changes when the operator swaps GGUFs. The provider resolves
 * the chain-requested model against the discovered list at call time so a
 * short alias ("qwen3.5-9b") keeps working across 9B <-> 4B swaps.
 */
import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LmStudioProvider, normalizeModelToken, resolveLmStudioModel } from './lmstudio.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeProvider(baseUrl = 'http://127.0.0.1:1234/v1', defaultModel = 'google/gemma-4-e4b') {
  return new LmStudioProvider({ baseUrl, defaultModel }, 5000, silent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseBody = {
  model: 'ignored-alias',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

const QWEN_9B_PATH =
  '/Users/mst/.lmstudio/models/lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf';
const QWEN_4B_PATH =
  '/Users/mst/.lmstudio/models/lmstudio-community/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf';

/** fetch stub that answers GET {base}/models with `loaded` and POST
 *  {base}/chat/completions with a minimal non-empty completion. */
function stubLmStudio(
  loaded: string[],
  opts: { modelsStatus?: number; failDiscovery?: boolean } = {},
) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: u, method, body: rawBody ? JSON.parse(rawBody) : undefined });
    if (u.endsWith('/models')) {
      if (opts.failDiscovery) throw new Error('connection refused');
      return new Response(JSON.stringify({ object: 'list', data: loaded.map((id) => ({ id })) }), {
        status: opts.modelsStatus ?? 200,
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

it('is available without a configured API key', () => {
  expect(makeProvider().available).toBe(true);
});

it('rewrites the model to the chain-resolved id and posts to {base}/chat/completions', async () => {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const p = makeProvider();
  const res = await p.attempt(baseBody, new AbortController().signal, {
    model: 'google/gemma-4-e4b',
  });
  expect(res.kind).toBe('OK');
  // Discovery GETs /models first; the completion is the POST call.
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST') as [
    string,
    RequestInit,
  ];
  expect(post[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
  const rawBody = typeof post[1].body === 'string' ? post[1].body : '';
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  expect(body.model).toBe('google/gemma-4-e4b');
  // LM Studio accepts any bearer token; the placeholder is sent as-is.
  expect((post[1].headers as Record<string, string>).authorization).toBe('Bearer lm-studio');
});

it('resolvedDefaultModel is the configured default', () => {
  expect(makeProvider().resolvedDefaultModel).toBe('google/gemma-4-e4b');
});

describe('normalizeModelToken', () => {
  it('strips path, .gguf extension, and quantization suffix', () => {
    expect(normalizeModelToken(QWEN_9B_PATH)).toBe('qwen359b');
    expect(normalizeModelToken('Qwen3.5-9B-Q4_K_M.gguf')).toBe('qwen359b');
    expect(normalizeModelToken('qwen3.5-9b')).toBe('qwen359b');
    expect(normalizeModelToken('qwen3.5-4b')).toBe('qwen354b');
    expect(normalizeModelToken('qwen3.5-9b-q8_0')).toBe('qwen359b');
  });
});

describe('resolveLmStudioModel', () => {
  it('returns the exact loaded id when requested matches verbatim', () => {
    expect(resolveLmStudioModel([QWEN_9B_PATH], QWEN_9B_PATH)).toBe(QWEN_9B_PATH);
  });

  it('fuzzy-matches a short alias to the loaded full path', () => {
    expect(resolveLmStudioModel([QWEN_9B_PATH], 'qwen3.5-9b')).toBe(QWEN_9B_PATH);
    expect(resolveLmStudioModel([QWEN_4B_PATH], 'qwen3.5-4b')).toBe(QWEN_4B_PATH);
  });

  it('falls back to the first loaded model when the alias matches nothing', () => {
    // Operator swapped 9B out for 4B; a stale "qwen3.5-9b" hint must not 404.
    expect(resolveLmStudioModel([QWEN_4B_PATH], 'qwen3.5-9b')).toBe(QWEN_4B_PATH);
  });

  it('returns the first loaded model when nothing was requested', () => {
    expect(resolveLmStudioModel([QWEN_9B_PATH, QWEN_4B_PATH], undefined)).toBe(QWEN_9B_PATH);
  });

  it('returns undefined when no models are loaded', () => {
    expect(resolveLmStudioModel([], 'qwen3.5-9b')).toBeUndefined();
  });
});

describe('LmStudioProvider model discovery', () => {
  it('rewrites the outbound model to the discovered full path (alias match)', async () => {
    const { calls } = stubLmStudio([QWEN_4B_PATH]);
    const p = makeProvider('http://127.0.0.1:1235/v1', 'qwen3.5-9b');
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    expect(res.kind).toBe('OK');
    // Discovery hit GET /models, then the completion used the loaded 4B path.
    expect(calls[0]?.url).toBe('http://127.0.0.1:1235/v1/models');
    expect(calls[0]?.method).toBe('GET');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:1235/v1/chat/completions');
    expect(post?.body).toMatchObject({ model: QWEN_4B_PATH });
  });

  it('keeps a verbatim matching requested model (direct: full path)', async () => {
    const { calls } = stubLmStudio([QWEN_9B_PATH]);
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: QWEN_9B_PATH });
    expect(res.kind).toBe('OK');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ model: QWEN_9B_PATH });
  });

  it('caches discovery: a second attempt within the TTL skips GET /models', async () => {
    const { calls } = stubLmStudio([QWEN_4B_PATH]);
    const p = makeProvider();
    await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    const modelCalls = calls.filter((c) => c.url.endsWith('/models'));
    expect(modelCalls).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('falls back to the requested model when discovery fails (server restarting)', async () => {
    const { calls } = stubLmStudio([], { failDiscovery: true });
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    expect(res.kind).toBe('OK');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ model: 'qwen3.5-9b' });
  });

  it('reports KEY_FAILURE when the server is up but has no models loaded', async () => {
    stubLmStudio([]);
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    expect(res.kind).toBe('KEY_FAILURE');
  });

  it('treats a non-200 /models response as discovery failure (no throw)', async () => {
    const { calls } = stubLmStudio([], { modelsStatus: 500 });
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5-9b' });
    expect(res.kind).toBe('OK');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ model: 'qwen3.5-9b' });
  });
});
