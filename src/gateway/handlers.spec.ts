/**
 * Gateway routing + model-resolution tests. Verifies the gateway serves the
 * OpenAI-standard /v1 path (drop-in for openai SDK / OpenClaw) AND that an
 * unknown model id defaults to the mst/free alias walk.
 */

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { Router } from '../common/http.js';
import { loadEnv } from '../config/env.js';
import type { ProviderCallResult } from '../providers/types.js';

import { buildModelList, registerHandlers, resolveModel } from './handlers.js';

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function okResult(): ProviderCallResult {
  return {
    kind: 'OK',
    response: new Response('{"choices":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
}

function fakeChain(): { handle: ReturnType<typeof vi.fn> } {
  return { handle: vi.fn(async () => okResult()) };
}

describe('gateway route registration', () => {
  it('serves BOTH /v1/chat/completions and /api/v1/chat/completions (OpenAI drop-in)', () => {
    const router = new Router();
    const chain = fakeChain() as never;
    registerHandlers(router, { chain, log: silentLogger });
    expect(router.resolve('POST', '/v1/chat/completions')).not.toBeNull();
    expect(router.resolve('POST', '/api/v1/chat/completions')).not.toBeNull();
  });

  it('serves BOTH /v1/models and /api/v1/models', () => {
    const router = new Router();
    registerHandlers(router, { chain: fakeChain() as never, log: silentLogger });
    expect(router.resolve('GET', '/v1/models')).not.toBeNull();
    expect(router.resolve('GET', '/api/v1/models')).not.toBeNull();
  });
});

describe('resolveModel - unknown model defaults to the alias walk', () => {
  it('passes the walk alias through unchanged', () => {
    expect(resolveModel('mst/free')).toBe('mst/free');
  });

  it('passes a direct: prefix through unchanged', () => {
    expect(resolveModel('direct:openai/gpt-4o')).toBe('direct:openai/gpt-4o');
  });

  it('passes a configured per-provider default through unchanged', () => {
    // OPENROUTER_MODEL default is openrouter/free (from env.ts).
    expect(resolveModel('openrouter/free')).toBe('openrouter/free');
  });

  it('rewrites an UNKNOWN model to the alias (mst/free)', () => {
    // A client sending a placeholder/generic id should not fail; it routes
    // through the full pool + fallback.
    expect(resolveModel('some-unknown-model')).toBe('mst/free');
    expect(resolveModel('gpt-4')).toBe('mst/free');
    expect(resolveModel('')).toBe('mst/free');
  });

  it('passes the tokenrouter default model through when its key is configured', () => {
    loadEnv({ TOKENROUTER_API_KEY: 'sk-tokenrouter-test', TOKENROUTER_MODEL: 'z-ai/glm-5.3-free' });
    expect(resolveModel('z-ai/glm-5.3-free')).toBe('z-ai/glm-5.3-free');
  });
});

describe('buildModelList - tokenrouter model advertisement', () => {
  it('includes z-ai/glm-5.3-free with owned_by=tokenrouter when TOKENROUTER_API_KEY is set', () => {
    loadEnv({ TOKENROUTER_API_KEY: 'sk-tokenrouter-test', TOKENROUTER_MODEL: 'z-ai/glm-5.3-free' });
    const tr = buildModelList().find((m) => m.id === 'z-ai/glm-5.3-free');
    expect(tr).toBeDefined();
    expect(tr?.owned_by).toBe('tokenrouter');
  });

  it('omits the tokenrouter model when TOKENROUTER_API_KEY is unset', () => {
    loadEnv({ TOKENROUTER_API_KEY: undefined, TOKENROUTER_MODEL: 'z-ai/glm-5.3-free' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('z-ai/glm-5.3-free');
  });
});

describe('buildModelList - local (llama-server) model advertisement', () => {
  it('includes the local model with owned_by=local when LOCAL_ENABLED=true', () => {
    loadEnv({ LOCAL_ENABLED: 'true', LOCAL_MODEL: 'qwen3:14b-32k' });
    const local = buildModelList().find((m) => m.id === 'qwen3:14b-32k');
    expect(local).toBeDefined();
    expect(local?.owned_by).toBe('local');
  });

  it('omits the local model when LOCAL_ENABLED is false', () => {
    loadEnv({});
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('qwen3:14b-32k');
  });
});

describe('laptop (tailnet qwen) gateway wiring', () => {
  it('resolveModel passes qwen3.5:2b through as a known model', () => {
    loadEnv({ LAPTOP_MODEL: 'qwen3.5:2b' });
    expect(resolveModel('qwen3.5:2b')).toBe('qwen3.5:2b');
  });

  it('buildModelList advertises qwen3.5:2b when LAPTOP_ENABLED=true', () => {
    loadEnv({ LAPTOP_ENABLED: 'true', LAPTOP_MODEL: 'qwen3.5:2b' });
    const laptop = buildModelList().find((m) => m.id === 'qwen3.5:2b');
    expect(laptop).toBeDefined();
    expect(laptop?.owned_by).toBe('laptop');
  });

  it('buildModelList omits the laptop model when LAPTOP_ENABLED is false (default)', () => {
    loadEnv({ LAPTOP_ENABLED: 'false', LAPTOP_MODEL: 'qwen3.5:2b' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('qwen3.5:2b');
  });
});
