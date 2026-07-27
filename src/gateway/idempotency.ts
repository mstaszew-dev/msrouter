/**
 * Idempotency cache for POST /chat/completions. Honors the Idempotency-Key
 * header so a double-submit returns the identical (non-streaming) response,
 * and concurrent identical keys share ONE upstream call via an in-flight
 * Promise (instead of duplicating work).
 *
 * Bounded to IDEM_MAX_ENTRIES (oldest evicted) so the cache cannot grow
 * unbounded under key flooding. NODEJS_CODE_REVIEW.md section 3 (idempotency)
 * + section 4 (no unbounded state).
 */

import type { ServerResponse } from 'node:http';

import { sendJson } from '../common/http.js';

type IdemEntry =
  | { kind: 'value'; status: number; body: unknown; exp: number }
  | { kind: 'promise'; promise: Promise<{ status: number; body: unknown }>; exp: number };

const idemCache = new Map<string, IdemEntry>();
const IDEM_TTL_MS = 60_000;
const IDEM_MAX_ENTRIES = 1000;

export interface IdemHandle {
  key: string;
  resolve: (v: { status: number; body: unknown }) => void;
  reject: (e: unknown) => void;
}

/**
 * If the key has a live cache entry, serve it (value) or await the in-flight
 * promise, and return true. Returns false when nothing is cached (caller runs
 * a fresh upstream call).
 */
export async function idempotencyHit(idemKey: string, res: ServerResponse): Promise<boolean> {
  const cached = idemCache.get(idemKey);
  if (!cached || cached.exp <= Date.now()) return false;
  if (cached.kind === 'value') {
    sendJson(res, cached.status, cached.body);
    return true;
  }
  try {
    const { status, body } = await cached.promise;
    sendJson(res, status, body);
  } catch {
    return false; // in-flight failed; let the caller run fresh
  }
  return true;
}

/** Set up the in-flight Promise for a non-streaming idempotent request. */
export function beginIdem(
  idemKey: string | undefined,
  stream: boolean | undefined,
): IdemHandle | undefined {
  if (!idemKey || stream) return undefined;
  let resolve!: (v: { status: number; body: unknown }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ status: number; body: unknown }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  idemCache.set(idemKey, { kind: 'promise', promise, exp: Date.now() + IDEM_TTL_MS });
  pruneIdem();
  return { key: idemKey, resolve, reject };
}

/** Resolve the in-flight promise + replace with a resolved value entry. */
export function storeIdemResult(idem: IdemHandle, status: number, body: unknown): void {
  idem.resolve({ status, body });
  idemCache.set(idem.key, { kind: 'value', status, body, exp: Date.now() + IDEM_TTL_MS });
  pruneIdem();
}

/** Drop the entry (on failure / abort) so the next attempt runs fresh. */
export function dropIdem(idemKey: string | undefined): void {
  if (idemKey) idemCache.delete(idemKey);
}

/** Evict the oldest entries when the bounded cache is over capacity. */
function pruneIdem(): void {
  if (idemCache.size <= IDEM_MAX_ENTRIES) return;
  // Map preserves insertion order; drop the first (oldest) entries.
  let toDrop = idemCache.size - IDEM_MAX_ENTRIES;
  for (const k of idemCache.keys()) {
    idemCache.delete(k);
    if (--toDrop <= 0) break;
  }
}
