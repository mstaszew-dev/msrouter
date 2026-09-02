/**
 * Fixed-window in-memory rate limiter for the login endpoint (brute-force
 * protection). Every attempt - successful or not - counts against the key's
 * current window; when the window rolls over, the counter starts fresh and
 * stale buckets are pruned so memory stays bounded.
 */

interface Bucket {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: { maxAttempts: number; windowMs: number }) {}

  /**
   * Record one attempt for `key` at `nowMs` and report whether it is allowed.
   * Callers must call this for every login attempt, regardless of outcome.
   */
  allow(key: string, nowMs: number = Date.now()): boolean {
    const windowStart = Math.floor(nowMs / this.opts.windowMs) * this.opts.windowMs;
    this.prune(windowStart);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      this.buckets.set(key, { windowStart, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.opts.maxAttempts;
  }

  /** Number of keys with a bucket in the current window (bounded by pruning). */
  size(): number {
    return this.buckets.size;
  }

  private prune(currentWindowStart: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart !== currentWindowStart) {
        this.buckets.delete(key);
      }
    }
  }
}
