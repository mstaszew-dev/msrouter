/**
 * Generic demote-to-back queue. The single piece of adaptive-rotation state in
 * msrouter: any item that fails is moved to the tail and stays there for the
 * life of the process. No TTL, no persistence, no cooldown timer. Restart
 * rebuilds the queue from env (original declared order).
 *
 * Extracted from OpenRouterProvider.keyOrder so OpenRouter, OpenCode, and the
 * chain-level inter-provider walk all share one contract and one set of tests.
 *
 * Pure data structure: no I/O. The only side effect is an optional warn log on
 * demote, for observability.
 */

import type { Logger } from 'pino';

export class CandidateQueue<T> {
  private order: T[];

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
    this.opts.log?.warn({ label: this.opts.label ?? 'queue', pos }, 'queue item demoted to back');
  }

  /** Current order, for tests and debug snapshots. */
  snapshot(): readonly T[] {
    return [...this.order];
  }
}
