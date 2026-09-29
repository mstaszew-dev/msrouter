/**
 * Triple-axis failure propagation (2026-09-18). A chain entry is a
 * (provider, model, key) triple and a failure indicts a whole axis:
 *  - Provider axis: single-key providers share ONE account, so a
 *    KEY_FAILURE (429 rate limit or a bad credential) on any of their
 *    models demotes/parks ALL their entries. OpenRouter is excluded: its
 *    429s are per-key and its internal keyOrder rotation already demotes a
 *    bad key across all models.
 *  - Model axis: BAD_REQUEST (404 model-gone) demotes every key of that
 *    provider+model, so a dead slug costs one attempt per walk, not one
 *    per key.
 */

import { env } from '../config/env.js';

import type { RoutingEntry } from './chain-routing.js';
import { type RotationQueue } from './rotation.js';

/** Mid-walk skip bookkeeping for provider-axis parking: entries parked
 *  DURING a pass (429 propagation) are skipped for the rest of that pass,
 *  while pre-parked entries (the all-parked fallback / remainder retry)
 *  remain fair game. OpenRouter parks per key, so only the failing entry
 *  is skipped there; account-limited providers skip all their entries. */
export class MidWalkParkSkipper {
  private readonly preParked = new Set<RoutingEntry>();
  private readonly skipped = new Set<RoutingEntry>();

  constructor(
    private readonly queue: RotationQueue<RoutingEntry>,
    entries: readonly RoutingEntry[],
  ) {
    for (const e of entries) {
      if (queue.isParked(e)) this.preParked.add(e);
    }
  }

  shouldSkip(entry: RoutingEntry): boolean {
    return this.skipped.has(entry);
  }

  /** Call after a failed attempt: if propagation parked the entry mid-walk,
   *  mark its axis siblings for skipping. */
  onAttemptFailed(entry: RoutingEntry): void {
    if (this.preParked.has(entry) || !this.queue.isParked(entry)) return;
    if (entry.provider === 'openrouter') {
      this.skipped.add(entry);
      return;
    }
    for (const e of this.queue.snapshot()) {
      if (e.provider === entry.provider && !this.preParked.has(e)) this.skipped.add(e);
    }
  }
}

/** Triple-axis failure propagation (2026-09-18): a chain entry is a
 *  (provider, model, key) triple and a failure indicts a whole axis.
 *  - Provider axis (single-key providers share ONE account): demote/park
 *    every entry of that provider. OpenRouter is excluded: its 429s are
 *    per-key and its internal keyOrder rotation already demotes a bad key
 *    across all models.
 *  - Model axis (BAD_REQUEST, e.g. 404 model-gone): demote every key of
 *    that provider+model, so a dead slug stops costing one attempt per key
 *    on every walk. */
export function propagateProviderAxis(
  queue: RotationQueue<RoutingEntry>,
  entry: RoutingEntry,
  action: 'demote' | { parkMs: number },
): void {
  const act = (e: RoutingEntry): void => {
    queue.demote(e);
    if (action !== 'demote') queue.park(e, action.parkMs, `429 (${e.label})`);
  };
  if (entry.provider === 'openrouter') {
    act(entry);
    return;
  }
  for (const e of queue.snapshot()) {
    if (e.provider === entry.provider) act(e);
  }
}

export function demoteModelAxis(queue: RotationQueue<RoutingEntry>, entry: RoutingEntry): void {
  for (const e of queue.snapshot()) {
    if (e.provider === entry.provider && e.model === entry.model) queue.demote(e);
  }
}

/** KEY_FAILURE demotes when configured (walks; direct: pins stay put);
 *  429 additionally parks for RATE_LIMIT_COOLDOWN_MS (a demoted-only entry
 *  is retried on the very next request, which re-hammered the limited pool
 *  per request, 2-8 min walks, 2026-09-08). Non-429 (401/402/403) demotes
 *  only: a bad key is not cooling down. BAD_REQUEST (model-gone) demotes
 *  the model axis on walks so a dead slug costs one attempt per walk. */
export function applyFailureAxes(
  queue: RotationQueue<RoutingEntry>,
  entry: RoutingEntry,
  res: { kind: string; status: number },
  demoteOnKeyFailure: boolean,
  isWalk: boolean,
): void {
  if (res.kind === 'KEY_FAILURE' && demoteOnKeyFailure) {
    if (res.status === 429 && env().RATE_LIMIT_COOLDOWN_MS > 0) {
      propagateProviderAxis(queue, entry, { parkMs: env().RATE_LIMIT_COOLDOWN_MS });
    } else {
      propagateProviderAxis(queue, entry, 'demote');
    }
  }
  if (res.kind === 'BAD_REQUEST' && isWalk) {
    demoteModelAxis(queue, entry);
  }
}
