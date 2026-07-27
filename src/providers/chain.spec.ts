/**
 * Provider chain tests. Providers are stubbed so we verify the chain's
 * decision logic (rotation, fallback, short-circuit, all-fail) without real
 * network calls. Mocks at the seam (the Provider interface), never of our own
 * chain code.
 */

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { NoProviderAvailableError } from '../common/errors.js';

import { ProviderChain } from './chain.js';
import type { Providers } from './instances.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function okResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeProviders(overrides: Partial<Providers> = {}): Providers {
  const mk = (
    id: string,
    results: ProviderCallResult[],
  ): { attempt: ReturnType<typeof vi.fn>; available: boolean; id: string } => ({
    id,
    available: true,
    attempt: vi.fn(async (): Promise<ProviderCallResult> => {
      const r = results.shift();
      if (!r) return { kind: 'KEY_FAILURE', status: 429, message: 'exhausted stub' };
      return r;
    }),
  });
  const or = {
    id: 'openrouter',
    available: true,
    keyCount: 2,
    attempt: vi.fn(async (_b: ChatRequestBody, _s: AbortSignal): Promise<ProviderCallResult> => {
      return { kind: 'KEY_FAILURE', status: 429, message: 'openrouter stub' };
    }),
  };
  return {
    openrouter: or as never,
    openai: mk('openai', []) as never,
    zai: mk('zai', []) as never,
    opencode: mk('opencode-bigpickle', []) as never,
    opencodeNemotron: mk('opencode-nemotron', []) as never,
    opencodeDeepSeekFlash: mk('opencode-deepseek-flash', []) as never,
    opencodeMiMo: mk('opencode-mimo', []) as never,
    opencodeNorthMiniCode: mk('opencode-north-mini-code', []) as never,
    opencodeLaguna: mk('opencode-laguna', []) as never,
    opencodeLing: mk('opencode-ling', []) as never,
    opencodeQwen: mk('opencode-qwen', []) as never,
    opencodeMiniMax: mk('opencode-minimax', []) as never,
    ...overrides,
  };
}

const baseBody: ChatRequestBody = {
  model: 'mst/free',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('ProviderChain - alias walk (mst/free and free)', () => {
  it('walks every OpenRouter key then OpenAI/ZAI/OpenCode until first OK', async () => {
    const openai = {
      id: 'openai',
      available: true,
      attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse('{}'),
      })),
    };
    const p = makeProviders({ openai: openai as never });
    const chain = new ProviderChain(p, silentLogger);

    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );

    expect(res.response.status).toBe(200);
    expect(res.servedBy.provider).toBe('openai');
    // Both OpenRouter keys were tried before falling back.
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(2);
  });

  it('also walks when requested model is free (alias parity with mst/free)', async () => {
    const openai = {
      id: 'openai',
      available: true,
      attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse('{}'),
      })),
    };
    const p = makeProviders({ openai: openai as never });
    const chain = new ProviderChain(p, silentLogger);

    const res = await chain.handle(
      { ...baseBody, model: 'free' },
      new AbortController().signal,
    );

    expect(res.response.status).toBe(200);
    expect(res.servedBy.provider).toBe('openai');
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(2);
  });

  it('returns OK from OpenRouter key 1 without trying fallbacks', async () => {
    const p = makeProviders({
      openrouter: {
        id: 'openrouter',
        available: true,
        keyCount: 2,
        attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
          kind: 'OK',
          response: okResponse('{}'),
        })),
      } as never,
    });
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal);
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(1);
    expect(p.openai.attempt).not.toHaveBeenCalled();
  });

  it('throws NoProviderAvailableError when every provider fails', async () => {
    const chain = new ProviderChain(makeProviders(), silentLogger);
    await expect(
      chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
  });
});

describe('ProviderChain - explicit model short-circuit (direct: namespace)', () => {
  it('direct:openai/ routes only to OpenAI', async () => {
    const openai = {
      id: 'openai',
      available: true,
      attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse('{}'),
      })),
    };
    const p = makeProviders({ openai: openai as never });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'direct:openai/gpt-4o-mini' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(p.openrouter.attempt).not.toHaveBeenCalled();
    expect(openai.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'gpt-4o-mini' }),
    );
  });

  it('direct:glm- routes only to ZAI', async () => {
    const zai = {
      id: 'zai',
      available: true,
      attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse('{}'),
      })),
    };
    const p = makeProviders({ zai: zai as never });
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'direct:glm-4.6' }, new AbortController().signal);
    expect(p.openrouter.attempt).not.toHaveBeenCalled();
    expect(zai.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'glm-4.6' }),
    );
  });

  it('a bare openai/... model id is treated as an OpenRouter model (NOT a provider pin)', async () => {
    // Regression guard: OpenRouter uses vendor/model ids like "openai/gpt-4o".
    // These must go through the default chain (OpenRouter first), not be
    // short-circuited to the OpenAI provider.
    const p = makeProviders({
      openrouter: {
        id: 'openrouter',
        available: true,
        keyCount: 1,
        attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
          kind: 'OK',
          response: okResponse('{}'),
        })),
      } as never,
    });
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'openai/gpt-4o-mini' }, new AbortController().signal);
    expect(p.openrouter.attempt).toHaveBeenCalled();
    expect(p.openai.attempt).not.toHaveBeenCalled();
  });
});

describe('ProviderChain - explicit model chain', () => {
  it('uses the explicit model across providers, OpenRouter pool first', async () => {
    const p = makeProviders({
      openrouter: {
        id: 'openrouter',
        available: true,
        keyCount: 1,
        attempt: vi.fn(async (_b, _s): Promise<ProviderCallResult> => ({
          kind: 'KEY_FAILURE',
          status: 429,
          message: 'rl',
        })),
      } as never,
      openai: {
        id: 'openai',
        available: true,
        attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
          kind: 'OK',
          response: okResponse('{}'),
        })),
      } as never,
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'some-explicit-model' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(1);
    // OpenRouter was called with the explicit model (plus :free via FORCE_FREE).
    expect(p.openrouter.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'some-explicit-model:free' }),
    );
  });
});
