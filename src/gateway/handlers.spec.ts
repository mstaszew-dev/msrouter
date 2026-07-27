/**
 * Gateway routing + model-resolution tests. Verifies the gateway serves the
 * OpenAI-standard /v1 path (drop-in for openai SDK / OpenClaw) AND that an
 * unknown model id defaults to the mst/free alias walk.
 */

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { Router } from '../common/http.js';
import type { ProviderCallResult } from '../providers/types.js';

import { registerHandlers, resolveModel } from './handlers.js';

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
});
