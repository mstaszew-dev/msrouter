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
