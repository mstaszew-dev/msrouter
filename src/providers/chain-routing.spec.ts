/**
 * Tests for chain-routing: shortCircuit parsing and buildRoutingEntries.
 */

import { describe, expect, it } from 'vitest';

import { shortCircuit } from './chain-routing.js';
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

  it('parses direct:zai/<model>', () => {
    const r = shortCircuit('direct:zai/glm-4.6');
    expect(r).toEqual({ provider: 'zai', model: 'zai/glm-4.6' });
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

  it('parses direct:local/<model>', () => {
    const r = shortCircuit('direct:local/qwen3:14b-32k');
    expect(r).toEqual({ provider: 'local', model: 'qwen3:14b-32k' });
  });

  it('parses direct:lmstudio/<model>', () => {
    const r = shortCircuit('direct:lmstudio/some-model');
    expect(r).toEqual({ provider: 'lmstudio', model: 'some-model' });
  });

  it('is case-insensitive for prefix detection', () => {
    const r = shortCircuit('DIRECT:OpenAI/gpt-4o');
    expect(r).toEqual({ provider: 'openai', model: 'gpt-4o' });
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
});
