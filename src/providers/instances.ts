/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 *
 * OpenCode is a pooled provider (OPENCODE_KEY1..N) with one routing entry per
 * (model, key) triple. All OpenCode model variants live on this one provider.
 */

import type { Logger } from 'pino';

import { config } from '../config/env.js';

import { LmStudioProvider } from './lmstudio.js';
import { LocalProvider } from './local.js';
import { OpenCodeProvider } from './opencode.js';
import { OpenRouterProvider } from './openrouter.js';
import { SingleKeyProvider } from './single-key.js';

export interface Providers {
  openrouter: OpenRouterProvider;
  openai: SingleKeyProvider;
  zai: SingleKeyProvider;
  /** TokenRouter (tokenrouter.com): OpenAI-compatible single-key aggregator. */
  tokenrouter: SingleKeyProvider;
  opencode: OpenCodeProvider;
  /** Local (llama-server) provider; always built, only routed when
   *  LOCAL_ENABLED=true (chain-routing gates the entry). */
  local: LocalProvider;
  /** LM Studio (Bionic) local provider; always built, only routed when
   *  LMSTUDIO_ENABLED=true (chain-routing gates the entry). */
  lmstudio: LmStudioProvider;
  /** Laptop (tailnet) qwen via Ollama+Tailscale; routed ABSOLUTE LAST when
   *  LAPTOP_ENABLED=true (weakest model in the chain). */
  laptop: LocalProvider;
}

/** OpenCode Zen model variants, ordered by capability (strongest first).
 *  Preferred models come first; weaker free-tier models are last as fallback
 *  so the gateway doesn't stall if all preferred models are demoted.
 *  Order is preserved in the rotation queue (model-major, key-minor).
 *  2026-08-31 catalog reshuffle: qwen3.6-plus/minimax-m3/north-mini-code-free
 *  were removed upstream (paid-only or gone); kimi-k3/gemini-3.7-flash/
 *  grok-4.6/muse-spark-1.2 demand a payment method - never route them. */
const OPENCODE_MODELS = (e: {
  OPENCODE_MODEL: string;
  OPENCODE_MINIMAX_MODEL: string;
  OPENCODE_QWEN_MODEL: string;
  OPENCODE_NEMOTRON_MODEL: string;
  OPENCODE_MIMO_MODEL: string;
  OPENCODE_DEEPSEEK_FLASH_MODEL: string;
  OPENCODE_LAGUNA_MODEL: string;
  OPENCODE_LING_MODEL: string;
}): readonly string[] => [
  e.OPENCODE_MODEL, // big-pickle (fast default, demoted if empty)
  e.OPENCODE_MINIMAX_MODEL, // nemotron-3.5-lightning-free (strongest current all-rounder)
  e.OPENCODE_QWEN_MODEL, // muse-spark-1.2-contributor-free (coding + technical reasoning)
  e.OPENCODE_NEMOTRON_MODEL, // nemotron-3-ultra-free (good coding + technical reasoning)
  e.OPENCODE_MIMO_MODEL, // decent for large-codebase/refactoring
  // Fallback: weaker free-tier models, only reached if all above are demoted
  e.OPENCODE_DEEPSEEK_FLASH_MODEL,
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
    tokenrouter: new SingleKeyProvider(
      {
        id: 'tokenrouter',
        baseUrl: env.TOKENROUTER_BASE_URL,
        apiKey: env.TOKENROUTER_API_KEY,
        defaultModel: env.TOKENROUTER_MODEL,
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
    // Local llama-server: speaks its OpenAI-compatible /v1/chat/completions
    // endpoint (the ollama daemon is NOT in use; llama-server does not implement
    // /api/chat). Routed last when LOCAL_ENABLED=true (see chain-routing.ts) as
    // the always-available fallback when every remote free tier is flapping.
    local: new LocalProvider(
      {
        baseUrl: env.LOCAL_BASE_URL,
        defaultModel: env.LOCAL_MODEL,
      },
      env.LOCAL_TIMEOUT_MS,
      log,
    ),
    // LM Studio (Bionic): OpenAI-compatible local server, no API key needed.
    // Routed when LMSTUDIO_ENABLED=true (see chain-routing.ts). Uses its own
    // timeout: local single-slot prefills can exceed UPSTREAM_TIMEOUT_MS.
    lmstudio: new LmStudioProvider(
      {
        baseUrl: env.LMSTUDIO_BASE_URL,
        defaultModel: env.LMSTUDIO_MODEL,
      },
      env.LMSTUDIO_TIMEOUT_MS,
      log,
    ),
    // Laptop (tailnet) qwen: Ollama behind Tailscale on the user's other
    // machine. OpenAI-compatible /v1, no API key. 32K prompt guard: Ollama's
    // effective context is modest and oversized prompts would truncate there.
    laptop: new LocalProvider(
      {
        id: 'laptop',
        baseUrl: env.LAPTOP_BASE_URL,
        defaultModel: env.LAPTOP_MODEL,
        maxPromptTokens: 32_000,
      },
      timeoutMs,
      log,
    ),
  };
}
