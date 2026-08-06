/**
 * Local (Ollama) provider.
 *
 * Ollama's OpenAI-compatible /v1 endpoint IGNORES the `think` field (verified
 * on ollama 0.32.5: qwen3 still emits a <think> block and burns ~80s before
 * any content, often finishing length-limited with content=""). So this
 * provider speaks ollama's NATIVE /api/chat instead, forcing think:false
 * (direct answers, no reasoning tokens) and keep_alive:"-1" so the model stays
 * loaded between the campaign agent's bursty calls (a model reload would
 * exceed the agent's request timeout).
 *
 * The response is mapped back to the OpenAI chat-completions shape
 * (choices/message/tool_calls/finish_reason) so the gateway's existing
 * empty-content guard and error handling stay uniform. Non-streaming only:
 * stream:true returns BAD_REQUEST so the chain skips to the next provider
 * instead of hanging.
 */
import type { Logger } from 'pino';

import { scrubSecrets } from './fetch.js';
import { isEmptyCompletion } from './stream-check.js';
import type {
  AttemptOptions,
  ChatRequestBody,
  Provider,
  ProviderCallResult,
} from './types.js';
import { classifyAttempt } from './types.js';

const API_CHAT_PATH = 'api/chat';

/**
 * Prompt-token ceiling for local. qwen3:8b-32k runs at ~80 tok/s prompt
 * processing and ollama processes ONE request per model at a time, so a big
 * prompt (browser snapshots, accumulated history) can take minutes and clog
 * ollama's queue (the campaign agent's own 120s timeout then aborts every
 * attempt). Requests above this estimate are fast-failed to the chain so a
 * remote provider with more context serves them instead. 16k prompt + 4k
 * predict stays well under the 32k context with margin.
 */
const LOCAL_MAX_PROMPT_TOKENS = 16_000;

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

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix}`;
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Map OpenAI-format messages to ollama /api/chat messages. */
function mapMessages(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const msg = m as Record<string, unknown>;
    const out: Record<string, unknown> = { role: msg.role, content: msg.content ?? '' };
    if (msg.role === 'assistant') {
      const tcs = msg.tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        out.tool_calls = tcs.map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = (t.function ?? {}) as Record<string, unknown>;
          return { function: { name: fn.name, arguments: safeJsonParse(fn.arguments) } };
        });
      }
    }
    return out;
  });
}

/** Map an ollama /api/chat response to the OpenAI chat-completions shape. */
function mapOllamaToOpenAi(json: Record<string, unknown>): Record<string, unknown> {
  const msg = (json.message ?? {}) as Record<string, unknown>;
  const rawCalls = msg.tool_calls;
  const toolCalls = Array.isArray(rawCalls)
    ? rawCalls.map((tc, i) => {
        const t = tc as Record<string, unknown>;
        const fn = (t.function ?? {}) as Record<string, unknown>;
        return {
          id: t.id ?? `call_${i}`,
          type: 'function',
          function: { name: fn.name, arguments: JSON.stringify(fn.arguments ?? {}) },
        };
      })
    : undefined;
  const content = typeof msg.content === 'string' ? msg.content : '';
  const doneReason = json.done_reason;
  const finishReason = toolCalls && toolCalls.length > 0 ? 'tool_calls' : doneReason === 'length' ? 'length' : 'stop';
  return {
    id: json.id ?? `local-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: (json.prompt_eval_count as number) ?? 0,
      completion_tokens: (json.eval_count as number) ?? 0,
      total_tokens: ((json.prompt_eval_count as number) ?? 0) + ((json.eval_count as number) ?? 0),
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
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
   *  LOCAL_ENABLED); an unreachable ollama fails attempts as TRANSIENT. */
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
    if (body.stream) {
      return { kind: 'BAD_REQUEST', status: 400, message: 'local: streaming not supported' };
    }
    const promptTokens = estimatePromptTokens(Array.isArray(body.messages) ? body.messages : []);
    if (promptTokens > LOCAL_MAX_PROMPT_TOKENS) {
      return {
        kind: 'BAD_REQUEST',
        status: 400,
        message: `local: prompt ~${promptTokens} tokens exceeds the local 32k budget (max ${LOCAL_MAX_PROMPT_TOKENS}); use a remote provider`,
      };
    }
    const outbound: Record<string, unknown> = {
      model: opts.model,
      messages: mapMessages(Array.isArray(body.messages) ? body.messages : []),
      stream: false,
      think: false,
      // Go duration, NOT "-1" (ollama 0.32.5 rejects "-1": "missing unit in
      // duration"). 30m keeps the model hot across the campaign agent's
      // bursty ticks but frees the ~12GB when idle for longer.
      keep_alive: '30m',
      options: {
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined ? { num_predict: body.max_tokens } : {}),
      },
    };
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      outbound.tools = body.tools;
    }
    this.log.debug({ provider: this.id, model: opts.model }, 'local attempt');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(joinUrl(this.baseUrl, API_CHAT_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outbound),
        signal: ac.signal,
      });
      const outcome = classifyAttempt(res.status, `upstream ${res.status}`);
      if (outcome) {
        let text = '';
        try {
          text = await res.text();
        } catch { /* ignore */ }
        return { ...outcome, message: outcome.message + (text ? `: ${truncate(scrubSecrets(text), 300)}` : '') };
      }
      let json: Record<string, unknown>;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        return { kind: 'TRANSIENT', status: res.status, message: 'local: unparseable response body' };
      }
      const mapped = mapOllamaToOpenAi(json);
      // Mirror fetch.ts: a 200 with empty content and finish_reason !== stop
      // (e.g. qwen3 hit num_predict while thinking) is a useless response.
      if (isEmptyCompletion(mapped)) {
        return { kind: 'TRANSIENT', status: 200, message: 'local: empty completion' };
      }
      return {
        kind: 'OK',
        response: new Response(JSON.stringify(mapped), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      };
    } catch (e) {
      return {
        kind: 'TRANSIENT',
        status: 0,
        message: `fetch error: ${truncate(scrubSecrets(e instanceof Error ? e.message : String(e)), 200)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
