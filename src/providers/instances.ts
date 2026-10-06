/** Provider factory: builds the concrete providers from validated env. Keeps
 *  construction in one place so main.ts and tests all wire the same.
 *  (The OpenCode /zen/v1 pooled provider was removed 2026-09-18: every model
 *  403s FreeTierError for non-OpenCode clients; OPENCODEGO /zen/go/v1 stays.) */

import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { config } from '../config/env.js';

import type { Extras } from './extras.js';
import { buildExtras } from './extras.js';
import { LmStudioProvider } from './lmstudio.js';
import { LocalProvider } from './local.js';
import { OpenRouterProvider } from './openrouter.js';
import { SingleKeyProvider } from './single-key.js';

export interface Providers {
  openrouter: OpenRouterProvider;
  openai: SingleKeyProvider;
  zai: SingleKeyProvider;
  /** TokenRouter (tokenrouter.com): OpenAI-compatible single-key aggregator. */ tokenrouter: SingleKeyProvider;
  /** OpenCode Go ("go" endpoint): single-key provider for glm-5.3-flash.
   *  /zen/go/v1 works from any client, unlike the removed /zen/v1 pool. */
  opencodego: SingleKeyProvider;
  /** Extra free-tier single-key providers (2026-09-18): unorouter, groq,
   *  sambanova, mistral, cloudflare. Entries gated on key+model. */
  extras: Extras;
  /** Local (llama-server) provider; always built, only routed when
   *  LOCAL_ENABLED=true (chain-routing gates the entry). */
  local: LocalProvider;
  /** LM Studio (Bionic) local provider; always built, only routed when
   *  LMSTUDIO_ENABLED=true (chain-routing gates the entry). */
  lmstudio: LmStudioProvider;
  /** Laptop slot: tailnet Ollama on the travelmate (Qwen3.5 2B); routed
   *  ABSOLUTE LAST when LAPTOP_ENABLED=true (weakest model in the chain). */
  laptop: LocalProvider;
}

export function buildProviders(log: Logger): Providers {
  const { env, openrouterKeys } = config();
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
    // OpenCode Go: single-key provider (distinct OPENCODEGO_* pool); routed
    // after tokenrouter in chain-routing.ts.
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
    // Extra free-tier providers (unorouter/groq/sambanova/mistral/cloudflare);
    // routed after opencodego, before the local tail (see chain-routing.ts).
    extras: buildExtras(log),
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
      env.FIRST_BYTE_TIMEOUT_MS,
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
    // Laptop slot: the travelmate's tailnet Ollama (Qwen3.5 2B; was the local
    // qwen35-gw 0.8B gateway until 2026-09-27). OpenAI-compatible /v1 via
    // tailnet-only HTTPS, no API key. 100K prompt guard = the server's 131072
    // num_ctx minus output/template/estimator headroom: LARGE contexts are
    // allowed by policy (2026-09-27: a slow answer beats no answer when every
    // remote is down), and cache-warm conversations prefill only their fresh
    // tail so large totals are cheap. Known trade-off: a COLD request with
    // >~4K fresh tokens can crash the server's single-slot runner (measured
    // 2026-09-27; it self-recovers) - accepted rather than fast-failing.
    // reasoning_effort "none" is injected (the 1.9B model's thinking tokens
    // are pure latency at ~8 tok/s decode).
    laptop: new LocalProvider(
      {
        id: 'laptop',
        baseUrl: env.LAPTOP_BASE_URL,
        defaultModel: env.LAPTOP_MODEL,
        // 2026-10-02: the laptop serves qwen35-2b-64k (64K window). Guard =
        // 64K minus generation headroom, not the old 100_000 (which let
        // oversized prompts be left-truncated by the runtime).
        maxPromptTokens: 61_440,
        suppressReasoning: true,
      },
      env.LAPTOP_TIMEOUT_MS,
      log,
      env.FIRST_BYTE_TIMEOUT_MS,
    ),
  };
}
