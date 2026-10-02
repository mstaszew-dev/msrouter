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

/** Providers whose failures are entry-scoped (per-key quotas), not
 *  account-scoped: propagation and mid-walk skipping stay entry-level. */
const ENTRY_LEVEL_FAILURE: ReadonlySet<string> = new Set(['openrouter']);

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
    if (ENTRY_LEVEL_FAILURE.has(entry.provider)) return; // per-key: siblings stay
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
  if (ENTRY_LEVEL_FAILURE.has(entry.provider)) {
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
  dispatchedModel: string,
  log: { warn: (o: object, msg: string) => void; debug: (o: object, msg: string) => void },
): number {
  let demoted = 0;
  if (res.kind === 'KEY_FAILURE' && demoteOnKeyFailure) {
    demoted += providerAxisSize(queue, entry);
    if (res.status === 429 && env().RATE_LIMIT_COOLDOWN_MS > 0) {
      propagateProviderAxis(queue, entry, { parkMs: env().RATE_LIMIT_COOLDOWN_MS });
    } else {
      propagateProviderAxis(queue, entry, 'demote');
    }
  }
  // Model axis only when the DISPATCHED model is the entry's declared one:
  // on explicit-model walks every entry gets the requested model, and a 404
  // there must not demote healthy providers' declared axes (2026-10-01).
  if (res.kind === 'BAD_REQUEST' && isWalk && dispatchedModel === entry.model) {
    demoteModelAxis(queue, entry);
    demoted += 1;
  }
  if (demoted > 0) {
    log.warn(
      { provider: entry.label, label: 'chain', kind: res.kind, status: res.status, demoted },
      'chain entry demoted to back of queue',
    );
  } else if (res.kind !== 'BAD_REQUEST') {
    log.debug(
      { provider: entry.label, label: 'chain', kind: res.kind, status: res.status },
      'chain entry skipped (transient retries exhausted)',
    );
  }
  return demoted;
}

/** Entries on the indicted provider axis (1 for entry-level providers). */
function providerAxisSize(queue: RotationQueue<RoutingEntry>, entry: RoutingEntry): number {
  if (ENTRY_LEVEL_FAILURE.has(entry.provider)) return 1;
  return queue.snapshot().filter((e) => e.provider === entry.provider).length;
}
