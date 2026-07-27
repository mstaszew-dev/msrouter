/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 *
 * OpenCode is a pooled provider (OPENCODE_KEY1..N) with one candidate per
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

/** OpenCode Zen model variants, big-pickle first. Order is preserved in the
 *  candidate queue (model-major, key-minor). */
const OPENCODE_MODELS = (e: {
  OPENCODE_MODEL: string;
  OPENCODE_NEMOTRON_MODEL: string;
  OPENCODE_DEEPSEEK_FLASH_MODEL: string;
  OPENCODE_MIMO_MODEL: string;
  OPENCODE_NORTH_MINI_CODE_MODEL: string;
  OPENCODE_LAGUNA_MODEL: string;
  OPENCODE_LING_MODEL: string;
  OPENCODE_QWEN_MODEL: string;
  OPENCODE_MINIMAX_MODEL: string;
}): readonly string[] => [
  e.OPENCODE_MODEL,
  e.OPENCODE_NEMOTRON_MODEL,
  e.OPENCODE_DEEPSEEK_FLASH_MODEL,
  e.OPENCODE_MIMO_MODEL,
  e.OPENCODE_NORTH_MINI_CODE_MODEL,
  e.OPENCODE_LAGUNA_MODEL,
  e.OPENCODE_LING_MODEL,
  e.OPENCODE_QWEN_MODEL,
  e.OPENCODE_MINIMAX_MODEL,
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
