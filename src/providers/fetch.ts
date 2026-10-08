/**
 * Shared upstream fetch helper used by every provider. Each provider points at
 * its own baseUrl and injects its key as the Authorization header; this helper
 * does the fetch, applies the timeout (AbortSignal), reads the status, and
 * returns a classified ProviderCallResult so the chain can act uniformly.
 *
 * Native fetch + AbortController on every call (NODEJS_CODE_REVIEW.md section 2:
 * timeouts on every outbound I/O).
 */

import { slowUpstreamFetch, type UpstreamFetch } from '../config/http-agent.js';

import { checkStreamContent, isEmptyCompletion } from './stream-check.js';
import type { ProviderCallResult } from './types.js';
import { classifyAttempt, type ChatRequestBody } from './types.js';

/**
 * Transport used for every upstream call. Production binds npm undici's
 * fetch to a shared Agent with the response-header timeout disabled (the
 * tailnet endpoint holds headers back for the whole prefill); see
 * http-agent.ts. Swappable for tests via setPostFetchForTests.
 */
let postFetch: UpstreamFetch = slowUpstreamFetch;

/** Test seam: replace the upstream transport (undefined restores production). */
export function setPostFetchForTests(fn?: UpstreamFetch): void {
  postFetch = fn ?? slowUpstreamFetch;
}

export interface UpstreamOptions {
  baseUrl: string;
  /** Full Authorization header value, e.g. "Bearer sk-...". */
  authorization: string;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
  /** Caller-supplied signal; the helper will ALSO arm a timeout on top of it. */
  signal: AbortSignal;
  timeoutMs: number;
  /**
   * Deadline for the RESPONSE HEADERS, independent of timeoutMs (which covers
   * the whole call). Bounds an upstream that accepts the connection and then
   * sends nothing at all: the laptop tail gave ttfb=0.000s and no response for
   * 300s on a 162KB agent payload, so with only timeoutMs one hung entry held
   * the entire walk (2026-10-06). Omit where headers arrive immediately.
   */
  firstByteTimeoutMs?: number;
  /**
   * Re-home a wrapped success body: when set and the 200 JSON is
   * {"data": { ..OpenAI chat-completion body.. }}, forward the inner object to
   * the client instead of the envelope. Cline (api.cline.bot/api/v1) wraps
   * non-streaming successes this way (verified live 2026-10-08) but streams
   * standard OpenAI chunks; no other upstream needs it.
   */
  unwrapData?: boolean;
  /** Redacted key tag for logging, e.g. "key3:...a1b2" (never the full key). */
  keyTag: string;
}

/**
 * Extract Cline's {"data": { ..OpenAI chat body.. }} inner object, or null.
 * Enabled only when the provider opts in (unwrapData); an absent or shapeless
 * "data" passes through untouched.
 */
function unwrapEnvelopedData(
  json: unknown,
  enabled?: boolean,
): Record<string, unknown> | null {
  if (!enabled || !json || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray((data as { choices?: unknown }).choices)) return null;
  return data as Record<string, unknown>;
}

/**
 * Perform one POST /chat/completions attempt. Returns OK with the streaming
 * Response (streaming callers pipe it; non-streaming callers re-serialize
 * via sendJson), or a classified failure. Never throws -
 * network errors become TRANSIENT.
 */
export async function postChatCompletion(
  body: ChatRequestBody,
  opts: UpstreamOptions,
): Promise<ProviderCallResult> {
  const url = joinUrl(opts.baseUrl, 'chat/completions');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  // First-byte deadline: see UpstreamOptions.firstByteTimeoutMs. Distinguishes
  // "upstream never sent headers" from a mid-stream failure, which the generic
  // fetch-error catch below cannot tell apart.
  let firstByteFired = false;
  const firstByteTimer =
    opts.firstByteTimeoutMs && opts.firstByteTimeoutMs > 0
      ? setTimeout(() => {
          firstByteFired = true;
          ac.abort();
        }, opts.firstByteTimeoutMs)
      : undefined;
  // If the caller's signal aborts, propagate.
  opts.signal.addEventListener('abort', () => ac.abort(), { once: true });

  try {
    const res = await postFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: opts.authorization,
        accept: body.stream ? 'text/event-stream' : 'application/json',
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (firstByteTimer) clearTimeout(firstByteTimer);
    const outcome = classifyAttempt(res.status, `upstream ${res.status}`);
    if (!outcome) {
      if (!body.stream) {
        const text = await safeReadText(res);
        try {
          const json = JSON.parse(text) as { error?: unknown };
          if (json && typeof json === 'object' && 'error' in json && json.error) {
            const errObj = json.error as { message?: string };
            const errMsg =
              typeof json.error === 'string'
                ? json.error
                : errObj.message || JSON.stringify(json.error);
            return {
              kind: 'TRANSIENT',
              status: res.status,
              message: `upstream returned 200 with error: ${truncate(errMsg, 300)}`,
            };
          }
          // Cline envelope (2026-10-08): {"data": { ..OpenAI chat body.. }}.
          // Unwrap BEFORE the empty-content check (a reasoning-only inner body
          // with no content is exactly the empty completion the chain must
          // skip) and rewrite the served body so clients keep the OpenAI
          // shape. The error branch above already caught Cline's error
          // envelope, so a remaining "data" with a choices array is a success
          // wrapper. No other upstream wraps.
          const data = unwrapEnvelopedData(json, opts.unwrapData);
          const effective = data ?? json;
          const servedText = data ? JSON.stringify(data) : text;
          // Detect empty-content responses (e.g. an upstream model reasoning-only model
          // returns HTTP 200 with empty content and finish_reason=length; a
          // thinking model truncated mid-thought also yields content="" +
          // reasoning_content). Either way the caller gets no deliverable.
          // Classify TRANSIENT so the chain skips to the next model instead of
          // returning a useless response to the caller.
          if (isEmptyCompletion(effective)) {
            return {
              kind: 'TRANSIENT',
              status: res.status,
              message: `upstream returned empty completion (model returned no content)`,
            };
          }
          // Rewriting the body under a forwarded envelope's content-length
          // strands any future pipe-style consumer (the reviewer's SHOULD):
          // today's callers all re-serialize via sendJson, but drop the stale
          // header so a verbatim forwarder cannot ship a truncated body.
          const outHeaders = new Headers(res.headers);
          if (data) outHeaders.delete('content-length');
          return {
            kind: 'OK',
            response: new Response(servedText, {
              status: res.status,
              headers: outHeaders,
            }),
          };
        } catch {
          return {
            kind: 'OK',
            response: new Response(text, { status: res.status, headers: res.headers }),
          };
        }
      }
      // Streaming: peek at the first SSE event before forwarding the stream.
      // Models like an upstream model return an SSE stream with no content tokens
      // and finish_reason=length. Detect this upfront so the provider can
      // demote the triple instead of passing an empty stream to the caller.
      const streamResult = await checkStreamContent(res);
      if (!streamResult.ok) {
        return {
          kind: 'KEY_FAILURE',
          status: 200,
          message: streamResult.reason ?? 'stream returned no content',
        };
      }
      return { kind: 'OK', response: streamResult.response };
    }
    // Drain the error body (small) so the message can guide the chain. The body is
    // passed through verbatim: this is a single-user local gateway and the
    // client owns its own secrets.
    const text = await safeReadText(res);
    return { ...outcome, message: outcome.message + (text ? `: ${truncate(text, 300)}` : '') };
  } catch (e) {
    if (firstByteFired) {
      return {
        kind: 'TRANSIENT',
        status: 0,
        message: `fetch error: no response headers within ${opts.firstByteTimeoutMs}ms`,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError from our timeout => transient; caller may retry/backoff.
    return {
      kind: 'TRANSIENT',
      status: 0,
      message: `fetch error: ${truncate(msg, 200)}`,
    };
  } finally {
    clearTimeout(timer);
    if (firstByteTimer) clearTimeout(firstByteTimer);
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suf = suffix.replace(/^\/+/, '');
  // The provider baseUrls already include the API version path (e.g. .../v1 or
  // .../paas/v4), so we append chat/completions directly.
  return `${base}/${suf}`;
}

/**
 * Upstream bodies are forwarded verbatim. Secret redaction used to run here and
 * was removed on 2026-10-03: it ran on the SUCCESS path, so it rewrote real
 * client data. A JustJoin slug containing "sk-" came back to the python agent
 * with its tail replaced by "sk-[REDACTED]" and the agent tried to open the
 * broken URL. On this single-user local gateway the client owns its secrets, so
 * nothing upstream is rewritten.
 */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}
