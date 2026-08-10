/**
 * LM Studio (Bionic) local provider.
 *
 * LM Studio exposes an OpenAI-compatible /v1/chat/completions endpoint (default
 * http://127.0.0.1:1234/v1) with NO API key requirement - it accepts and
 * ignores any key. This is a thin specialization of SingleKeyProvider: we pass
 * a placeholder key so `available` and the shared postChatCompletion path work
 * unchanged; the server never validates it.
 */

import type { Logger } from 'pino';

import { SingleKeyProvider } from './single-key.js';

export interface LmStudioConfig {
  baseUrl: string;
  defaultModel: string;
}

/** LM Studio accepts any bearer token; use a fixed placeholder. */
const PLACEHOLDER_KEY = 'lm-studio';

export class LmStudioProvider extends SingleKeyProvider {
  constructor(cfg: LmStudioConfig, timeoutMs: number, log: Logger) {
    super(
      {
        id: 'lmstudio',
        baseUrl: cfg.baseUrl,
        apiKey: PLACEHOLDER_KEY,
        defaultModel: cfg.defaultModel,
      },
      timeoutMs,
      log,
    );
  }
}
