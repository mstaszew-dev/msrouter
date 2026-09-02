/**
 * Tests for the fixed-window login rate limiter (brute-force protection,
 * NODEJS_CODE_REVIEW.md section 4). The clock is injectable so tests never
 * sleep and are deterministic.
 */
import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rateLimit.js';

describe('RateLimiter', () => {
  it('allows up to max attempts within the window, then blocks', () => {
    const rl = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rl.allow('demo', t0)).toBe(true);
    }
    expect(rl.allow('demo', t0 + 1000)).toBe(false);
  });

  it('unblocks once the window elapses', () => {
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000 });
    const t0 = 2_000_000;
    expect(rl.allow('demo', t0)).toBe(true);
    expect(rl.allow('demo', t0 + 1)).toBe(true);
    expect(rl.allow('demo', t0 + 2)).toBe(false);
    expect(rl.allow('demo', t0 + 60_000)).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const t0 = 3_000_000;
    expect(rl.allow('demo', t0)).toBe(true);
    expect(rl.allow('demo', t0 + 1)).toBe(false);
    expect(rl.allow('viewer', t0 + 2)).toBe(true);
  });

  it('counts both failed and successful login attempts', () => {
    // The limiter is attempt-counting by design: callers record every login
    // attempt regardless of outcome.
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60_000 });
    const t0 = 4_000_000;
    expect(rl.allow('demo', t0)).toBe(true);
    expect(rl.allow('demo', t0)).toBe(true);
    expect(rl.allow('demo', t0)).toBe(true);
    // 4th attempt (even if it would be correct credentials) is blocked.
    expect(rl.allow('demo', t0)).toBe(false);
  });

  it('does not leak memory across many windows', () => {
    const rl = new RateLimiter({ maxAttempts: 1, windowMs: 1000 });
    for (let w = 0; w < 5000; w++) {
      rl.allow('demo', w * 2000);
    }
    // One entry per live window bucket max; expired buckets are pruned.
    expect(rl.size()).toBeLessThanOrEqual(2);
  });
});
