import { describe, expect, it } from 'vitest';

import {
  backoffMs,
  isBadRequestStatus,
  isTransientMessage,
  isTransientStatus,
  isKeyFailureStatus,
} from './retry.js';

describe('retry predicates', () => {
  it('classifies statuses', () => {
    expect(isKeyFailureStatus(401)).toBe(true);
    expect(isKeyFailureStatus(402)).toBe(true);
    expect(isKeyFailureStatus(429)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(200)).toBe(false);
  });

  it('classifies bad-request statuses (terminal, no rotation)', () => {
    expect(isBadRequestStatus(400)).toBe(true);
    expect(isBadRequestStatus(404)).toBe(true);
    expect(isBadRequestStatus(405)).toBe(true);
    expect(isBadRequestStatus(422)).toBe(true);
    expect(isBadRequestStatus(200)).toBe(false);
    expect(isBadRequestStatus(500)).toBe(false);
  });

  it('classifies transient messages', () => {
    expect(isTransientMessage('fetch failed: ECONNRESET')).toBe(true);
    expect(isTransientMessage('rate limit exceeded (429)')).toBe(true);
    expect(isTransientMessage('invalid model')).toBe(false);
  });

  it('backoff grows within the cap and is jittered', () => {
    const a = backoffMs(0, 1000);
    const b = backoffMs(3, 1000);
    expect(a).toBeGreaterThanOrEqual(750);
    expect(a).toBeLessThanOrEqual(1250);
    expect(b).toBeLessThanOrEqual(30_000);
  });
});
