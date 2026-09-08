/**
 * Generic demote-to-back queue with a 429 cooldown. The adaptive-rotation
 * state in msrouter: any item that fails is moved to the tail, and items
 * that fail with a rate-limit (429) are additionally PARKED - excluded from
 * walks - until their cooldown window expires. No persistence; restart
 * rebuilds the queue from env (original declared order).
 *
 * Used by OpenRouterProvider (key pool), OpenCodeProvider ((model, key)
 * pool), and the chain (inter-provider walk). All three share one contract.
 *
 * Pure data structure: no I/O, no timers. Cooldown expiry is evaluated
 * lazily on read (eligible()); the clock is Date.now().
 */

import type { Logger } from 'pino';

export class RotationQueue<T> {
  private order: T[];
  /** Items parked (rate-limited) until an absolute epoch-ms deadline. */
  private parkedUntil = new Map<T, number>();

  constructor(
    items: readonly T[],
    private readonly opts: { log?: Logger; label?: string } = {},
  ) {
    this.order = [...items];
  }

  get length(): number {
    return this.order.length;
  }

  /** Item at logical (queue) position, wrapping for out-of-range indices. */
  at(logicalIndex: number): T | undefined {
    if (this.order.length === 0) return undefined;
    return this.order[logicalIndex % this.order.length];
  }

  /** Current queue position of `item`, or -1 if absent. */
  indexOf(item: T): number {
    return this.order.indexOf(item);
  }

  /** Move `item` to the tail. Idempotent. Silent no-op if `item` is absent. */
  demote(item: T): void {
    const pos = this.order.indexOf(item);
    if (pos === -1) return;
    if (pos === this.order.length - 1) return; // already at back
    this.order.splice(pos, 1);
    this.order.push(item);
    this.opts.log?.debug({ label: this.opts.label ?? 'queue', pos }, 'queue item demoted to back');
  }

  /**
   * Park `item` for `cooldownMs` (rate-limit cooldown): it stays in the
   * queue but is excluded from eligible() until the window expires. A
   * re-park mid-cooldown restarts the window (the upstream just told us
   * it is still limited). Silent no-op if `item` is absent. Logs only on
   * a NEW park (transition), not on every re-park - a rate-limit storm
   * re-parks ~40 entries per request and that must not flood the log.
   */
  park(item: T, cooldownMs: number, reason?: string): void {
    if (this.order.indexOf(item) === -1) return;
    const existing = this.parkedUntil.get(item);
    const transition = existing === undefined || existing <= Date.now();
    this.parkedUntil.set(item, Date.now() + cooldownMs);
    if (transition) {
      this.opts.log?.info(
        { label: this.opts.label ?? 'queue', cooldownMs, reason: reason ?? 'rate-limited' },
        'queue item parked for cooldown',
      );
    }
  }

  /**
   * Queue order with parked (cooling-down) items filtered out. If EVERYTHING
   * is parked, returns the full order: an all-parked walk must still attempt
   * entries rather than fail with an empty chain (one of them may have
   * recovered, and the laptop/local tail is never rate-limited anyway).
   */
  eligible(): readonly T[] {
    const now = Date.now();
    const live = this.order.filter((item) => {
      const until = this.parkedUntil.get(item);
      if (until === undefined) return true;
      if (until <= now) {
        this.parkedUntil.delete(item); // expired: clean up lazily
        return true;
      }
      return false;
    });
    return live.length > 0 ? live : [...this.order];
  }

  /** Current order, for tests and debug snapshots. */
  snapshot(): readonly T[] {
    return [...this.order];
  }
}
