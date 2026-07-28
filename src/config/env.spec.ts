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

describe('loadEnv - Director config', () => {
  it('applies Director defaults when no DIRECTOR_* vars are set', () => {
    const cfg = loadEnv({});
    expect(cfg.env.DIRECTOR_INTERVAL_MINUTES).toBe(1);
    expect(cfg.env.DIRECTOR_CAMPAIGN_DIR).toBe('/Users/mst/Downloads/job-search/job-apply');
    expect(cfg.env.DIRECTOR_PIDFILE).toBe('~/.openclaw/run-one-job.pid');
    expect(cfg.env.DIRECTOR_OVERRIDES).toBe('~/.openclaw/director-overrides.env');
    expect(cfg.env.DIRECTOR_CDP_URL).toBe('http://127.0.0.1:9222');
  });

  it('accepts overrides for all DIRECTOR_* vars', () => {
    const cfg = loadEnv({
      DIRECTOR_INTERVAL_MINUTES: '15',
      DIRECTOR_MODEL: 'direct:opencode/big-pickle',
      DIRECTOR_CAMPAIGN_DIR: '/tmp/campaign',
      DIRECTOR_OPENCLAW_WORKSPACE: '/tmp/oc',
      DIRECTOR_RUNNER: '/tmp/launch',
      DIRECTOR_PIDFILE: '/tmp/pid',
      DIRECTOR_OVERRIDES: '/tmp/overrides.env',
      DIRECTOR_LEDGER: '/tmp/ledger.jsonl',
      DIRECTOR_CDP_URL: 'http://127.0.0.1:9999',
      DIRECTOR_RAG_DB: '/tmp/index.db',
    });
    expect(cfg.env.DIRECTOR_INTERVAL_MINUTES).toBe(15);
    expect(cfg.env.DIRECTOR_MODEL).toBe('direct:opencode/big-pickle');
    expect(cfg.env.DIRECTOR_CAMPAIGN_DIR).toBe('/tmp/campaign');
    expect(cfg.env.DIRECTOR_CDP_URL).toBe('http://127.0.0.1:9999');
  });

  it('rejects a non-numeric DIRECTOR_INTERVAL_MINUTES', () => {
    expect(() => loadEnv({ DIRECTOR_INTERVAL_MINUTES: 'soon' })).toThrow(/Invalid environment/);
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
