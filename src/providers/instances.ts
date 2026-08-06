/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 *
 * OpenCode is a pooled provider (OPENCODE_KEY1..N) with one routing entry per
 * (model, key) triple. All OpenCode model variants live on this one provider.
 */

import type { Logger } from 'pino';

import { config } from '../config/env.js';

import { LocalProvider } from './local.js';
import { OpenCodeProvider } from './opencode.js';
import { OpenRouterProvider } from './openrouter.js';
import { SingleKeyProvider } from './single-key.js';

export interface Providers {
  openrouter: OpenRouterProvider;
  openai: SingleKeyProvider;
  zai: SingleKeyProvider;
  opencode: OpenCodeProvider;
  /** Local (Ollama) provider; always built, only routed when
   *  LOCAL_ENABLED=true (chain-routing gates the entry). */
  local: LocalProvider;
}

/** OpenCode Zen model variants, ordered by capability (strongest first).
 *  Preferred models come first; weaker free-tier models are last as fallback
 *  so the gateway doesn't stall if all preferred models are demoted.
 *  Order is preserved in the rotation queue (model-major, key-minor). */
const OPENCODE_MODELS = (e: {
  OPENCODE_MODEL: string;
  OPENCODE_MINIMAX_MODEL: string;
  OPENCODE_QWEN_MODEL: string;
  OPENCODE_NEMOTRON_MODEL: string;
  OPENCODE_MIMO_MODEL: string;
  OPENCODE_DEEPSEEK_FLASH_MODEL: string;
  OPENCODE_NORTH_MINI_CODE_MODEL: string;
  OPENCODE_LAGUNA_MODEL: string;
  OPENCODE_LING_MODEL: string;
}): readonly string[] => [
  e.OPENCODE_MODEL,           // big-pickle (fast default, demoted if empty)
  e.OPENCODE_MINIMAX_MODEL,   // strongest all-rounder
  e.OPENCODE_QWEN_MODEL,      // good coding + technical reasoning
  e.OPENCODE_NEMOTRON_MODEL,  // good coding + technical reasoning
  e.OPENCODE_MIMO_MODEL,      // decent for large-codebase/refactoring
  // Fallback: weaker free-tier models, only reached if all above are demoted
  e.OPENCODE_DEEPSEEK_FLASH_MODEL,
  e.OPENCODE_NORTH_MINI_CODE_MODEL,
  e.OPENCODE_LAGUNA_MODEL,
  e.OPENCODE_LING_MODEL,
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
    // Local Ollama: speaks ollama's native /api/chat with think:false (the /v1
    // endpoint ignores `think`). Routed last when LOCAL_ENABLED=true (see
    // chain-routing.ts) as the always-available fallback when every remote free
    // tier is flapping.
    local: new LocalProvider(
      {
        baseUrl: env.LOCAL_BASE_URL,
        defaultModel: env.LOCAL_MODEL,
      },
      timeoutMs,
      log,
    ),
  };
}
