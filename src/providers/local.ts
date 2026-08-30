/**
 * Local provider (llama-server, OpenAI-compatible).
 *
 * The local model is served by a direct `lama-server` process (build b10333)
 * exposing the Qwen3.5-2B GGUF (native 128K context, DeltaNet hybrid arch)
 * via its OpenAI-compatible /v1/chat/completions endpoint, NOT by the ollama
 * daemon. (The ollama daemon is not running on this machine; llama-server does
 * not implement ollama's native /api/chat or /api/tags, so any /api/chat call
 * 404s.)
 *
 * This provider therefore reuses the shared postChatCompletion helper the
 * remote OpenAI-compatible providers use: it owns URL joining, timeout,
 * header setup, secret scrubbing, empty-completion detection, SSE streaming,
 * and HTTP status classification. The body is passed through verbatim with
 * only `model` rewritten to the chain-resolved id (matching openrouter.ts).
 *
 * A prompt-token guard fast-fails oversized requests BEFORE any network call:
 * a single-slot llama-server processes prompts serially, so a giant prompt
 * (browser snapshots, accumulated history) would block the slot for the whole
 * timeout. Local is routed LAST in the chain (the fallback when every remote
 * provider is flapping), so a guard rejection lets the chain answer from the
 * remote providers it already tried - it never burns the slot on a prompt
 * that cannot fit the model's 128K context window.
 */
import type { Logger } from 'pino';

import { postChatCompletion } from './fetch.js';
import type {
  AttemptOptions,
  ChatRequestBody,
  Provider,
  ProviderCallResult,
} from './types.js';

/**
 * Prompt-token ceiling for local. The Qwen3.5-2B GGUF supports up to 128K
 * context natively. The guard admits prompts that fit the model's window;
 * larger prompts fast-fail so the chain answers from remote providers instead
 * of burning the slow single-slot llama-server on a prompt that cannot fit.
 */
const LOCAL_MAX_PROMPT_TOKENS = 128_000;

/** Rough prompt-token estimate (chars/4 + per-message overhead), matching the
 *  campaign agent's own estimate so the guard is consistent with what the
 *  client believes it is sending. Includes tool definitions which can add
 *  2-5K tokens for function-calling setups. */
function estimatePromptTokens(messages: unknown[], tools?: unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    const content = msg.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          chars += ((part as Record<string, unknown>).text as string).length;
        }
      }
    }
    chars += 10;
  }
  if (Array.isArray(tools)) {
    for (const t of tools) {
      chars += JSON.stringify(t).length;
    }
  }
  return Math.floor(chars / 4);
}

export interface LocalConfig {
  baseUrl: string;
  defaultModel: string;
  /** Provider id / chain lookup key. Defaults to 'local' (llama-server);
   *  secondary instances use their own id (e.g. 'laptop'). */
  id?: string;
  /** Prompt-token ceiling for the guard. Defaults to 128K (local GGUF);
   *  smaller-window endpoints pass a lower value. */
  maxPromptTokens?: number;
}

export class LocalProvider implements Provider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly maxPromptTokens: number;

  constructor(
    cfg: LocalConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {
    this.id = cfg.id ?? 'local';
    this.baseUrl = cfg.baseUrl;
    this.defaultModel = cfg.defaultModel;
    this.maxPromptTokens = cfg.maxPromptTokens ?? LOCAL_MAX_PROMPT_TOKENS;
  }

  /** Always available when the entry is routed (chain-routing gates on
   *  LOCAL_ENABLED); an unreachable llama-server fails attempts as TRANSIENT. */
  get available(): boolean {
    return true;
  }

  /** The model used when the client sent an alias. */
  get resolvedDefaultModel(): string {
    return this.defaultModel;
  }

  async attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: AttemptOptions,
  ): Promise<ProviderCallResult> {
    const promptTokens = estimatePromptTokens(
      Array.isArray(body.messages) ? body.messages : [],
      Array.isArray(body.tools) ? body.tools : undefined,
    );
    if (promptTokens > this.maxPromptTokens) {
      return {
        kind: 'BAD_REQUEST',
        status: 400,
        message: `${this.id}: prompt ~${promptTokens} tokens exceeds model context window (max ${this.maxPromptTokens}); use a remote provider`,
      };
    }
    // Verbatim passthrough: only rewrite model to the chain-resolved id. The
    // rest of the body (messages, stream, tools, temperature, max_tokens) is
    // already OpenAI-shaped, which llama-server's /v1 endpoint accepts.
    const outbound: ChatRequestBody = { ...body, model: opts.model };
    this.log.debug({ provider: this.id, model: opts.model }, 'local attempt');

    // llama-server ignores Authorization, but UpstreamOptions.authorization is
    // a required header value, so send a harmless placeholder. No real key.
    return postChatCompletion(outbound, {
      baseUrl: this.baseUrl,
      authorization: `Bearer ${this.id}`,
      signal,
      timeoutMs: this.timeoutMs,
      keyTag: this.id,
    });
  }
}
