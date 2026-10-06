import { describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';

import { buildRoutingEntries, isProviderDefaultModel } from './chain-routing.js';
import type { Providers } from './instances.js';
import { shortCircuit } from './shortcircuit.js';
import type { Provider, ProviderCallResult } from './types.js';

/**
 * OpenCode Zen (/zen/v1) as a single-key slot.
 *
 * The pool was removed in e7af446 because every free model returned
 * FreeTierError for non-OpenCode clients. Re-audited 2026-10-06: that still
 * holds for 10 of the 11 `-free` models (big-pickle,
 * nemotron-3.5-lightning-free, mimo-v2.6-flash-free, ... all
 * "can only be used from within OpenCode"), but `space-bunny-free` answers a
 * plain external API call. So exactly one model is admitted, and the slot is
 * empty by default rather than listing models that only 403.
 */

function stubProvider(id: string, available: boolean, calls: ProviderCallResult[]): Provider {
  const queue = [...calls];
  return {
    id,
    available,
    defaultModel: 'space-bunny-free',
    attempt: vi.fn(async () => queue.shift() ?? { kind: 'OK', response: new Response('') }),
  } as unknown as Provider;
}

function providersWithZen(zenAvailable: boolean): Providers {
  return {
    openrouter: stubProvider('openrouter', false, []),
    openai: stubProvider('openai', false, []),
    zai: stubProvider('zai', false, []),
    tokenrouter: stubProvider('tokenrouter', false, []),
    opencodego: stubProvider('opencodego', false, []),
    opencode: stubProvider('opencode', zenAvailable, []),
    extras: {} as Providers['extras'],
    local: stubProvider('local', false, []),
    lmstudio: stubProvider('lmstudio', false, []),
    laptop: stubProvider('laptop', false, []),
  } as unknown as Providers;
}

/** Minimal env: only the fields the routing builder reads. */
const BASE_ENV = {
  WALK_ALIAS: 'mst/free',
  OPENROUTER_KEY1: '',
  OPENROUTER_MODEL: 'openrouter/free',
  OPENROUTER_MODELS: '',
  FORCE_FREE: 'true',
  SUCCESS_DEMOTE_LIMIT: '5',
  MAX_TRANSIENT_RETRIES: '2',
  TRANSIENT_BACKOFF_MS: '1',
  RATE_LIMIT_COOLDOWN_MS: '0',
  WALK_DEADLINE_MS: '300000',
  LOCAL_ENABLED: 'false',
  LMSTUDIO_ENABLED: 'false',
  LAPTOP_ENABLED: 'false',
  OPENCODEGO_API_KEY: '',
  OPENCODE_API_KEY: '',
  OPENCODE_MODEL: 'space-bunny-free',
  OPENCODE_BASE_URL: 'https://opencode.ai/zen/v1',
} as Record<string, string>;

const ZEN_ENV = {
  ...BASE_ENV,
  OPENCODE_API_KEY: 'sk-test',
  OPENCODE_BASE_URL: 'https://opencode.ai/zen/v1',
  OPENCODE_MODEL: 'space-bunny-free',
  LAPTOP_ENABLED: 'false',
  LOCAL_ENABLED: 'false',
  LMSTUDIO_ENABLED: 'false',
};

describe('shortCircuit - OpenCode Zen pinning', () => {
  it('pins direct:opencode/<model> to the zen slot', () => {
    // Without this branch the pin is not recognised, so the request falls
    // through to the full walk with a mangled explicit model and every entry
    // 400s: observed live as "opencode:BAD_REQUEST(400); unorouter:...(404)"
    // on a request that should have been served by one provider.
    loadEnv(ZEN_ENV);
    expect(shortCircuit('direct:opencode/space-bunny-free')).toEqual({
      provider: 'opencode',
      model: 'space-bunny-free',
    });
  });

  it('keeps the model id verbatim (no :free rewrite on a pin)', () => {
    loadEnv(ZEN_ENV);
    expect(shortCircuit('direct:opencode/space-bunny-free')?.model).toBe('space-bunny-free');
  });

  it('does not confuse opencode with opencodego', () => {
    loadEnv(ZEN_ENV);
    expect(shortCircuit('direct:opencodego/glm-5.3-flash')?.provider).toBe('opencodego');
    expect(shortCircuit('direct:opencode/space-bunny-free')?.provider).toBe('opencode');
  });
});

describe('isProviderDefaultModel - OpenCode Zen id is exempt from the :free rewrite', () => {
  // ProviderChain.handle FORCE_FREE-rewrites any model that is not a configured
  // per-provider default. space-bunny-free was missing from that list, so a bare
  // request for it (which resolveModel now passes through instead of rewriting
  // into the alias walk) was sent upstream as "space-bunny-free:free" and 502'd
  // the whole walk: observed 2026-10-06.
  it('keeps the bare zen id verbatim (no :free rewrite)', () => {
    loadEnv(ZEN_ENV);
    expect(isProviderDefaultModel('space-bunny-free')).toBe(true);
  });

  it('does not exempt an emptied zen slot', () => {
    // Empty model var = retired slot. An empty id must never be exempt.
    loadEnv({ ...ZEN_ENV, OPENCODE_MODEL: '' });
    expect(isProviderDefaultModel('')).toBe(false);
  });
});

describe('ProviderChain - OpenCode Zen slot', () => {
  it('omits the zen entry when no key is configured (empty by default)', () => {
    loadEnv({ ...BASE_ENV });
    const entries = buildRoutingEntries(providersWithZen(false));
    expect(entries.some((e) => e.provider === 'opencode')).toBe(false);
  });

  it('adds one zen entry for the configured model when a key is present', () => {
    loadEnv(ZEN_ENV);
    const entries = buildRoutingEntries(providersWithZen(true));
    const zen = entries.filter((e) => e.provider === 'opencode');
    expect(zen).toHaveLength(1);
    expect(zen[0]!.model).toBe('space-bunny-free');
    expect(zen[0]!.label).toBe('opencode');
  });

  it('routes zen BEFORE the local tail', () => {
    // Free remote first: the tail is the slow last resort.
    loadEnv({ ...ZEN_ENV, LAPTOP_ENABLED: 'true' });
    const entries = buildRoutingEntries(providersWithZen(true));
    const zenAt = entries.findIndex((e) => e.provider === 'opencode');
    const laptopAt = entries.findIndex((e) => e.provider === 'laptop');
    expect(zenAt).toBeGreaterThanOrEqual(0);
    expect(laptopAt).toBeGreaterThanOrEqual(0);
    expect(zenAt).toBeLessThan(laptopAt);
  });
});