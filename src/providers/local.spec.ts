/**
 * Local (Ollama) provider tests.
 *
 * Ollama's OpenAI-compatible /v1 endpoint IGNORES the `think` field (verified
 * on ollama 0.32.5), so qwen3's think mode burns tokens and ~80s before any
 * content. LocalProvider speaks ollama's NATIVE /api/chat instead, forcing
 * think:false, and maps the response back to the OpenAI shape the gateway
 * expects (choices/message/tool_calls/finish_reason).
 */
import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalProvider } from './local.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeProvider(baseUrl = 'http://127.0.0.1:11434') {
  return new LocalProvider({ baseUrl, defaultModel: 'qwen3:14b-32k' }, 5000, silent);
}

function stubFetchOnce(responseBody: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const baseBody = {
  model: 'ignored',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('LocalProvider (ollama /api/chat)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is available without an api key', () => {
    expect(makeProvider().available).toBe(true);
  });

  it('posts to {base}/api/chat with think:false, keep_alive and the resolved model', async () => {
    const fetchMock = stubFetchOnce({ message: { role: 'assistant', content: 'OK' }, done_reason: 'stop' });
    const p = makeProvider();
    const res = await p.attempt(
      { ...baseBody, max_tokens: 512, temperature: 0.3 },
      new AbortController().signal,
      { model: 'qwen3:14b-32k' },
    );
    expect(res.kind).toBe('OK');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('qwen3:14b-32k');
    expect(body.think).toBe(false);
    // Go duration (ollama rejects "-1"); 30m keeps the model hot between ticks.
    expect(body.keep_alive).toBe('30m');
    expect((body.options as Record<string, unknown>).num_predict).toBe(512);
    expect((body.options as Record<string, unknown>).temperature).toBe(0.3);
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('maps an ollama tool_calls response to the OpenAI shape', async () => {
    const fetchMock = stubFetchOnce({
      model: 'qwen3:14b-32k',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_x', function: { index: 0, name: 'read', arguments: { path: '/tmp/foo.txt' } } },
        ],
      },
      done_reason: 'stop',
    });
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3:14b-32k' });
    expect(res.kind).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const json = (await (res as { response: Response }).response.json()) as {
      choices: Array<{ finish_reason: string; message: { content: string; tool_calls: unknown[] } }>;
    };
    const choice = json.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('');
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'call_x',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"/tmp/foo.txt"}' },
      },
    ]);
  });

  it('maps done_reason=length to finish_reason=length and flags it as an empty completion', async () => {
    stubFetchOnce({ message: { role: 'assistant', content: '' }, done_reason: 'length' });
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3:14b-32k' });
    expect(res.kind).toBe('TRANSIENT');
  });

  it('returns BAD_REQUEST when the client asks for streaming (not supported)', async () => {
    const p = makeProvider();
    const res = await p.attempt(
      { ...baseBody, stream: true },
      new AbortController().signal,
      { model: 'qwen3:14b-32k' },
    );
    expect(res.kind).toBe('BAD_REQUEST');
  });

  it('fast-fails oversized prompts (local 32k context cannot serve them in time)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const big = 'x'.repeat(80_000); // ~20k tokens by the chars/4 heuristic
    const res = await makeProvider().attempt(
      { ...baseBody, messages: [{ role: 'user', content: big }] },
      new AbortController().signal,
      { model: 'qwen3:14b-32k' },
    );
    expect(res.kind).toBe('BAD_REQUEST');
    // No fetch: the guard returns before any network call, so a huge prompt
    // cannot clog ollama's single-model queue.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns TRANSIENT on network failure (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const res = await makeProvider().attempt(baseBody, new AbortController().signal, {
      model: 'qwen3:14b-32k',
    });
    expect(res.kind).toBe('TRANSIENT');
  });

  it('classifies an upstream 500 as TRANSIENT with the error body scrubbed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom sk-or-v1-abc123456"}', { status: 500 })));
    const res = await makeProvider().attempt(baseBody, new AbortController().signal, {
      model: 'qwen3:14b-32k',
    });
    expect(res.kind).toBe('TRANSIENT');
    expect((res as { message: string }).message).not.toContain('abc123456');
  });
});
