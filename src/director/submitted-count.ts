/**
 * submitted-count.ts: how the Director counts confirmed submissions out of a
 * campaign tracker.json.
 *
 * Split out of observe.ts to keep that module inside its size budget. Pure
 * functions, no I/O.
 *
 * WHY THIS EXISTS (2026-10-04): the Kafka observation reported
 * stats["submitted"], which update_tracker.py only ever INCREMENTS and never
 * recomputes. Any write that rewrote or de-duplicated `applications` stranded
 * that counter above reality (observed drift ~74), which produced an unexplained
 * jump in the observation stream (1655 -> 1725 in one step).
 *
 * THREE DIFFERENT python notions of "submitted" exist, which is why any reported
 * number can disagree with stats["submitted"]:
 *
 *  1. update_tracker.py only increments stats["submitted"] and never recomputes
 *     it, so it drifts upward as records are rewritten or de-duplicated.
 *  2. cleanup_fake_records.py (~line 65) DOES recompute it, but as a RAW ROW
 *     COUNT with no de-duplication, so it double-counts rows inserted by other
 *     tooling (1678 on the live tracker where the distinct count is 1676).
 *
 * This module uses the third notion: distinct application keys, keyed exactly as
 * update_tracker.py's derive_id keys them. Two rows can only collide if they
 * describe the same application, so unique keys = distinct submissions. It is
 * deliberately not "the same as" either python script.
 */

/**
 * Count distinct applications whose status is "submitted".
 *
 * Returns null when there is no applications list at all, so a legacy tracker
 * keeps reporting its own counter instead of silently reading as zero.
 */
export function countConfirmedSubmissions(t: Record<string, unknown>): number | null {
  const apps = t['applications'];
  if (!Array.isArray(apps)) return null;
  const seen = new Set<string>();
  for (const raw of apps) {
    if (raw === null || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    if (a['status'] !== 'submitted') continue;
    seen.add(applicationKey(a));
  }
  return seen.size;
}

/**
 * The dedupe key update_tracker.py uses: `id` when truthy, otherwise
 * `source:sourceJobId` (its derive_id). Mirroring the fallback matters: the live
 * tracker has a submitted record with NO `id` (a 1dea NoFluffJobs entry), and
 * keying on `id` alone would count it separately from what the agent counts.
 */
function applicationKey(a: Record<string, unknown>): string {
  const id = a['id'];
  // python: `if rec.get("id"): return str(rec["id"])` - a TRUTHY check, so 0, ''
  // and false fall through to the source key rather than becoming "0"/"false".
  // Objects are excluded deliberately: python would render a dict repr, which
  // can never correspond to a real key, so the source key is the honest choice.
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'boolean') {
    if (id) return String(id);
  }
  return `${scalar(a['source'])}:${scalar(a['sourceJobId'])}`;
}

/** Only primitives are stringified; an object field would yield "[object Object]". */
function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}
