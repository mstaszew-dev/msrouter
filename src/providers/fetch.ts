/**
 * Shared upstream fetch helper used by every provider. Each provider points at
 * its own baseUrl and injects its key as the Authorization header; this helper
 * does the fetch, applies the timeout (AbortSignal), reads the status, and
 * returns a classified ProviderCallResult so the chain can act uniformly.
 *
 * Native fetch + AbortController on every call (NODEJS_CODE_REVIEW.md section 2:
 * timeouts on every outbound I/O).
 */

import { checkStreamContent, isEmptyCompletion } from './stream-check.js';
import type { ProviderCallResult } from './types.js';
import { classifyAttempt, type ChatRequestBody } from './types.js';

export interface UpstreamOptions {
  baseUrl: string;
  /** Full Authorization header value, e.g. "Bearer sk-...". */
  authorization: string;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
  /** Caller-supplied signal; the helper will ALSO arm a timeout on top of it. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Redacted key tag for logging, e.g. "key3:...a1b2" (never the full key). */
  keyTag: string;
}

/**
 * Perform one POST /chat/completions attempt. Returns OK with the streaming
 * Response (the caller pipes it), or a classified failure. Never throws -
 * network errors become TRANSIENT.
 */
export async function postChatCompletion(
  body: ChatRequestBody,
  opts: UpstreamOptions,
): Promise<ProviderCallResult> {
  const url = joinUrl(opts.baseUrl, 'chat/completions');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  // If the caller's signal aborts, propagate.
  opts.signal.addEventListener('abort', () => ac.abort(), { once: true });

  try {
    const res = await fetch(url, {
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

    const outcome = classifyAttempt(res.status, `upstream ${res.status}`);
    if (!outcome) {
      if (!body.stream) {
        const text = await safeReadText(res);
        const scrubbed = scrubSecrets(text);
        try {
          const json = JSON.parse(scrubbed) as { error?: unknown };
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
          // Detect empty-content responses (e.g. big-pickle reasoning-only model
          // returns HTTP 200 with empty content and finish_reason=length; a
          // thinking model truncated mid-thought also yields content="" +
          // reasoning_content). Either way the caller gets no deliverable.
          // Classify TRANSIENT so the chain skips to the next model instead of
          // returning a useless response to the caller.
          if (isEmptyCompletion(json)) {
            return {
              kind: 'TRANSIENT',
              status: res.status,
              message: `upstream returned empty completion (model returned no content)`,
            };
          }
          return {
            kind: 'OK',
            response: new Response(scrubbed, { status: res.status, headers: res.headers }),
          };
        } catch {
          return {
            kind: 'OK',
            response: new Response(scrubbed, { status: res.status, headers: res.headers }),
          };
        }
      }
      // Streaming: peek at the first SSE event before forwarding the stream.
      // Models like big-pickle return an SSE stream with no content tokens
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
    // Drain the error body (small) so the message can guide the chain. The
    // body is SCRUBBED of secret-shaped strings (sk-..., Bearer ...) because
    // upstream error bodies routinely echo the request key, and this message is
    // logged. NODEJS_CODE_REVIEW.md section 4 (no secrets in logs).
    const text = scrubSecrets(await safeReadText(res));
    return { ...outcome, message: outcome.message + (text ? `: ${truncate(text, 300)}` : '') };
  } catch (e) {
    const msg = scrubSecrets(e instanceof Error ? e.message : String(e));
    // AbortError from our timeout => transient; caller may retry/backoff.
    return {
      kind: 'TRANSIENT',
      status: 0,
      message: `fetch error: ${truncate(msg, 200)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suf = suffix.replace(/^\/+/, '');
  // The provider baseUrls already include the API version path (e.g. .../v1 or
  // .../paas/v4), so we append chat/completions directly.
  return `${base}/${suf}`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Scrub secret-shaped substrings from a string before it is logged or returned.
 * Matches:
 *   - API keys: sk-... and sk-or-... and sk-proj-... (token-looking)
 *   - Bearer tokens: "Bearer <value>"
 *   - OpenRouter keys: sk-or-v1-...
 * Conservative: redacts broadly rather than precisely, since a leaked fragment
 * is worse than an over-redacted log line.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(sk-(?:or-|proj-)?[A-Za-z0-9_\-]{6,})/g, 'sk-[REDACTED]'],
  [/(Bearer\s+[A-Za-z0-9_\-\.=]{4,})/gi, 'Bearer [REDACTED]'],
  [/(eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,})/g, '[REDACTED-JWT]'],
];

export function scrubSecrets(input: string): string {
  let out = input;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}
