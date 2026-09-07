import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postChatCompletion } from './fetch.js';
import { SingleKeyProvider } from './single-key.js';

vi.mock('./fetch.js', () => ({ postChatCompletion: vi.fn() }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeProvider(apiKey?: string) {
  return new SingleKeyProvider(
    {
      id: 'opencodego',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey,
      defaultModel: 'glm-5.3-flash',
    },
    1000,
    silent,
  );
}

const body = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('OpenCodeGo provider (single-key wiring)', () => {
  beforeEach(() => {
    vi.mocked(postChatCompletion).mockReset();
  });

  it('carries the opencodego id and the /zen/go/v1 wiring', () => {
    const p = makeProvider('sk-test');
    expect(p.id).toBe('opencodego');
    expect(p.resolvedDefaultModel).toBe('glm-5.3-flash');
  });

  it('is available iff an api key is configured', () => {
    expect(new SingleKeyProvider(
      { id: 'opencodego', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test', defaultModel: 'glm-5.3-flash' },
      1000,
      silent,
    ).available).toBe(true);
    expect(new SingleKeyProvider(
      { id: 'opencodego', baseUrl: 'https://opencode.ai/zen/go/v1', defaultModel: 'glm-5.3-flash' },
      1000,
      silent,
    ).available).toBe(false);
  });

  it('propagates the x-opencode-session header via extraHeaders', async () => {
    vi.mocked(postChatCompletion).mockResolvedValue({ kind: 'OK', response: new Response('{}') });
    const p = new SingleKeyProvider(
      {
        id: 'opencodego',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'sk-test',
        defaultModel: 'glm-5.3-flash',
        extraHeaders: { 'x-opencode-session': 'test-session' },
      },
      1000,
      silent,
    );
    await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    const call = vi.mocked(postChatCompletion).mock.calls[0]!;
    const opts = call[1] as { extraHeaders?: Record<string, string> };
    expect(opts.extraHeaders).toEqual({ 'x-opencode-session': 'test-session' });
  });

  it('returns KEY_FAILURE without an api key (never hits the network)', async () => {
    const p = new SingleKeyProvider(
      { id: 'opencodego', baseUrl: 'https://opencode.ai/zen/go/v1', defaultModel: 'glm-5.3-flash' },
      1000,
      silent,
    );
    const res = await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    expect(res).toEqual({
      kind: 'KEY_FAILURE',
      status: 0,
      message: 'opencodego: no api key configured',
    });
    expect(postChatCompletion).not.toHaveBeenCalled();
  });

  it('posts to the /zen/go/v1 endpoint with the bearer key and model', async () => {
    vi.mocked(postChatCompletion).mockResolvedValue({
      kind: 'OK',
      response: new Response('{}'),
    });
    const p = new SingleKeyProvider(
      { id: 'opencodego', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test', defaultModel: 'glm-5.3-flash' },
      1000,
      silent,
    );
    const res = await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    expect(res.kind).toBe('OK');
    expect(postChatCompletion).toHaveBeenCalledTimes(1);
    const call = vi.mocked(postChatCompletion).mock.calls[0]!;
    const outbound = call[0] as { model: string };
    const opts = call[1] as { baseUrl: string; authorization: string; keyTag: string };
    expect(outbound.model).toBe('glm-5.3-flash');
    expect(opts.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(opts.authorization).toBe('Bearer sk-test');
    expect(opts.keyTag).toBe('opencodego');
  });
});
