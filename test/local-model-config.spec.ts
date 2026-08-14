/**
 * CONSTRAINT tests: local-model consolidation (zcode + opencode + msrouter).
 *
 * `google/gemma-4-e4b` (served by LM Studio / Bionic on 127.0.0.1:1234) is the
 * single local model. These tests pin that invariant across every config that
 * references local inference, and pin the five remote custom providers that
 * must survive in the zcode models config (the Aug 2026 corruption wiped them).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const LOCAL_MODEL = 'google/gemma-4-e4b';

const HOME = process.env['HOME'] ?? '/Users/mst';

const ZCODE_CONFIG = new URL(`file://${HOME}/.zcode/v2/config.json`);
const OPENCODE_CONFIG = new URL(`file://${HOME}/.config/opencode/opencode.json`);
const MSROUTER_ENV = new URL(`file://${HOME}/ZCodeProject/msrouter/.env`);

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

function providerIds(json: Record<string, unknown>): string[] {
  const provider = json['provider'];
  if (provider === null || typeof provider !== 'object') {
    return [];
  }
  return Object.keys(provider as Record<string, unknown>);
}

describe('constraint: local model is google/gemma-4-e4b everywhere', () => {
  it('msrouter .env pins LMSTUDIO_MODEL=google/gemma-4-e4b', () => {
    const env = readFileSync(MSROUTER_ENV, 'utf8');
    expect(env).toMatch(new RegExp(`^LMSTUDIO_MODEL=${LOCAL_MODEL}$`, 'm'));
    expect(env).not.toMatch(/^LMSTUDIO_MODEL=qwen/i);
    expect(env).not.toMatch(/^LMSTUDIO_MODEL=google\/gemma-4-e2b$/m);
  });

  it('opencode llama.cpp provider exposes only google/gemma-4-e4b locally', () => {
    const cfg = readJson(OPENCODE_CONFIG);
    const llama = (cfg['provider'] as Record<string, unknown>)['llama.cpp'] as {
      models?: Record<string, unknown>;
    };
    const models = Object.keys(llama.models ?? {});
    expect(models).toEqual([LOCAL_MODEL]);
  });

  it('opencode local model exposes the native 128k context limit', () => {
    const cfg = readJson(OPENCODE_CONFIG);
    const llama = (cfg['provider'] as Record<string, unknown>)['llama.cpp'] as {
      models?: Record<string, { limit?: { context?: number } }>;
    };
    const limit = llama.models?.[LOCAL_MODEL]?.limit;
    expect(limit?.context).toBe(131072);
  });
});

describe('constraint: zcode models config keeps all remote custom providers', () => {
  const REQUIRED_PROVIDERS = [
    'ccd49314-1523-4c98-9dd0-47b5072db752', // OpenAI (gpt-5.5)
    'ab7e04f9-8a56-4473-b5bb-996b1a17df85', // OpenRouter
    '5140f00b-3e52-4115-b865-b6358a046235', // Gemini
    '68c67047-dc84-4e0f-80c8-b0743d2150ef', // OpenCode
    '8757853b-86fa-4d49-a17f-883d147d7891', // MSRouter (mst/free)
  ];

  it('contains every remote custom provider id', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const ids = providerIds(cfg);
    for (const id of REQUIRED_PROVIDERS) {
      expect(ids).toContain(id);
    }
  });

  it('ships the OpenAI (gpt-5.5) provider with its base URL', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const p = (cfg['provider'] as Record<string, unknown>)[
      'ccd49314-1523-4c98-9dd0-47b5072db752'
    ] as {
      options?: { baseURL?: string };
      models?: Record<string, unknown>;
    };
    expect(p.options?.baseURL).toBe('https://api.openai.com/v1');
    expect(Object.keys(p.models ?? {})).toContain('gpt-5.5');
  });

  it('ships the MSRouter provider pointing at the local gateway (mst/free)', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const p = (cfg['provider'] as Record<string, unknown>)[
      '8757853b-86fa-4d49-a17f-883d147d7891'
    ] as {
      options?: { baseURL?: string };
      models?: Record<string, unknown>;
    };
    expect(p.options?.baseURL).toBe('http://127.0.0.1:8787/v1');
    expect(Object.keys(p.models ?? {})).toContain('mst/free');
  });
});

describe('constraint: zcode local model is LM Studio serving gemma-4-e4b', () => {
  it('has an LM Studio local provider on 127.0.0.1:1234 with the e4b model', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const providers = cfg['provider'] as Record<string, unknown>;
    const local = Object.values(providers).find(
      (p) =>
        (p as { options?: { baseURL?: string } }).options?.baseURL === 'http://127.0.0.1:1234/v1',
    ) as {
      models?: Record<string, unknown>;
    };
    expect(local).toBeDefined();
    expect(Object.keys(local.models ?? {})).toEqual([LOCAL_MODEL]);
  });

  it('zcode local model exposes the native 128k context limit', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const providers = cfg['provider'] as Record<string, unknown>;
    const local = Object.values(providers).find(
      (p) =>
        (p as { options?: { baseURL?: string } }).options?.baseURL === 'http://127.0.0.1:1234/v1',
    ) as {
      models?: Record<string, { limit?: { context?: number } }>;
    };
    const limit = local.models?.[LOCAL_MODEL]?.limit;
    expect(limit?.context).toBe(131072);
  });

  it('no longer references ollama/qwen local models anywhere', () => {
    const cfg = readJson(ZCODE_CONFIG);
    const raw = JSON.stringify(cfg);
    expect(raw).not.toContain('localhost:11434');
    expect(raw).not.toContain('qwen3:8b');
    expect(raw).not.toContain('qwen3.5-9b');
    expect(raw).not.toContain('gemma-4-e2b');
  });
});
