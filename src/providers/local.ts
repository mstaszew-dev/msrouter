/**
 * Local provider (llama-server, OpenAI-compatible).
 *
 * The local model is served by a direct `llama-server` process (build b10298)
 * exposing a patched 128K-context qwen2.5:1.5b GGUF via its OpenAI-compatible
 * /v1/chat/completions endpoint, NOT by the ollama daemon. (The ollama daemon
 * is not running on this machine; llama-server does not implement ollama's
 * native /api/chat or /api/tags, so any /api/chat call 404s.)
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
 * that cannot fit the attempt window.
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
 * Prompt-token ceiling for local. Sized to the local attempt window: msrouter
 * allows local up to 300s (LOCAL_TIMEOUT_MS, matched by the campaign agent's
 * 300s client cap), so the guard admits only prompts that fit that window.
 * The chars/4 heuristic overestimates real tokens ~1.6x, so a 50k estimate is
 * ~31k real tokens: prefill at the slowest observed 220 tok/s is ~142s, plus
 * a full 4096-token generation at ~38 tok/s decode is ~108s - about 250s,
 * inside 300s. Larger prompts fast-fail so the chain answers from the remote
 * providers it already tried, instead of burning the slot.
 */
const LOCAL_MAX_PROMPT_TOKENS = 50_000;

/** Rough prompt-token estimate (chars/4 + per-message overhead), matching the
 *  campaign agent's own estimate so the guard is consistent with what the
 *  client believes it is sending. */
function estimatePromptTokens(messages: unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    const content = msg.content;
    chars += typeof content === 'string' ? content.length : 0;
    chars += 10;
  }
  return Math.floor(chars / 4);
}

export interface LocalConfig {
  baseUrl: string;
  defaultModel: string;
}

export class LocalProvider implements Provider {
  readonly id = 'local';
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(
    cfg: LocalConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {
    this.baseUrl = cfg.baseUrl;
    this.defaultModel = cfg.defaultModel;
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
    const promptTokens = estimatePromptTokens(Array.isArray(body.messages) ? body.messages : []);
    if (promptTokens > LOCAL_MAX_PROMPT_TOKENS) {
      return {
        kind: 'BAD_REQUEST',
        status: 400,
        message: `local: prompt ~${promptTokens} tokens exceeds the 300s local budget (max ${LOCAL_MAX_PROMPT_TOKENS}); use a remote provider`,
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
      authorization: 'Bearer local',
      signal,
      timeoutMs: this.timeoutMs,
      keyTag: 'local',
    });
  }
}
