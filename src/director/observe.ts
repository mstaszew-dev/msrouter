/**
 * observe.ts: read campaign state into a CampaignSnapshot. Pure data shaping;
 * no LLM, no mutations. Reads:
 *   - tracker.json (summary fields only)
 *   - events.jsonl (tail from checkpoint.eventsReadOffset)
 *   - tick_status.sh (best-effort; falls back to empty string if absent)
 *
 * Returns the new checkpoint (byte offset advanced past the bytes consumed).
 *
 * Partial-line handling: if the read buffer ends mid-record (no trailing
 * newline), we drop the trailing partial and do NOT advance past it, so the
 * next call re-reads it once the file has more bytes.
 */

import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { countConfirmedSubmissions } from './submitted-count.js';
import type { CampaignEvent, CampaignSnapshot, Checkpoint, TrackerSummary } from './types.js';

export { countConfirmedSubmissions } from './submitted-count.js';

const execFileP = promisify(execFile);

export interface ObserveOptions {
  campaignDir: string;
  /** Cap on events returned per call (safety; default 500). */
  maxEvents?: number;
}

/** Parse one events.jsonl line into a CampaignEvent, or null if invalid. */
export function parseEventsLine(line: string): CampaignEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['at'] !== 'string' || typeof obj['action'] !== 'string') return null;
  if (!obj['record'] || typeof obj['record'] !== 'object') return null;
  return {
    at: obj['at'],
    action: obj['action'],
    record: obj['record'] as Record<string, unknown>,
  };
}

export async function observe(
  checkpoint: Checkpoint,
  opts: ObserveOptions,
): Promise<{ snapshot: CampaignSnapshot; checkpoint: Checkpoint }> {
  const tracker = await readTrackerSummary(opts.campaignDir);
  const { events, newOffset } = await tailEvents(
    join(opts.campaignDir, 'events.jsonl'),
    checkpoint.eventsReadOffset,
    opts.maxEvents ?? 500,
  );
  const tickStatus = await runTickStatus(opts.campaignDir).catch(() => '');
  return {
    snapshot: { fetchedAt: new Date().toISOString(), tracker, recentEvents: events, tickStatus },
    checkpoint: { eventsReadOffset: newOffset, lastTickAt: new Date().toISOString() },
  };
}

/**
 * Has the campaign reached its target? Delegates to TrackerSummary.complete,
 * which is true when EITHER the agent's own stats counter or the derived count
 * reaches a positive target - deliberately not `submitted >= target` alone.
 *
 * That OR is load-bearing. The derived count is lower than stats["submitted"]
 * whenever the legacy counter has drifted (observed ~74), so a derived-only
 * check would place a finished campaign in a band where the agent has printed
 * "CAMPAIGN COMPLETE" and exited but the Director believes it is still running,
 * respawning the worker every tick, rotating the VPN and flagging it stale
 * forever (the 2026-09-01 / 2026-09-09 incidents).
 *
 * Returns false when target is 0/missing (so a fresh tracker is never mistaken
 * for a finished campaign), when the tracker is missing, or when it is
 * unparseable. Never throws - callers (the Director spawn guard) need a safe
 * default that keeps the campaign running.
 */
export async function isCampaignComplete(campaignDir: string): Promise<boolean> {
  let tracker: TrackerSummary;
  try {
    tracker = await readTrackerSummary(campaignDir);
  } catch {
    return false;
  }
  return tracker.complete;
}

async function readTrackerSummary(campaignDir: string): Promise<TrackerSummary> {
  const raw = await readFile(join(campaignDir, 'tracker.json'), 'utf8');
  const t = JSON.parse(raw) as Record<string, unknown>;
  const stats = (t['stats'] as Record<string, number> | undefined) ?? {};
  const lastApplied = t['lastApplied'] as
    { source?: string; company?: string; roleTitle?: string; status?: string } | undefined;
  // Legacy counter, kept for visibility: it is what the campaign's own
  // tick_status.sh prints, so the gap between the two is worth surfacing rather
  // than hiding behind whichever one happens to be right today.
  const statsSubmitted = stats['submitted'] ?? (t['submittedCount'] as number | undefined) ?? 0;
  const derived = countConfirmedSubmissions(t);
  const submitted = derived ?? statsSubmitted;
  const target =
    (t['targetApplications'] as number | undefined) ?? (t['target'] as number | undefined) ?? 0;
  // Completion follows the AGENT's declaration (stats["submitted"] >= target, as
  // update_tracker.py prints CAMPAIGN COMPLETE) OR the derived count reaching it.
  // Using only the derived count would strand a finished campaign in a band of
  // `statsSubmitted >= target > submitted`, respawning the worker every tick.
  const complete = target > 0 && (statsSubmitted >= target || submitted >= target);
  return {
    submitted,
    statsSubmitted,
    drift: statsSubmitted - submitted,
    complete,
    attempted: Array.isArray(t['applications'])
      ? (t['applications'] as unknown[]).filter(
          (raw) =>
            raw !== null &&
            typeof raw === 'object' &&
            (raw as Record<string, unknown>)['status'] === 'attempted',
        ).length
      : 0,
    target,
    lastApplied: lastApplied?.company
      ? {
          source: lastApplied.source ?? '',
          company: lastApplied.company,
          roleTitle: lastApplied.roleTitle ?? '',
          at: (t['updatedAt'] as string | undefined) ?? '',
        }
      : undefined,
    updatedAt: (t['updatedAt'] as string | undefined) ?? '',
  };
}

async function tailEvents(
  path: string,
  offset: number,
  max: number,
): Promise<{ events: CampaignEvent[]; newOffset: number }> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { events: [], newOffset: offset };
  }
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= offset) return { events: [], newOffset: offset };
    const len = size - offset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, offset);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    // If the file ends without a trailing newline, the last element is a
    // partial record (or empty). Drop it from this batch and rewind offset.
    let consumedText = text;
    if (!text.endsWith('\n')) {
      const partial = lines[lines.length - 1] ?? '';
      consumedText = text.slice(0, text.length - partial.length);
    }
    const events: CampaignEvent[] = [];
    for (const line of consumedText.split('\n')) {
      if (events.length >= max) break;
      const e = parseEventsLine(line);
      if (e) events.push(e);
    }
    return { events, newOffset: offset + Buffer.byteLength(consumedText, 'utf8') };
  } finally {
    await handle.close();
  }
}

async function runTickStatus(campaignDir: string): Promise<string> {
  try {
    const { stdout } = await execFileP('sh', [join(campaignDir, 'tick_status.sh')], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}
