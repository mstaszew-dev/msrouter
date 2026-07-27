/**
 * Generic single-key provider for OpenAI-compatible upstreams. OpenAI, ZAI
 * (GLM), and OpenCode Zen all speak the same OpenAI-compatible chat-completions
 * wire format and differ only in (baseUrl, apiKey, defaultModel). This base
 * class factors that out; each provider is a one-line specialization.
 *
 * Model resolution: the chain passes the already-resolved model id; if the
 * client sent an alias, the chain substitutes this provider's default.
 */

import type { Logger } from 'pino';

import { postChatCompletion } from './fetch.js';
import type { AttemptOptions, ChatRequestBody, Provider, ProviderCallResult } from './types.js';

export interface SingleKeyConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  /** Extra headers (e.g. none for OpenAI; OpenCode may add none either). */
  extraHeaders?: Record<string, string>;
}

export class SingleKeyProvider implements Provider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly extraHeaders?: Record<string, string>;

  constructor(
    cfg: SingleKeyConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {
    this.id = cfg.id;
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.defaultModel = cfg.defaultModel;
    this.extraHeaders = cfg.extraHeaders;
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  /** The model this provider uses when the client sent an alias. */
  get resolvedDefaultModel(): string {
    return this.defaultModel;
  }

  async attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: AttemptOptions,
  ): Promise<ProviderCallResult> {
    if (!this.apiKey) {
      return { kind: 'KEY_FAILURE', status: 0, message: `${this.id}: no api key configured` };
    }
    const outbound: ChatRequestBody = { ...body, model: opts.model };
    this.log.debug({ provider: this.id, model: opts.model }, `${this.id} attempt`);
    return postChatCompletion(outbound, {
      baseUrl: this.baseUrl,
      authorization: `Bearer ${this.apiKey}`,
      extraHeaders: this.extraHeaders,
      signal,
      timeoutMs: this.timeoutMs,
      keyTag: `${this.id}`,
    });
  }
}
