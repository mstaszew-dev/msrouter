/**
 * CONSTRAINT tests: local-model consolidation (zcode + opencode + msrouter).
 *
 * The local fleet is a single Qwen3.5 4B GGUF served by llama.cpp on
 * 127.0.0.1:1235. The retired 9B fleet (port 1234) and the LOCAL ollama
 * daemon (port 11434; the laptop slot now targets the tailnet Ollama) are
 * gone: neither binary is installed and no model file exists,
 * so any config still advertising them is a dead selector. msrouter does NOT
 * pin a single model: LMSTUDIO_MODEL is a preferred alias and the provider
 * discovers the loaded models at call time (see src/providers/lmstudio.spec.ts),
 * so swapping which GGUF is loaded needs no msrouter restart. These tests pin
 * that invariant across every config that references local inference, and pin
 * the five remote custom providers that must survive in the zcode models config
 * (the Aug 2026 corruption wiped them).
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const QWEN_9B = 'qwen/qwen3.5-9b';
const QWEN_4B = 'qwen/qwen3.5-4b';
const BASE_9B = 'http://127.0.0.1:1234/v1';
const BASE_4B = 'http://127.0.0.1:1235/v1';

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
  return Object.keys(provider);
}

// Machine-constraint test: pins THIS dev machine's local fleet configs.
// Auto-skips anywhere those files are absent (CI runners, other machines).
const ON_DEV_MACHINE =
  existsSync(ZCODE_CONFIG) && existsSync(OPENCODE_CONFIG) && existsSync(MSROUTER_ENV);

describe.skipIf(!ON_DEV_MACHINE)('constraint: the 4B on port 1235 is the only local model', () => {
  it('msrouter .env prefers the 4b alias and points at the live llama-server port', () => {
    const env = readFileSync(MSROUTER_ENV, 'utf8');
    expect(env).toMatch(/^LMSTUDIO_ENABLED=true$/m);
    expect(env).toMatch(/^LMSTUDIO_BASE_URL=http:\/\/127\.0\.0\.1:1235\/v1$/m);
    expect(env).toMatch(/^LMSTUDIO_MODEL=qwen3\.5-4b$/m);
    // The retired gemma consolidation must not come back.
    expect(env).not.toMatch(/gemma-4-e4b/i);
  });

  it('opencode exposes only the Qwen3.5 4B on the local llama.cpp provider', () => {
    const cfg = readJson(OPENCODE_CONFIG);
    const providers = cfg['provider'] as Record<string, unknown>;
    // The dead 9B provider (port 1234) and the ollama provider must stay gone.
    expect(Object.keys(providers)).not.toContain('llama.cpp');
    expect(Object.keys(providers)).not.toContain('ollama');

    const llama4b = providers['llama.cpp-4b'] as {
      options?: { baseURL?: string };
      models?: Record<string, unknown>;
    };
    expect(llama4b.options?.baseURL).toBe(BASE_4B);
    expect(Object.keys(llama4b.models ?? {})).toEqual([QWEN_4B]);
  });

  it('opencode local model exposes a 128k context limit (4B server cap)', () => {
    const cfg = readJson(OPENCODE_CONFIG);
    const providers = cfg['provider'] as Record<string, unknown>;
    const llama4b = providers['llama.cpp-4b'] as {
      models?: Record<string, { limit?: { context?: number } }>;
    };
    expect(llama4b.models?.[QWEN_4B]?.limit?.context).toBe(131072);
  });

  it('no config advertises the retired 9B or ollama endpoints', () => {
    for (const url of [OPENCODE_CONFIG, ZCODE_CONFIG]) {
      const raw = readFileSync(url, 'utf8');
      expect(raw).not.toContain('11434');
      expect(raw).not.toContain(BASE_9B);
      expect(raw).not.toContain(QWEN_9B);
    }
  });
});

describe.skipIf(!ON_DEV_MACHINE)(
  'constraint: zcode models config keeps the remote custom providers',
  () => {
    // The Aug 2026 corruption wiped custom providers; these are the load-bearing
    // ones present in the live config. (The OpenAI gpt-5.5 and Gemini provider
    // ids from the earlier revision were removed from the config later and are
    // no longer pinned.)
    const REQUIRED_PROVIDERS = [
      'ab7e04f9-8a56-4473-b5bb-996b1a17df85', // OpenRouter
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

    it('ships the OpenCode provider with its base URL and model pool', () => {
      const cfg = readJson(ZCODE_CONFIG);
      const p = (cfg['provider'] as Record<string, unknown>)[
        '68c67047-dc84-4e0f-80c8-b0743d2150ef'
      ] as {
        options?: { baseURL?: string };
        models?: Record<string, unknown>;
      };
      expect(p.options?.baseURL).toBe('https://opencode.ai/zen/v1');
      expect(Object.keys(p.models ?? {})).toContain('big-pickle');
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
  },
);

describe.skipIf(!ON_DEV_MACHINE)(
  'constraint: zcode local model is the 4B on 127.0.0.1:1235',
  () => {
    function localProviderByBase(
      baseURL: string,
    ): { models?: Record<string, unknown> } | undefined {
      const cfg = readJson(ZCODE_CONFIG);
      const providers = cfg['provider'] as Record<string, unknown>;
      return Object.values(providers).find(
        (p) => (p as { options?: { baseURL?: string } }).options?.baseURL === baseURL,
      ) as { models?: Record<string, unknown> } | undefined;
    }

    it('serves the 4B on 127.0.0.1:1235 with a 128k context', () => {
      const local = localProviderByBase(BASE_4B);
      expect(local).toBeDefined();
      expect(Object.keys(local?.models ?? {})).toEqual([QWEN_4B]);
      const model = (local?.models ?? {})[QWEN_4B] as { limit?: { context?: number } };
      expect(model.limit?.context).toBe(131072);
    });

    it('no longer references ollama or the retired 9B anywhere, and no local gemma models', () => {
      const cfg = readJson(ZCODE_CONFIG);
      const raw = JSON.stringify(cfg);
      expect(raw).not.toContain('localhost:11434');
      expect(raw).not.toContain('qwen3:8b');
      expect(raw).not.toContain(BASE_9B);
      expect(raw).not.toContain(QWEN_9B);
      // Local providers must expose only Qwen3.5 4B (a gemma id may legally
      // remain in zcode.deletedModels tombstones or as a remote model).
      for (const modelId of Object.keys(localProviderByBase(BASE_4B)?.models ?? {})) {
        expect(modelId).toMatch(/^qwen\/qwen3\.5-4b$/);
      }
    });
  },
);
