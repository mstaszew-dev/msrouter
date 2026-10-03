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
    const tr = buildModelList().find(
      (m) => m.id === 'glm-5.3-flash' && m.owned_by === 'opencodego',
    );
    expect(tr).toBeDefined();
  });

  it('omits the opencodego model when OPENCODEGO_API_KEY is unset', () => {
    loadEnv({ OPENCODEGO_MODEL: 'glm-5.3-flash' });
    const ids = buildModelList()
      .filter((m) => m.owned_by === 'opencodego')
      .map((m) => m.id);
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

describe('laptop (tailnet Ollama) wiring', () => {
  it('resolveModel passes qwen35-2b-64k through as a known model', () => {
    loadEnv({ LAPTOP_MODEL: 'qwen35-2b-64k' });
    expect(resolveModel('qwen35-2b-64k')).toBe('qwen35-2b-64k');
  });

  it('buildModelList advertises qwen35-2b-64k when LAPTOP_ENABLED=true', () => {
    loadEnv({ LAPTOP_ENABLED: 'true', LAPTOP_MODEL: 'qwen35-2b-64k' });
    const laptop = buildModelList().find((m) => m.id === 'qwen35-2b-64k');
    expect(laptop).toBeDefined();
    expect(laptop?.owned_by).toBe('laptop');
  });

  it('buildModelList omits the laptop model when LAPTOP_ENABLED is false (default)', () => {
    loadEnv({ LAPTOP_ENABLED: 'false', LAPTOP_MODEL: 'qwen35-2b-64k' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('qwen35-2b-64k');
  });
});

describe('model-list - extra free-tier providers', () => {
  it('advertises a configured extra default (owned_by the provider id)', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-test' });
    const entry = buildModelList().find((m) => m.id === 'openai/gpt-oss-120b');
    expect(entry).toMatchObject({ owned_by: 'groq' });
  });

  it('never advertises unconfigured extras (no empty unorouter id)', () => {
    loadEnv({});
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('');
    expect(ids).not.toContain('openai/gpt-oss-120b');
    expect(ids).not.toContain('mistral-small-latest');
  });

  it('resolveModel passes a configured extra default through verbatim', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-test' });
    expect(resolveModel('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
    // Unconfigured: rewritten to the walk alias.
    loadEnv({});
    expect(resolveModel('openai/gpt-oss-120b')).toBe('mst/free');
  });
});

describe('model-list - CSV extra models', () => {
  it('advertises CSV models and passes them through resolveModel verbatim', () => {
    // Regression pin: without extraRoutingEntries() flowing into
    // isProviderDefaultModel, withFree would rewrite qwen/qwen3.8-27b into
    // qwen/qwen3.8-27b:free and groq would 400 on the explicit path.
    loadEnv({ GROQ_API_KEY: 'gsk-1', GROQ_MODELS: 'qwen/qwen3.8-27b' });
    expect(buildModelList()).toContainEqual({
      id: 'qwen/qwen3.8-27b',
      object: 'model',
      owned_by: 'groq',
    });
    expect(resolveModel('qwen/qwen3.8-27b')).toBe('qwen/qwen3.8-27b');
  });

  it('retire variant: emptied primary hides the provider including its CSV models', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-1', GROQ_MODEL: '', GROQ_MODELS: 'qwen/qwen3.8-27b' });
    const ids = buildModelList().map((m) => m.id);
    expect(ids).not.toContain('qwen/qwen3.8-27b');
    expect(ids).not.toContain('openai/gpt-oss-120b');
    expect(resolveModel('qwen/qwen3.8-27b')).toBe('mst/free');
  });
});

// 2026-10-03: parseUpstreamJson used to scrub the raw echo before returning it.
// Scrubbing was removed (it rewrote real client data); this drives the real
// POST /v1/chat/completions route and pins that a non-JSON upstream body reaches
// the client verbatim. The branch previously had no coverage at all.
describe('non-JSON upstream body is returned verbatim', () => {
  it('echoes an HTML body containing an sk- substring unchanged', async () => {
    const upstream = '<html>error sk-or-v1-deadbeef disk-boot</html>';
    const chain = {
      handle: vi.fn(async () => ({
        kind: 'OK' as const,
        response: new Response(upstream, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        servedBy: { provider: 'openrouter', model: 'openrouter/free' },
      })),
    };
    const router = new Router();
    registerHandlers(router, { chain: chain as never, log: silentLogger });

    // Minimal node:http IncomingMessage / ServerResponse doubles: the handler
    // only reads method/url/headers/body off req and writes via res.
    const req = {
      id: 'test-correlation',
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      params: {},
      body: { model: 'mst/free', messages: [{ role: 'user', content: 'hi' }] },
      // handleChat registers a disconnect hook; it must exist on the double.
      on: vi.fn(),
    };
    let payload = '';
    const res = {
      setHeader: vi.fn(),
      getHeader: vi.fn(),
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        payload += chunk;
        return true;
      }),
      // sendJson writes the whole payload through end(), not write().
      end: vi.fn((chunk?: string) => {
        if (typeof chunk === 'string') payload += chunk;
      }),
      writableEnded: false,
      statusCode: 200,
    };

    const matched = router.resolve('POST', '/v1/chat/completions');
    expect(matched).not.toBeNull();
    await matched!.route.handler(req as never, res as never);

    expect(chain.handle).toHaveBeenCalledTimes(1);
    expect(payload).toContain('sk-or-v1-deadbeef');
    expect(payload).not.toContain('REDACTED');
  });
});
