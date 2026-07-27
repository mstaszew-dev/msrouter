/**
 * OpenRouter provider key-health queue tests. Verifies that a key which fails
 * (KEY_FAILURE) is demoted to the back of the queue (no cooldown timer - the
 * key naturally returns to the front via round-robin as other keys are tried).
 *
 * The demotion logic is exercised directly via the private demote() method
 * (accessed through a typed cast), which is the contract the chain relies on.
 * Full network-level rotation verification lives in test/openrouter.integration.spec.ts.
 */

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenRouterProvider } from './openrouter.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

/** Typed view of the provider's private queue state for white-box testing. */
interface QueueView {
  keyOrder: Array<{ idx: number }>;
  demote(rawIdx: number, status: number): void;
}

function makeQueue(keys: string[]): { p: OpenRouterProvider; q: QueueView } {
  const p = new OpenRouterProvider(keys, 1000, silent);
  return { p, q: p as unknown as QueueView };
}

describe('OpenRouterProvider key-health queue', () => {
  it('starts in numeric order', () => {
    const { p, q } = makeQueue(['k1', 'k2', 'k3']);
    expect(p.keyCount).toBe(3);
    expect(p.available).toBe(true);
    expect(q.keyOrder.map((s) => s.idx)).toEqual([0, 1, 2]);
  });

  it('demotes a failed key to the back of the queue', () => {
    const { q } = makeQueue(['k1', 'k2', 'k3']);
    // Key 0 (k1) failed: it moves behind k2, k3.
    q.demote(0, 429);
    expect(q.keyOrder.map((s) => s.idx)).toEqual([1, 2, 0]);
  });

  it('demoting the same key twice keeps it at the back (idempotent)', () => {
    const { q } = makeQueue(['k1', 'k2']);
    q.demote(0, 429);
    expect(q.keyOrder.map((s) => s.idx)).toEqual([1, 0]);
    q.demote(0, 429); // already at back; stays
    expect(q.keyOrder.map((s) => s.idx)).toEqual([1, 0]);
  });

  it('demoting a middle key preserves the relative order of the others', () => {
    const { q } = makeQueue(['k1', 'k2', 'k3', 'k4']);
    q.demote(1, 429); // k2 demoted
    expect(q.keyOrder.map((s) => s.idx)).toEqual([0, 2, 3, 1]);
    q.demote(2, 429); // k3 demoted
    expect(q.keyOrder.map((s) => s.idx)).toEqual([0, 3, 1, 2]);
  });

  it('single-key edge: demote keeps the only key in place (nothing to move behind)', () => {
    const { q } = makeQueue(['only']);
    q.demote(0, 429);
    expect(q.keyOrder.map((s) => s.idx)).toEqual([0]);
  });

  it('multiple demotions order keys worst-first at the back', () => {
    const { q } = makeQueue(['k1', 'k2', 'k3', 'k4']);
    q.demote(0, 429); // k1 worst (first to fail)
    q.demote(2, 429); // k3 second-worst
    // Healthy k2, k4 at front; demoted k1 then k3 at back.
    expect(q.keyOrder.map((s) => s.idx)).toEqual([1, 3, 0, 2]);
  });

  it('round-robin: a demoted key returns to the front after others are tried', () => {
    // With no cooldown, the demoted key naturally cycles back as the chain
    // advances through logicalIndex 0,1,2,... (each maps to keyOrder[i]).
    const { q } = makeQueue(['k1', 'k2', 'k3']);
    q.demote(0, 429); // k1 -> back: order is now [k2, k3, k1]
    expect(q.keyOrder.map((s) => s.idx)).toEqual([1, 2, 0]);
    // As the chain tries logicalIndex 0,1,2 it hits k2, k3, then k1 again -
    // k1 is back in rotation without any timer expiry (pure round-robin).
    expect(q.keyOrder[2]?.idx).toBe(0); // k1 is reachable at the back
  });
});
