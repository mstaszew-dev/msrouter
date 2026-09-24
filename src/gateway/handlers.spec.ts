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

  it('passes the opencodego default model through when its key is configured', () => {
    loadEnv({ OPENCODEGO_API_KEY: 'sk-opencodego-test', OPENCODEGO_MODEL: 'glm-5.3-flash' });
    expect(resolveModel('glm-5.3-flash')).toBe('glm-5.3-flash');
  });

  it('passes the opencodego default model through even without a key (config-declared default)', () => {
    // resolveModel's known set is key-independent for provider defaults.
    loadEnv({ OPENCODEGO_MODEL: 'glm-5.3-flash' });
    expect(resolveModel('glm-5.3-flash')).toBe('glm-5.3-flash');
  });

  it('passes a configured opencode pool model (big-pickle) through verbatim', () => {
    loadEnv({ OPENCODE_KEY1: 'sk-opencode-test-1', OPENCODE_MODEL: 'big-pickle' });
    expect(resolveModel('big-pickle')).toBe('big-pickle');
  });

  it('passes a configured opencode NEMOTRON pool model through verbatim', () => {
    // nemotron-3-ultra-free is advertised in /v1/models (owned_by
    // opencode-nemotron); an explicit request must stay pinned to the pool
    // triple instead of being rewritten to the mst/free alias walk.
    loadEnv({
      OPENCODE_KEY1: 'sk-opencode-test-1',
      OPENCODE_NEMOTRON_MODEL: 'nemotron-3-ultra-free',
    });
    expect(resolveModel('nemotron-3-ultra-free')).toBe('nemotron-3-ultra-free');
  });

  it('still rewrites an emptied (retired) opencode slot to the alias walk', () => {
    loadEnv({ OPENCODE_NEMOTRON_MODEL: '' });
    expect(resolveModel('nemotron-3-ultra-free')).toBe('mst/free');
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

describe('buildModelList - opencodego model advertisement', () => {
  it('includes glm-5.3-flash with owned_by=opencodego when OPENCODEGO_API_KEY is set', () => {
    loadEnv({ OPENCODEGO_API_KEY: 'sk-opencodego-test', OPENCODEGO_MODEL: 'glm-5.3-flash' });
    const tr = buildModelList().find((m) => m.id === 'glm-5.3-flash' && m.owned_by === 'opencodego');
    expect(tr).toBeDefined();
  });

  it('omits the opencodego model when OPENCODEGO_API_KEY is unset', () => {
    loadEnv({ OPENCODEGO_MODEL: 'glm-5.3-flash' });
    const ids = buildModelList().filter((m) => m.owned_by === 'opencodego').map((m) => m.id);
    expect(ids).toEqual([]);
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

describe('laptop (local qwen35-gw gateway) wiring', () => {
  it('resolveModel passes qwen3.5-0.8b through as a known model', () => {
    loadEnv({ LAPTOP_MODEL: 'qwen3.5-0.8b' });
    expect(resolveModel('qwen3.5-0.8b')).toBe('qwen3.5-0.8b');
  });

  it('buildModelList advertises qwen3.5-0.8b when LAPTOP_ENABLED=true', () => {
    loadEnv({ LAPTOP_ENABLED: 'true', LAPTOP_MODEL: 'qwen3.5-0.8b' });
    const laptop = buildModelList().find((m) => m.id === 'qwen3.5-0.8b');
    expect(laptop).toBeDefined();
    expect(laptop?.owned_by).toBe('laptop');
  });

  it('buildModelList omits the laptop model when LAPTOP_ENABLED is false (default)', () => {
    loadEnv({ LAPTOP_ENABLED: 'false', LAPTOP_MODEL: 'qwen3.5-0.8b' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('qwen3.5-0.8b');
  });
});

describe('buildModelList - opencode gone-slot filtering', () => {
  // 2026-09-17: an emptied OPENCODE_*_MODEL drops the routing slot (instances
  // filter); the advertisement surfaces must not resurrect it as an empty-id
  // entry in /v1/models or the GraphQL models query.
  it('never advertises empty-string ids when an opencode variant slot is emptied', () => {
    loadEnv({ OPENCODE_KEY1: 'sk-opencode-test-1', OPENCODE_NEMOTRON_MODEL: '' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('');
    expect(ids).not.toContain('nemotron-3-ultra-free');
  });

  it('still advertises the surviving opencode models', () => {
    loadEnv({ OPENCODE_KEY1: 'sk-opencode-test-1', OPENCODE_NEMOTRON_MODEL: '' });
    const ids = buildModelList().filter((m) => m.owned_by.startsWith('opencode-')).map((m) => m.id);
    expect(ids).toContain('big-pickle');
    expect(ids).toContain('mimo-v2.5-free');
    expect(ids).toHaveLength(7); // 8 slots minus the emptied one
  });

  it('advertises big-pickle and nemotron-3-ultra-free when both slots are configured', () => {
    loadEnv({
      OPENCODE_KEY1: 'sk-opencode-test-1',
      OPENCODE_MODEL: 'big-pickle',
      OPENCODE_NEMOTRON_MODEL: 'nemotron-3-ultra-free',
    });
    const oc = buildModelList().filter((m) => m.owned_by.startsWith('opencode-'));
    expect(oc.map((m) => m.id)).toEqual(
      expect.arrayContaining(['big-pickle', 'nemotron-3-ultra-free']),
    );
    expect(oc.find((m) => m.id === 'nemotron-3-ultra-free')?.owned_by).toBe('opencode-nemotron');
  });
});
