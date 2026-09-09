/**
 * Tests for SingleKeyProvider: base wiring contract and the thinking
 * pass-through policy (the gateway never auto-disables thinking - it is a
 * client decision). fetch is the live-network seam and is mocked (same
 * pattern as opencodego.spec).
 */
import type pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';

import { postChatCompletion } from './fetch.js';
import { buildProviders } from './instances.js';
import { SingleKeyProvider } from './single-key.js';

vi.mock('./fetch.js', () => ({ postChatCompletion: vi.fn() }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const body = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('SingleKeyProvider base wiring', () => {
  beforeEach(() => {
    vi.mocked(postChatCompletion).mockReset();
    vi.mocked(postChatCompletion).mockResolvedValue({
      kind: 'OK',
      response: new Response('{}', { status: 200 }),
    });
  });

  it('carries id, baseUrl, key and default model into the upstream call', async () => {
    const p = new SingleKeyProvider(
      {
        id: 'zai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        apiKey: 'key-id.secret',
        defaultModel: 'glm-5.3-flash',
      },
      1000,
      silent,
    );
    await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    expect(postChatCompletion).toHaveBeenCalledTimes(1);
    const [outbound, opts] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound.model).toBe('glm-5.3-flash');
    expect(opts.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(opts.authorization).toBe('Bearer key-id.secret');
  });

  it('reports KEY_FAILURE when no api key is configured', async () => {
    const p = new SingleKeyProvider(
      {
        id: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        defaultModel: 'glm-5.3-flash',
      },
      1000,
      silent,
    );
    const res = await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    expect(res).toMatchObject({ kind: 'KEY_FAILURE', status: 0 });
  });
});

describe('thinking is a client decision (gateway stays neutral)', () => {
  beforeEach(() => {
    vi.mocked(postChatCompletion).mockReset();
    vi.mocked(postChatCompletion).mockResolvedValue({
      kind: 'OK',
      response: new Response('{}', { status: 200 }),
    });
  });

  afterEach(() => loadEnv({}));

  it('buildProviders zai does NOT inject thinking when the client did not send it', async () => {
    // 2026-09-09 user directive: no auto-disable. Thinking stays on (Z.ai
    // default) unless the CLIENT asks otherwise via the standard body field.
    // WHOLESALE equality: any future injection (telemetry, temperature, a
    // retry hint) must fail here, not just a thinking-field check.
    loadEnv({ ZAI_API_KEY: 'key-id.secret', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    await providers.zai.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound).toEqual({ ...body, model: 'glm-5.3-flash' });
  });

  it('client-sent thinking is forwarded verbatim to zai', async () => {
    loadEnv({ ZAI_API_KEY: 'key-id.secret', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    const withThinking = { ...body, thinking: { type: 'enabled' } };
    await providers.zai.attempt(withThinking, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound).toEqual({ ...withThinking, model: 'glm-5.3-flash' });
  });

  it('client-sent thinking:disabled is forwarded too (client may opt out)', async () => {
    loadEnv({ ZAI_API_KEY: 'key-id.secret', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    const withThinking = { ...body, thinking: { type: 'disabled' } };
    await providers.zai.attempt(withThinking, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound.thinking).toEqual({ type: 'disabled' });
  });

  it('the chain-resolved model overrides the client-sent model', async () => {
    // NICE-1: opts.model (resolved by the chain) wins over body.model.
    loadEnv({ ZAI_API_KEY: 'key-id.secret', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    const clientBody = { ...body, model: 'some-other-model' };
    await providers.zai.attempt(clientBody, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound.model).toBe('glm-5.3-flash');
  });
});
