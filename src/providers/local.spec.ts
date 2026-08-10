/**
 * Local provider tests.
 *
 * The local model is served by a direct llama-server process exposing its
 * OpenAI-compatible /v1/chat/completions endpoint (NOT the ollama daemon,
 * which is not running and whose /api/chat llama-server does not implement).
 * LocalProvider delegates to the shared postChatCompletion helper, so these
 * tests assert the OpenAI-shaped contract: verbatim body passthrough with the
 * model rewritten to the chain-resolved id, endpoint {base}/chat/completions,
 * no think/keep_alive/options fields, and the shared helper's streaming,
 * empty-completion, and error handling.
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

// baseUrl mirrors env.ts default: the OpenAI-compat version path is part of
// the base, and postChatCompletion appends the bare 'chat/completions' suffix.
function makeProvider(baseUrl = 'http://127.0.0.1:11434/v1') {
  return new LocalProvider({ baseUrl, defaultModel: 'qwen3.5:2b' }, 5000, silent);
}

function stubFetchOnce(responseBody: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Build an SSE streaming Response body carrying one content delta + a [DONE]. */
function streamingResponse(content = 'Hello'): Response {
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const baseBody = {
  model: 'ignored',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('LocalProvider (llama-server /v1/chat/completions)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is available without an api key', () => {
    expect(makeProvider().available).toBe(true);
  });

  it('posts to {base}/chat/completions with the resolved model and OpenAI body shape', async () => {
    const fetchMock = stubFetchOnce({
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    });
    const p = makeProvider();
    const res = await p.attempt(
      { ...baseBody, max_tokens: 512, temperature: 0.3 },
      new AbortController().signal,
      { model: 'qwen3.5:2b' },
    );
    expect(res.kind).toBe('OK');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // model is rewritten to the chain-resolved id; everything else passes through.
    expect(body.model).toBe('qwen3.5:2b');
    // No ollama-native fields: the body is plain OpenAI shape.
    expect(body).not.toHaveProperty('think');
    expect(body).not.toHaveProperty('keep_alive');
    expect(body).not.toHaveProperty('options');
    // max_tokens passes through verbatim (NOT remapped to options.num_predict).
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.3);
    // llama-server ignores Authorization, but the shared helper sends the
    // placeholder; no real key is ever attached.
    expect(init.headers).toHaveProperty('authorization', 'Bearer local');
  });

  it('passes an OpenAI tool_calls response through unchanged (no shape remapping)', async () => {
    const upstream = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_x', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/foo.txt"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const fetchMock = stubFetchOnce(upstream);
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5:2b' });
    expect(res.kind).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const json = (await (res as { response: Response }).response.json()) as typeof upstream;
    // Verbatim passthrough: the response is not remapped by the provider.
    expect(json).toEqual(upstream);
    expect(json.choices[0]!.finish_reason).toBe('tool_calls');
    expect(json.choices[0]!.message.tool_calls).toEqual(upstream.choices[0]!.message.tool_calls);
  });

  it('flags an empty finish_reason=length completion as EMPTY (no deliverable, not a failure)', async () => {
    stubFetchOnce({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
    });
    const p = makeProvider();
    const res = await p.attempt(baseBody, new AbortController().signal, { model: 'qwen3.5:2b' });
    expect(res.kind).toBe('EMPTY');
  });

  it('supports streaming requests', async () => {
    const fetchMock = vi.fn(async () => streamingResponse('Hi there'));
    vi.stubGlobal('fetch', fetchMock);
    const p = makeProvider();
    const res = await p.attempt(
      { ...baseBody, stream: true },
      new AbortController().signal,
      { model: 'qwen3.5:2b' },
    );
    expect(res.kind).toBe('OK');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it('fast-fails oversized prompts (would clog the single llama-server slot)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // ~150k tokens by the chars/4 heuristic: well past the 50000 guard.
    const big = 'x'.repeat(600_000);
    const res = await makeProvider().attempt(
      { ...baseBody, messages: [{ role: 'user', content: big }] },
      new AbortController().signal,
      { model: 'qwen3.5:2b' },
    );
    expect(res.kind).toBe('BAD_REQUEST');
    // No fetch: the guard returns before any network call, so a huge prompt
    // cannot block the single llama-server slot for the whole timeout.
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
      model: 'qwen3.5:2b',
    });
    expect(res.kind).toBe('TRANSIENT');
  });

  it('classifies an upstream 500 as TRANSIENT with the error body scrubbed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom sk-or-v1-abc123456"}', { status: 500 })));
    const res = await makeProvider().attempt(baseBody, new AbortController().signal, {
      model: 'qwen3.5:2b',
    });
    expect(res.kind).toBe('TRANSIENT');
    expect((res as { message: string }).message).not.toContain('abc123456');
  });
});
