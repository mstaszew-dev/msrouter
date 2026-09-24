/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 *
 * OpenCode is a pooled provider (OPENCODE_KEY1..N) with one routing entry per
 * (model, key) triple. All OpenCode model variants live on this one provider.
 */

import { randomUUID } from 'node:crypto';

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
  /** TokenRouter (tokenrouter.com): OpenAI-compatible single-key aggregator. */ tokenrouter: SingleKeyProvider;
  opencode: OpenCodeProvider;
  /** OpenCode Go ("go" endpoint): single-key provider for glm-5.3-flash.
   *  Distinct key pool from OPENCODE_*; routed after the OPENCODE triples. */
  opencodego: SingleKeyProvider;
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

const OPENCODE_MODE_SLOTS: Array<keyof OpenCodeSlotEnv> = [
  'OPENCODE_MODEL', // big-pickle (fast default, demoted if empty)
  'OPENCODE_MINIMAX_MODEL', // nemotron-3.5-lightning-free (strongest current all-rounder)
  'OPENCODE_QWEN_MODEL', // muse-spark-1.2-contributor-free (coding + technical reasoning)
  'OPENCODE_NEMOTRON_MODEL', // nemotron-3-ultra-free (good coding + technical reasoning)
  'OPENCODE_MIMO_MODEL', // decent for large-codebase/refactoring
  // Fallback: weaker free-tier models, only reached if all above are demoted
  'OPENCODE_DEEPSEEK_FLASH_MODEL',
  'OPENCODE_LAGUNA_MODEL',
  'OPENCODE_LING_MODEL',
];

/** The env fields that configure the 8 OpenCode Zen pool slots. */
export interface OpenCodeSlotEnv {
  OPENCODE_MODEL: string;
  OPENCODE_MINIMAX_MODEL: string;
  OPENCODE_QWEN_MODEL: string;
  OPENCODE_NEMOTRON_MODEL: string;
  OPENCODE_MIMO_MODEL: string;
  OPENCODE_DEEPSEEK_FLASH_MODEL: string;
  OPENCODE_LAGUNA_MODEL: string;
  OPENCODE_LING_MODEL: string;
}

/**
 * The live (non-empty) OpenCode pool model ids, strongest first.
 * Empty var = slot removed: a gone model (403/404 upstream, e.g. the
 * nemotron pair's "free tier can only be used from within OpenCode") is
 * retired by setting its env var empty, never by leaving a broken
 * empty-model triple in the queue.
 */
export function opencodePoolModels(e: OpenCodeSlotEnv): readonly string[] {
  return OPENCODE_MODE_SLOTS.map((slot) => e[slot].trim()).filter((m) => m.length > 0);
}

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
        // Thinking is a CLIENT decision: whatever `thinking` field the client
        // sends is forwarded verbatim; the gateway never injects or strips it.
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
      models: opencodePoolModels(env),
      timeoutMs,
      log,
      // The /zen/v1 free tier rejects requests without x-opencode-session
      // (400 MissingSessionID), same contract as /go below: auto-generate a
      // stable per-process id (OPENCODE_SESSION_ID overrides it). One id is
      // shared across the whole pool by design (it identifies the gateway
      // process, not the key); if upstream ever rate-limits per session id,
      // derive per-key ids here (e.g. `${id}-${keyIdx}`) and re-verify.
      extraHeaders: opencodeKeys.length
        ? { 'x-opencode-session': env.OPENCODE_SESSION_ID || randomUUID() }
        : undefined,
    }),
    // OpenCode Go: single-key provider (distinct OPENCODEGO_* pool), routed
    // after the OPENCODE triples in chain-routing.ts (same vendor family).
    // The /go endpoint requires x-opencode-session: the factory auto-generates
    // a stable per-process id (OPENCODEGO_SESSION_ID overrides it).
    opencodego: new SingleKeyProvider(
      {
        id: 'opencodego',
        baseUrl: env.OPENCODEGO_BASE_URL,
        apiKey: env.OPENCODEGO_API_KEY,
        defaultModel: env.OPENCODEGO_MODEL,
        extraHeaders: env.OPENCODEGO_API_KEY
          ? { 'x-opencode-session': env.OPENCODEGO_SESSION_ID || randomUUID() }
          : undefined,
      },
      timeoutMs,
      log,
    ),
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
    // Own local-class timeout (LAPTOP_TIMEOUT_MS): slow single-slot prefills
    // over Tailscale can exceed UPSTREAM_TIMEOUT_MS.
    laptop: new LocalProvider(
      {
        id: 'laptop',
        baseUrl: env.LAPTOP_BASE_URL,
        defaultModel: env.LAPTOP_MODEL,
        maxPromptTokens: 32_000,
      },
      env.LAPTOP_TIMEOUT_MS,
      log,
    ),
  };
}
