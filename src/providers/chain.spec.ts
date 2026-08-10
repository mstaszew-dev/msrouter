/**
 * Provider chain adaptive-rotation tests. Verifies that:
 *   - the flat routing-entry queue is built in env-declared order,
 *   - a routing entry returning KEY_FAILURE is demoted to the back,
 *   - demoted entries are tried last on the NEXT handle() call,
 *   - successful calls leave the queue unchanged,
 *   - all routing entries are tried before NoProviderAvailableError,
 *   - direct: still pins a single provider with no fallback.
 *
 * Providers are stubbed at the Provider interface seam (never our own chain code).
 */

import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoProviderAvailableError } from '../common/errors.js';
import { loadEnv } from '../config/env.js';

import { ProviderChain } from './chain.js';
import type { Providers } from './instances.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function okResponse(text = '{}'): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Build a stub Providers with a scripted OpenRouter (keyCount keys) and
 * OpenAI/ZAI/OpenCode stubs. Each provider's `attempt` is a vi.fn the test can
 * re-program. OpenCode is unavailable by default (0 keys) to keep the
 * OpenRouter/OpenAI/ZAI-focused tests simple; opt in via opencodeKeys>0.
 */
function makeProviders(
  overrides: {
    openrouterKeys?: number;
    openrouterResults?: ProviderCallResult[];
    openaiResults?: ProviderCallResult[];
    opencodeModels?: string[];
    opencodeKeys?: number;
    localResults?: ProviderCallResult[];
  } = {},
): Providers {
  const orKeys = overrides.openrouterKeys ?? 2;
  const orResults = overrides.openrouterResults ?? [];
  const orAttempt = vi.fn(
    async (
      _b: ChatRequestBody,
      _s: AbortSignal,
      opts: { keyIndex?: number },
    ): Promise<ProviderCallResult> => {
      const i = opts.keyIndex ?? 0;
      return orResults[i] ?? { kind: 'KEY_FAILURE', status: 429, message: 'openrouter stub' };
    },
  );

  const openaiResults = overrides.openaiResults ?? [];
  const openaiAttempt = vi.fn(async (): Promise<ProviderCallResult> => {
    return openaiResults.shift() ?? { kind: 'KEY_FAILURE', status: 429, message: 'openai stub' };
  });

  const zaiAttempt = vi.fn(async (): Promise<ProviderCallResult> => ({
    kind: 'KEY_FAILURE',
    status: 429,
    message: 'zai stub',
  }));

  const ocModels = overrides.opencodeModels ?? ['big-pickle', 'nemotron-3-ultra-free'];
  const ocKeys = overrides.opencodeKeys ?? 0; // unavailable by default
  const ocTriples = ocKeys * ocModels.length;
  const ocAttempt = vi.fn(async (): Promise<ProviderCallResult> => ({
    kind: 'KEY_FAILURE',
    status: 429,
    message: 'opencode stub',
  }));

  const localResults = overrides.localResults ?? [];
  const localAttempt = vi.fn(async (): Promise<ProviderCallResult> => {
    return localResults.shift() ?? { kind: 'TRANSIENT', status: 0, message: 'local stub' };
  });

  const lmstudioAttempt = vi.fn(async (): Promise<ProviderCallResult> => ({
    kind: 'KEY_FAILURE',
    status: 0,
    message: 'lmstudio stub',
  }));

  return {
    openrouter: {
      id: 'openrouter',
      available: orKeys > 0,
      keyCount: orKeys,
      attempt: orAttempt,
    } as never,
    openai: { id: 'openai', available: true, attempt: openaiAttempt } as never,
    zai: { id: 'zai', available: true, attempt: zaiAttempt } as never,
    opencode: {
      id: 'opencode',
      available: ocKeys > 0,
      keyCount: ocKeys,
      tripleCount: ocTriples,
      attempt: ocAttempt,
      queueSnapshot: () =>
        Array.from({ length: ocTriples }, (_, i) => ({
          model: ocModels[i % ocModels.length]!,
          keyIdx: Math.floor(i / ocModels.length),
        })),
    } as never,
    local: { id: 'local', available: true, attempt: localAttempt } as never,
    lmstudio: { id: 'lmstudio', available: true, attempt: lmstudioAttempt } as never,
  };
}

const baseBody: ChatRequestBody = {
  model: 'mst/free',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('ProviderChain - routing-entry queue construction', () => {
  it('builds the flat queue in env-declared order (OpenRouter, OpenAI, ZAI, OpenCode)', () => {
    const p = makeProviders({
      openrouterKeys: 2,
      opencodeKeys: 1,
      opencodeModels: ['big-pickle', 'nemotron'],
    });
    const chain = new ProviderChain(p, silentLogger);
    const labels = chain.queueSnapshot().map((c) => c.label);
    expect(labels).toEqual([
      'openrouter[key1/openrouter/free]',
      'openrouter[key2/openrouter/free]',
      'openai',
      'zai',
      'opencode[key1/big-pickle]',
      'opencode[key1/nemotron]',
    ]);
  });
});

describe('ProviderChain - alias walk (mst/free and free)', () => {
  it('walks every OpenRouter key then OpenAI/ZAI/OpenCode until first OK', async () => {
    // OpenRouter fails on both keys; OpenAI succeeds.
    const p = makeProviders({
      openrouterKeys: 2,
      openrouterResults: [
        { kind: 'KEY_FAILURE', status: 429, message: 'rl1' },
        { kind: 'KEY_FAILURE', status: 429, message: 'rl2' },
      ],
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(res.servedBy.provider).toBe('openai');
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(2);
  });

  it('skips an EMPTY provider to the next entry without retrying or demoting', async () => {
    // OpenRouter returns an empty completion (no content, no tool calls).
    // The chain must skip to OpenAI, NOT retry the same prompt in place
    // (TRANSIENT semantics) and NOT demote openrouter (EMPTY is not a failure).
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'EMPTY', status: 200, message: 'no content' }],
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );
    expect(res.servedBy.provider).toBe('openai');
    // Exactly one attempt on openrouter: EMPTY is not retried.
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(1);
    // openrouter stays in the queue (not demoted to the back).
    const labels = chain.queueSnapshot().map((c) => c.label);
    expect(labels[0]).toBe('openrouter[key1/openrouter/free]');
  });

  it('returns OK from OpenRouter key 1 without trying fallbacks', async () => {
    const p = makeProviders({
      openrouterKeys: 2,
      openrouterResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal);
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(1);
    expect(p.openai.attempt).not.toHaveBeenCalled();
  });

  it('also walks when requested model is free (alias parity)', async () => {
    const p = makeProviders({
      openrouterKeys: 2,
      openrouterResults: [
        { kind: 'KEY_FAILURE', status: 429, message: 'rl' },
        { kind: 'KEY_FAILURE', status: 429, message: 'rl' },
      ],
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle({ ...baseBody, model: 'free' }, new AbortController().signal);
    expect(res.servedBy.provider).toBe('openai');
    expect(p.openrouter.attempt).toHaveBeenCalledTimes(2);
  });

  it('throws NoProviderAvailableError when every routing entry fails', async () => {
    const p = makeProviders({ openrouterKeys: 2 });
    const chain = new ProviderChain(p, silentLogger);
    await expect(
      chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
  });
});

describe('ProviderChain - adaptive demotion', () => {
  it('a KEY_FAILURE entry is demoted to the back (visible on the next snapshot)', async () => {
    // openrouter[key1/openrouter/free] fails on first call; openai succeeds. After the call,
    // openrouter[key1/openrouter/free] must be at the back of the queue.
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'KEY_FAILURE', status: 429, message: 'rl' }],
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const before = chain.queueSnapshot().map((c) => c.label);
    expect(before[0]).toBe('openrouter[key1/openrouter/free]');

    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );
    expect(res.servedBy.provider).toBe('openai');

    const after = chain.queueSnapshot().map((c) => c.label);
    expect(after[after.length - 1]).toBe('openrouter[key1/openrouter/free]');
    expect(after[0]).toBe('openai');
  });

  it('a successful call leaves the queue order unchanged', async () => {
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const before = chain.queueSnapshot().map((c) => c.label);
    await chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal);
    const after = chain.queueSnapshot().map((c) => c.label);
    expect(after).toEqual(before);
  });

  it('repeated all-fail calls leave the queue order stable (idempotent demote)', async () => {
    const p = makeProviders({ openrouterKeys: 1 });
    const chain = new ProviderChain(p, silentLogger);
    await chain
      .handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal)
      .catch(() => null);
    const orderAfter1 = chain.queueSnapshot().map((c) => c.label);
    await chain
      .handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal)
      .catch(() => null);
    const orderAfter2 = chain.queueSnapshot().map((c) => c.label);
    expect(orderAfter1).toEqual(orderAfter2);
  });
});

describe('ProviderChain - direct: short-circuit', () => {
  it('direct:openai/ routes only to OpenAI with no fallback', async () => {
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'OK', response: okResponse() }], // would succeed, but must not be called
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'direct:openai/gpt-4o-mini' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(p.openrouter.attempt).not.toHaveBeenCalled();
    expect(p.openai.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'gpt-4o-mini' }),
    );
  });

  it('direct:glm- routes only to ZAI', async () => {
    const zaiOk = {
      id: 'zai',
      available: true,
      attempt: vi.fn(async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse(),
      })),
    };
    const p = makeProviders();
    (p as { zai: unknown }).zai = zaiOk;
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'direct:glm-4.6' }, new AbortController().signal);
    expect(p.openrouter.attempt).not.toHaveBeenCalled();
    expect(zaiOk.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'glm-4.6' }),
    );
  });

  it('a bare openai/... model id is NOT short-circuited (goes through the chain, OpenRouter first)', async () => {
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    await chain.handle({ ...baseBody, model: 'openai/gpt-4o-mini' }, new AbortController().signal);
    expect(p.openrouter.attempt).toHaveBeenCalled();
    expect(p.openai.attempt).not.toHaveBeenCalled();
  });

  it('direct:opencode/ routes only to OpenCode with no fallback', async () => {
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'OK', response: okResponse() }], // would succeed, but must not be called
      opencodeKeys: 1,
      opencodeModels: ['big-pickle'],
    });
    // Reprogram opencode to succeed
    (p.opencode as unknown as { attempt: ReturnType<typeof vi.fn> }).attempt = vi.fn(
      async (): Promise<ProviderCallResult> => ({
        kind: 'OK',
        response: okResponse(),
      }),
    );
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'direct:opencode/big-pickle' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(p.openrouter.attempt).not.toHaveBeenCalled();
    expect(p.opencode.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'big-pickle' }),
    );
  });
});

describe('ProviderChain - explicit model chain', () => {
  it('uses the explicit model across all entries, OpenRouter pool first', async () => {
    const p = makeProviders({
      openrouterKeys: 1,
      openrouterResults: [{ kind: 'KEY_FAILURE', status: 429, message: 'rl' }],
      openaiResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'some-explicit-model' },
      new AbortController().signal,
    );
    expect(res.response.status).toBe(200);
    expect(p.openrouter.attempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'some-explicit-model:free' }),
    );
  });

  it('openrouter servedBy includes key index in model field', async () => {
    const p = makeProviders({
      openrouterKeys: 2,
      openrouterResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );
    expect(res.servedBy.provider).toBe('openrouter[key1/openrouter/free]');
    expect(res.servedBy.model).toMatch(/^openrouter\/free\[key\d+\]$/);
  });
});

describe('ProviderChain - OpenCode pooling', () => {
  it('all OpenCode triples are tried before NoProviderAvailableError', async () => {
    const p = makeProviders({
      openrouterKeys: 0, // disable OR to isolate OpenCode
      opencodeKeys: 2,
      opencodeModels: ['big-pickle', 'nemotron'],
    });
    // openai/zai also fail (default stubs). OpenCode has 4 triples (2 models x 2 keys).
    const chain = new ProviderChain(p, silentLogger);
    await expect(
      chain.handle({ ...baseBody, model: 'mst/free' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(p.opencode.attempt).toHaveBeenCalledTimes(4);
  });

  it('demoting one OpenCode triple does not demote others (per-triple demotion)', async () => {
    // Isolate OpenCode: OpenRouter/OpenAI/ZAI all unavailable, so only the two
    // OpenCode triples are in the queue. triple1 (big-pickle) fails, triple2
    // (nemotron) succeeds. Only triple1 should be demoted.
    const ocModels = ['big-pickle', 'nemotron'];
    const p = makeProviders({
      openrouterKeys: 0,
      opencodeKeys: 1,
      opencodeModels: ocModels,
    });
    // Make OpenAI and ZAI unavailable so the queue is just the two triples.
    (p.openai as unknown as { available: boolean }).available = false;
    (p.zai as unknown as { available: boolean }).available = false;
    // Reprogram opencode.attempt: triple0 (big-pickle) fails, triple1 (nemotron) OK.
    (p.opencode as unknown as { attempt: ReturnType<typeof vi.fn> }).attempt = vi.fn(
      async (
        _b: ChatRequestBody,
        _s: AbortSignal,
        opts: { tripleIndex?: number },
      ): Promise<ProviderCallResult> => {
        const t = opts.tripleIndex ?? 0;
        if (t === 0) return { kind: 'KEY_FAILURE', status: 429, message: 'bigpickle rl' };
        return { kind: 'OK', response: okResponse() };
      },
    );

    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'mst/free' },
      new AbortController().signal,
    );
    expect(res.servedBy.provider).toBe('opencode[key1/nemotron]');

    // After the call, only triple1 (big-pickle, the failing one) was demoted.
    // Build order: [opencode[key1/big-pickle], opencode[key1/nemotron]]. triple1 demoted ->
    // [opencode[key1/nemotron], opencode[key1/big-pickle]].
    const entries = chain.queueSnapshot().map((c) => ({ label: c.label, model: c.model }));
    expect(entries).toEqual([
      { label: 'opencode[key1/nemotron]', model: 'nemotron' },
      { label: 'opencode[key1/big-pickle]', model: 'big-pickle' },
    ]);
  });
});

describe('ProviderChain - local (llama-server) entry', () => {
  // Mirrors the test/setup.ts fixture so loadEnv() restores the known env.
  const DEFAULT_ENV = {
    NODE_ENV: 'test',
    PORT: '8788',
    OPENROUTER_KEY1: 'sk-or-test-key-1111',
    OPENROUTER_KEY2: 'sk-or-test-key-2222',
    OPENAI_API_KEY: 'sk-openai-test',
    ZAI_API_KEY: 'sk-zai-test',
    OPENCODE_KEY1: 'sk-opencode-test-1',
    OPENCODE_KEY2: 'sk-opencode-test-2',
    FORCE_FREE: 'true',
    SCHEDULE_INTERVAL_MINUTES: '-1',
    UPSTREAM_TIMEOUT_MS: '5000',
    LOCAL_ENABLED: 'false',
    LOCAL_MODEL: 'qwen3:14b-32k',
    LOCAL_BASE_URL: 'http://127.0.0.1:11434',
    LMSTUDIO_ENABLED: 'false',
    LMSTUDIO_MODEL: 'google/gemma-4-e2b',
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
  };

  afterEach(() => loadEnv(DEFAULT_ENV));

  it('places the local entry LAST when LOCAL_ENABLED=true', () => {
    loadEnv({ ...DEFAULT_ENV, LOCAL_ENABLED: 'true' });
    const p = makeProviders({ openrouterKeys: 1 });
    const chain = new ProviderChain(p, silentLogger);
    const snapshot = chain.queueSnapshot();
    const last = snapshot[snapshot.length - 1]!;
    expect(last.provider).toBe('local');
    expect(last.model).toBe('qwen3:14b-32k');
  });

  it('omits the local entry when LOCAL_ENABLED is false (default)', () => {
    const p = makeProviders({ openrouterKeys: 1 });
    const chain = new ProviderChain(p, silentLogger);
    expect(chain.queueSnapshot().some((e) => e.provider === 'local')).toBe(false);
  });

  it('direct:local/<model> pins the local provider without fallback', async () => {
    loadEnv({ ...DEFAULT_ENV, LOCAL_ENABLED: 'true' });
    const p = makeProviders({
      openrouterKeys: 1,
      localResults: [{ kind: 'OK', response: okResponse() }],
    });
    const chain = new ProviderChain(p, silentLogger);
    const res = await chain.handle(
      { ...baseBody, model: 'direct:local/qwen3:14b-32k' },
      new AbortController().signal,
    );
    expect(res.servedBy.provider).toBe('local');
    const localAttempt = p.local as unknown as { attempt: ReturnType<typeof vi.fn> };
    expect(localAttempt.attempt).toHaveBeenCalledTimes(1);
    const opts = localAttempt.attempt.mock.calls[0]![2] as { model: string };
    expect(opts.model).toBe('qwen3:14b-32k');
  });

  it('places BOTH local providers (llama-server, LM Studio) at the END of the queue', () => {
    loadEnv({ ...DEFAULT_ENV, LOCAL_ENABLED: 'true', LMSTUDIO_ENABLED: 'true' });
    const p = makeProviders({ openrouterKeys: 1 });
    const chain = new ProviderChain(p, silentLogger);
    const labels = chain.queueSnapshot().map((e) => e.label);
    expect(labels[labels.length - 2]).toBe('local');
    expect(labels[labels.length - 1]).toBe('lmstudio');
  });

  it('omits the lmstudio entry when LMSTUDIO_ENABLED is false (default)', () => {
    const p = makeProviders({ openrouterKeys: 1 });
    const chain = new ProviderChain(p, silentLogger);
    expect(chain.queueSnapshot().some((e) => e.provider === 'lmstudio')).toBe(false);
  });
});
