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
    expect(cfg.env.DIRECTOR_PIDFILE).toBe('~/.campaign-agent/job-search-agent.pid');
    expect(cfg.env.DIRECTOR_OVERRIDES).toBe('~/.campaign-agent/director-overrides.env');
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

describe('loadEnv - OPENROUTER_MODELS', () => {
  it('defaults to ["stealth/ox-alpha"] when unset', () => {
    const cfg = loadEnv({});
    expect(cfg.env.OPENROUTER_MODELS).toEqual(['stealth/ox-alpha']);
  });

  it('accepts a custom comma-separated list', () => {
    const cfg = loadEnv({ OPENROUTER_MODELS: 'model-a,model-b' });
    expect(cfg.env.OPENROUTER_MODELS).toEqual(['model-a', 'model-b']);
  });

  it('returns [] when explicitly set to empty string', () => {
    const cfg = loadEnv({ OPENROUTER_MODELS: '' });
    expect(cfg.env.OPENROUTER_MODELS).toEqual([]);
  });

  it('trims whitespace and filters blanks', () => {
    const cfg = loadEnv({ OPENROUTER_MODELS: ' model-a , , model-b ' });
    expect(cfg.env.OPENROUTER_MODELS).toEqual(['model-a', 'model-b']);
  });

  it('OPENROUTER_MODEL remains separate from OPENROUTER_MODELS', () => {
    const cfg = loadEnv({});
    expect(cfg.env.OPENROUTER_MODEL).toBe('openrouter/free');
    expect(cfg.env.OPENROUTER_MODELS).toEqual(['stealth/ox-alpha']);
  });
});

describe('loadEnv - VPN rotation', () => {
  it('defaults VPN_ROTATION_INTERVAL_MINUTES to 30', () => {
    const cfg = loadEnv({});
    expect(cfg.env.VPN_ROTATION_INTERVAL_MINUTES).toBe(30);
  });

  it('accepts an explicit VPN_ROTATION_INTERVAL_MINUTES override', () => {
    const cfg = loadEnv({ VPN_ROTATION_INTERVAL_MINUTES: '15' });
    expect(cfg.env.VPN_ROTATION_INTERVAL_MINUTES).toBe(15);
  });
});

describe('loadEnv - Local (llama-server) provider', () => {
  it('defaults LOCAL_ENABLED to false with the default llama-server endpoint/model', () => {
    const cfg = loadEnv({});
    expect(cfg.env.LOCAL_ENABLED).toBe(false);
    expect(cfg.env.LOCAL_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(cfg.env.LOCAL_MODEL).toBe('qwen3.5:2b');
    expect(cfg.env.LOCAL_TIMEOUT_MS).toBe(300_000);
  });

  it('accepts LOCAL_ENABLED=true and a model override', () => {
    const cfg = loadEnv({ LOCAL_ENABLED: 'true', LOCAL_MODEL: 'qwen3:8b' });
    expect(cfg.env.LOCAL_ENABLED).toBe(true);
    expect(cfg.env.LOCAL_MODEL).toBe('qwen3:8b');
  });

  it('treats LOCAL_ENABLED=0 as false', () => {
    const cfg = loadEnv({ LOCAL_ENABLED: '0' });
    expect(cfg.env.LOCAL_ENABLED).toBe(false);
  });
});

describe('loadEnv - LM Studio (Bionic) local provider', () => {
  it('defaults LMSTUDIO_ENABLED to false with the default LM Studio endpoint/model', () => {
    const cfg = loadEnv({});
    expect(cfg.env.LMSTUDIO_ENABLED).toBe(false);
    expect(cfg.env.LMSTUDIO_BASE_URL).toBe('http://127.0.0.1:1234/v1');
    // Alias only: the provider resolves it against discovered loaded models.
    expect(cfg.env.LMSTUDIO_MODEL).toBe('qwen3.5-4b');
  });

  it('accepts LMSTUDIO_ENABLED=true and a model override', () => {
    const cfg = loadEnv({ LMSTUDIO_ENABLED: 'true', LMSTUDIO_MODEL: 'qwen3.5-4b' });
    expect(cfg.env.LMSTUDIO_ENABLED).toBe(true);
    expect(cfg.env.LMSTUDIO_MODEL).toBe('qwen3.5-4b');
  });

  it('gives LM Studio its own slow-local timeout (default 300s, overridable)', () => {
    const cfg = loadEnv({});
    expect(cfg.env.LMSTUDIO_TIMEOUT_MS).toBe(300_000);
    const over = loadEnv({ LMSTUDIO_TIMEOUT_MS: '600000' });
    expect(over.env.LMSTUDIO_TIMEOUT_MS).toBe(600_000);
  });
});
