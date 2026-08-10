/**
 * Provider type definitions. A Provider attempts one chat-completions call
 * upstream and returns a discriminated result the chain can act on. The result
 * kinds map directly to the chain's decisions (return / rotate / backoff /
 * reject).
 *
 * All providers speak the OpenAI-compatible wire format (same body, same
 * choices/delta shape), so this interface is uniform across OpenRouter, OpenAI,
 * ZAI, and OpenCode Zen.
 *
 * See NODEJS_CODE_REVIEW.md section 1 (discriminated unions) + section 3
 * (retry classification).
 */

/** The request body, loosely typed (validated at the gateway boundary). */
export interface ChatRequestBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

/** The classification of an upstream attempt (without the OK payload). */
export type AttemptOutcome =
  | { kind: 'KEY_FAILURE'; status: number; message: string }
  | { kind: 'TRANSIENT'; status: number; message: string }
  | { kind: 'BAD_REQUEST'; status: number; message: string }
  | { kind: 'EMPTY'; status: number; message: string };

/** Outcome of a single upstream attempt (OK carries the Response to stream). */
export type ProviderCallResult =
  | { kind: 'OK'; response: Response }
  | ({ kind: 'KEY_FAILURE' | 'TRANSIENT' | 'BAD_REQUEST' | 'EMPTY' } & AttemptOutcome);

/**
 * A Provider is stateless-ish: it knows how to make one attempt for a given
 * body, with a caller-supplied AbortSignal and a model id. The chain passes the
 * resolved model (alias substitution already applied). It does NOT decide retry
 * policy; the chain does.
 */
export interface Provider {
  /** Stable id for logging/metrics, e.g. "openrouter", "openai". */
  readonly id: string;
  /** Whether this provider is configured (has at least one usable key). */
  readonly available: boolean;
  /**
   * Make one upstream attempt. `opts.model` is the resolved model id; pooled
   * providers may also read `opts.keyIndex`. Returns OK with the streaming
   * Response, or a classified failure.
   */
  attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: AttemptOptions,
  ): Promise<ProviderCallResult>;
}

/** Per-attempt options passed from the chain to a provider. */
export interface AttemptOptions {
  /** The resolved model id (alias substitution already applied by the chain). */
  model: string;
  /** OpenRouter: which key index in the pool to use (0-based). */
  keyIndex?: number;
}

/**
 * Classify an HTTP status into an AttemptOutcome (the non-OK branches).
 * Returns null for a successful (2xx) status - the caller wraps the Response
 * into an OK result.
 *
 * Classification (from OpenRouter's documented error codes; OpenAI/ZAI/Zen
 * share the shape):
 *   401/402/403/429 -> KEY_FAILURE (rotate key/provider)
 *   408/425/500/502/503/504 -> TRANSIENT (backoff + retry)
 *   other 4xx -> BAD_REQUEST (reject, do not rotate)
 */
export function classifyAttempt(status: number, message: string): AttemptOutcome | null {
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return { kind: 'KEY_FAILURE', status, message };
  }
  if (
    status === 408 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return { kind: 'TRANSIENT', status, message };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'BAD_REQUEST', status, message };
  }
  if (status < 200 || status >= 300) {
    return { kind: 'TRANSIENT', status, message };
  }
  return null; // 2xx success
}
