/**
 * Tests for chain-routing: shortCircuit parsing and buildRoutingEntries.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env.js';

import { isProviderDefaultModel, shortCircuit } from './chain-routing.js';
import { withFree } from './openrouter.js';

describe('shortCircuit', () => {
  it('returns null for non-direct models', () => {
    expect(shortCircuit('openrouter/free')).toBeNull();
    expect(shortCircuit('mst/free')).toBeNull();
    expect(shortCircuit('gpt-4o')).toBeNull();
  });

  it('parses direct:openai/<model>', () => {
    const r = shortCircuit('direct:openai/gpt-4o-mini');
    expect(r).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('parses direct:opencode/<model> (lowercased)', () => {
    const r = shortCircuit('direct:opencode/Big-Pickle');
    expect(r).toEqual({ provider: 'opencode', model: 'big-pickle' });
  });

  it('parses direct:zai/<model> and STRIPS the zai/ prefix', () => {
    // 2026-09-09: the prefix was never stripped, so the upstream got model
    // "zai/glm-4.6" and Z.ai rejected it with 400. The model must be clean.
    const r = shortCircuit('direct:zai/glm-4.6');
    expect(r).toEqual({ provider: 'zai', model: 'glm-4.6' });
    expect(shortCircuit('direct:zai/glm-5.3-flash')).toEqual({
      provider: 'zai',
      model: 'glm-5.3-flash',
    });
  });

  it('parses direct:glm-<model> (alias without zai/ prefix)', () => {
    const r = shortCircuit('direct:glm-4.6');
    expect(r).toEqual({ provider: 'zai', model: 'glm-4.6' });
  });

  it('parses direct:openrouter/<model> and applies withFree', () => {
    const r = shortCircuit('direct:openrouter/anthropic/claude-3-opus');
    // FORCE_FREE defaults to true, so :free is appended
    expect(r).toEqual({ provider: 'openrouter', model: 'anthropic/claude-3-opus:free' });
  });

  it('parses direct:openrouter/stealth/<model> and keeps the bare id', () => {
    // Natively free stealth previews must not gain a :free suffix (no such
    // variant exists upstream).
    expect(shortCircuit('direct:openrouter/stealth/union-alpha')).toEqual({
      provider: 'openrouter',
      model: 'stealth/union-alpha',
    });
  });

  it('parses direct:tokenrouter/<model>', () => {
    const r = shortCircuit('direct:tokenrouter/z-ai/glm-5.3-free');
    expect(r).toEqual({ provider: 'tokenrouter', model: 'z-ai/glm-5.3-free' });
  });

  it('is case-insensitive for the tokenrouter prefix', () => {
    const r = shortCircuit('DIRECT:TokenRouter/z-ai/glm-5.3-free');
    expect(r).toEqual({ provider: 'tokenrouter', model: 'z-ai/glm-5.3-free' });
  });

  it('parses direct:opencodego/<model> (lowercased)', () => {
    const r = shortCircuit('direct:opencodego/GLM-5.3-Flash');
    expect(r).toEqual({ provider: 'opencodego', model: 'glm-5.3-flash' });
  });

  it('is case-insensitive for the opencodego prefix', () => {
    const r = shortCircuit('DIRECT:OpenCodeGo/glm-5.3-flash');
    expect(r).toEqual({ provider: 'opencodego', model: 'glm-5.3-flash' });
  });

  it('parses direct:local/<model>', () => {
    const r = shortCircuit('direct:local/qwen3:14b-32k');
    expect(r).toEqual({ provider: 'local', model: 'qwen3:14b-32k' });
  });

  it('parses direct:lmstudio/<model>', () => {
    const r = shortCircuit('direct:lmstudio/some-model');
    expect(r).toEqual({ provider: 'lmstudio', model: 'some-model' });
  });

  it('parses direct:laptop/<model> (colon model ids preserved)', () => {
    const r = shortCircuit('direct:laptop/qwen3.5:2b');
    expect(r).toEqual({ provider: 'laptop', model: 'qwen3.5:2b' });
  });

  it('is case-insensitive for prefix detection', () => {
    const r = shortCircuit('DIRECT:OpenAI/gpt-4o');
    expect(r).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('returns null for an unknown direct: provider (no short-circuit)', () => {
    // An unrecognized direct: target must fall through to the default chain
    // rather than being pinned to a nonexistent provider.
    expect(shortCircuit('direct:unknown-provider/some-model')).toBeNull();
    expect(shortCircuit('direct:/')).toBeNull();
  });
});

describe('isProviderDefaultModel - opencode pool variants', () => {
  afterEach(() => loadEnv({}));

  it('recognizes the opencode primary model (big-pickle)', () => {
    loadEnv({ OPENCODE_KEY1: 'sk-opencode-test-1', OPENCODE_MODEL: 'big-pickle' });
    expect(isProviderDefaultModel('big-pickle')).toBe(true);
  });

  it('recognizes a configured opencode NEMOTRON pool model (no :free rewrite)', () => {
    // An explicit nemotron-3-ultra-free request must reach the pool triple
    // with the bare id; withFree() would otherwise mangle it into
    // "nemotron-3-ultra-free:free" which no upstream accepts.
    loadEnv({
      OPENCODE_KEY1: 'sk-opencode-test-1',
      OPENCODE_NEMOTRON_MODEL: 'nemotron-3-ultra-free',
    });
    expect(isProviderDefaultModel('nemotron-3-ultra-free')).toBe(true);
  });

  it('does not claim a retired (emptied) opencode slot', () => {
    loadEnv({ OPENCODE_NEMOTRON_MODEL: '' });
    expect(isProviderDefaultModel('nemotron-3-ultra-free')).toBe(false);
  });
});

describe('withFree', () => {
  it('appends :free when force=true and no suffix', () => {
    expect(withFree('anthropic/claude-3-opus', true)).toBe('anthropic/claude-3-opus:free');
  });

  it('does not append :free when force=false', () => {
    expect(withFree('anthropic/claude-3-opus', false)).toBe('anthropic/claude-3-opus');
  });

  it('does not double-append :free', () => {
    expect(withFree('model:free', true)).toBe('model:free');
  });

  it('does not append :free to openrouter/auto', () => {
    expect(withFree('openrouter/auto', true)).toBe('openrouter/auto');
  });

  it('does not append :free to openrouter/free', () => {
    expect(withFree('openrouter/free', true)).toBe('openrouter/free');
  });

  it('preserves existing variant suffix like :2024-08-06', () => {
    // includes(':') prevents double-suffixing — any colon variant is preserved
    const result = withFree('openai/gpt-4o:2024-08-06', true);
    expect(result).toBe('openai/gpt-4o:2024-08-06');
  });

  it('does not append :free to stealth/ models (natively free, no :free variant)', () => {
    // stealth/union-alpha is 0/0-priced at its base id on OpenRouter and no
    // 'stealth/union-alpha:free' id exists, so rewriting it would 404 every
    // request instead of using the already-free model.
    expect(withFree('stealth/union-alpha', true)).toBe('stealth/union-alpha');
  });
});

describe('withFree - free-tier model naming', () => {
  it('appends :free to additional configured models (e.g. vendor/extra)', () => {
    expect(withFree('vendor/extra', true)).toBe('vendor/extra:free');
  });

  it('does not double-append :free when model already ends with :free', () => {
    expect(withFree('vendor/extra:free', true)).toBe('vendor/extra:free');
  });

  it('appends :free to other models when force=true', () => {
    expect(withFree('anthropic/claude-3-opus', true)).toBe('anthropic/claude-3-opus:free');
  });

  it('does not append :free to openrouter/auto (meta-router)', () => {
    expect(withFree('openrouter/auto', true)).toBe('openrouter/auto');
  });

  it('does not append :free to openrouter/free (meta-router)', () => {
    expect(withFree('openrouter/free', true)).toBe('openrouter/free');
  });

  it('preserves model with existing colon variant even if not :free', () => {
    expect(withFree('openai/gpt-4o:2024-08-06', true)).toBe('openai/gpt-4o:2024-08-06');
  });

  it('returns model unchanged when force=false', () => {
    expect(withFree('vendor/extra', false)).toBe('vendor/extra');
    expect(withFree('anthropic/claude-3-opus', false)).toBe('anthropic/claude-3-opus');
  });
});
