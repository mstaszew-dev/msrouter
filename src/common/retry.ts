/**
 * Retry helpers + transient-error predicates. The error-classification regexes
 * are adapted from joblooper's proven patterns; they decide whether an upstream
 * failure is retryable (transient) vs terminal (per-key or bad-request).
 *
 * See NODEJS_CODE_REVIEW.md section 3 (timeouts/retries/backoff).
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Jittered exponential backoff: `base * 2^attempt` +/- 25%, capped at max. */
export function backoffMs(attempt: number, base: number, max = 30_000): number {
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = exp * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/** HTTP statuses OpenRouter/OpenAI treat as transient (retryable). */
export const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
/**
 * HTTP statuses that mean the KEY is bad/rate-limited (rotate to next key).
 * 429 is classified as a key failure so the chain rotates rather than hammering
 * the same throttled key.
 */
export const KEY_FAILURE_STATUSES = new Set([401, 402, 403, 429]);
/** HTTP statuses that mean the REQUEST itself is invalid (do not rotate). */
export const BAD_REQUEST_STATUSES = new Set([400, 404, 405, 422]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}
export function isKeyFailureStatus(status: number): boolean {
  return KEY_FAILURE_STATUSES.has(status);
}
export function isBadRequestStatus(status: number): boolean {
  return BAD_REQUEST_STATUSES.has(status);
}

/**
 * Note on 429: it sits in BOTH transient and (for OpenRouter) per-key-rotation
 * buckets. The provider layer classifies it as KEY_FAILURE so the chain rotates
 * to the next key/provider rather than hammering the same one; the chain may
 * still loop back with a backoff if everything 429s.
 */

/** Message-based transient detection for fetch/network errors (no status code). */
export function isTransientMessage(msg: string): boolean {
  return /rate limit|429|timeout|timed out|network|fetch failed|econn|temporarily unavailable|overloaded|too many requests|service unavailable|socket hang up|aborted/i.test(
    msg,
  );
}
