import { describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('collects numbered OPENROUTER_KEY1..N in ascending order', () => {
    const cfg = loadEnv({
      OPENROUTER_KEY3: 'k3',
      OPENROUTER_KEY1: 'k1',
      OPENROUTER_KEY2: 'k2',
    });
    expect(cfg.openrouterKeys).toEqual(['k1', 'k2', 'k3']);
  });

  it('dedupes keys and appends OPENROUTER_API_KEY if not already present', () => {
    const cfg = loadEnv({
      OPENROUTER_KEY1: 'dup',
      OPENROUTER_KEY2: 'dup',
      OPENROUTER_API_KEY: 'single',
    });
    expect(cfg.openrouterKeys).toEqual(['dup', 'single']);
  });

  it('throws on an invalid value (fail-fast)', () => {
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow(/Invalid environment/);
  });
});

describe('loadEnv - OpenCode key pool', () => {
  it('collects numbered OPENCODE_KEY1..N in ascending order', () => {
    const cfg = loadEnv({
      OPENCODE_KEY3: 'k3',
      OPENCODE_KEY1: 'k1',
      OPENCODE_KEY2: 'k2',
    });
    expect(cfg.opencodeKeys).toEqual(['k1', 'k2', 'k3']);
  });

  it('dedupes OpenCode keys', () => {
    const cfg = loadEnv({
      OPENCODE_KEY1: 'dup',
      OPENCODE_KEY2: 'dup',
    });
    expect(cfg.opencodeKeys).toEqual(['dup']);
  });

  it('appends OPENCODE_API_KEY last if not already present', () => {
    const cfg = loadEnv({
      OPENCODE_KEY1: 'k1',
      OPENCODE_API_KEY: 'legacy',
    });
    expect(cfg.opencodeKeys).toEqual(['k1', 'legacy']);
  });

  it('does not append OPENCODE_API_KEY if it duplicates a numbered key', () => {
    const cfg = loadEnv({
      OPENCODE_KEY1: 'same',
      OPENCODE_API_KEY: 'same',
    });
    expect(cfg.opencodeKeys).toEqual(['same']);
  });

  it('falls back to OPENCODE_API_KEY alone when no numbered keys', () => {
    const cfg = loadEnv({ OPENCODE_API_KEY: 'only' });
    expect(cfg.opencodeKeys).toEqual(['only']);
  });

  it('returns empty array when no OpenCode keys configured', () => {
    const cfg = loadEnv({});
    expect(cfg.opencodeKeys).toEqual([]);
  });

  it('ignores blank/whitespace values', () => {
    const cfg = loadEnv({
      OPENCODE_KEY1: '   ',
      OPENCODE_KEY2: 'k2',
      OPENCODE_API_KEY: '  ',
    });
    expect(cfg.opencodeKeys).toEqual(['k2']);
  });
});
