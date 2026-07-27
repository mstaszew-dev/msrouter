/**
 * Provider factory: builds the concrete providers from validated env. Keeps
 * construction in one place so main.ts / worker.ts and tests all wire the same.
 */

import type { Logger } from 'pino';

import { config } from '../config/env.js';

import { OpenRouterProvider } from './openrouter.js';
import { SingleKeyProvider } from './single-key.js';

export interface Providers {
  openrouter: OpenRouterProvider;
  openai: SingleKeyProvider;
  zai: SingleKeyProvider;
  opencode: SingleKeyProvider;
  opencodeNemotron: SingleKeyProvider;
  opencodeDeepSeekFlash: SingleKeyProvider;
  opencodeMiMo: SingleKeyProvider;
  opencodeNorthMiniCode: SingleKeyProvider;
  opencodeLaguna: SingleKeyProvider;
  opencodeLing: SingleKeyProvider;
  opencodeQwen: SingleKeyProvider;
  opencodeMiniMax: SingleKeyProvider;
}

export function buildProviders(log: Logger): Providers {
  const { env, openrouterKeys } = config();
  const baseUrl = env.OPENCODE_BASE_URL;
  const apiKey = env.OPENCODE_API_KEY;
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
    opencode: new SingleKeyProvider(
      {
        id: 'opencode-bigpickle',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeNemotron: new SingleKeyProvider(
      {
        id: 'opencode-nemotron',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_NEMOTRON_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeDeepSeekFlash: new SingleKeyProvider(
      {
        id: 'opencode-deepseek-flash',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_DEEPSEEK_FLASH_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeMiMo: new SingleKeyProvider(
      {
        id: 'opencode-mimo',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_MIMO_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeNorthMiniCode: new SingleKeyProvider(
      {
        id: 'opencode-north-mini-code',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_NORTH_MINI_CODE_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeLaguna: new SingleKeyProvider(
      {
        id: 'opencode-laguna',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_LAGUNA_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeLing: new SingleKeyProvider(
      {
        id: 'opencode-ling',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_LING_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeQwen: new SingleKeyProvider(
      {
        id: 'opencode-qwen',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_QWEN_MODEL,
      },
      timeoutMs,
      log,
    ),
    opencodeMiniMax: new SingleKeyProvider(
      {
        id: 'opencode-minimax',
        baseUrl,
        apiKey,
        defaultModel: env.OPENCODE_MINIMAX_MODEL,
      },
      timeoutMs,
      log,
    ),
  };
}
