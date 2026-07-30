/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 *
 * OpenCode is a pooled provider (OPENCODE_KEY1..N) with one routing entry per
 * (model, key) triple. All OpenCode model variants live on this one provider.
 */

import type { Logger } from 'pino';

import { config } from '../config/env.js';

import { OpenCodeProvider } from './opencode.js';
import { OpenRouterProvider } from './openrouter.js';
import { SingleKeyProvider } from './single-key.js';

export interface Providers {
  openrouter: OpenRouterProvider;
  openai: SingleKeyProvider;
  zai: SingleKeyProvider;
  opencode: OpenCodeProvider;
}

/** OpenCode Zen model variants, in preferred order. Order is preserved in the
 *  rotation queue (model-major, key-minor: all keys per model, then next model). */
const OPENCODE_MODELS = (e: {
  OPENCODE_MODEL: string;
  OPENCODE_DEEPSEEK_FLASH_MODEL: string;
  OPENCODE_QWEN_MODEL: string;
  OPENCODE_NEMOTRON_MODEL: string;
}): readonly string[] => [
  e.OPENCODE_MODEL,           // big-pickle (demoted fast if empty)
  e.OPENCODE_DEEPSEEK_FLASH_MODEL,
  e.OPENCODE_QWEN_MODEL,
  e.OPENCODE_NEMOTRON_MODEL,
];

export function buildProviders(log: Logger): Providers {
  const { env, openrouterKeys, opencodeKeys } = config();
  const timeoutMs = env.UPSTREAM_TIMEOUT_MS;

  return {
    openrouter: new OpenRouterProvider(openrouterKeys, timeoutMs, log),
    openai: new SingleKeyProvider(
      {
        id: 'openai',
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        defaultModel: env.OPENAI_MODEL,
      },
      timeoutMs,
      log,
    ),
    zai: new SingleKeyProvider(
      {
        id: 'zai',
        baseUrl: env.ZAI_BASE_URL,
        apiKey: env.ZAI_API_KEY,
        defaultModel: env.ZAI_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencode: new OpenCodeProvider({
      keys: opencodeKeys,
      baseUrl: env.OPENCODE_BASE_URL,
      models: OPENCODE_MODELS(env),
      timeoutMs,
      log,
    }),
  };
}
