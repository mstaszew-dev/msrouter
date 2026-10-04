/**
 * Shared Director agent types. Imported by every submodule so the shapes stay
 * consistent across observe / classify / propose / apply / restart / surface /
 * ledger / loop. Pure type exports; no runtime code.
 */

export interface CampaignSnapshot {
  fetchedAt: string; // ISO 8601
  tracker: TrackerSummary;
  recentEvents: CampaignEvent[]; // events since last checkpoint
  tickStatus: string; // raw stdout of tick_status.sh
}

export interface TrackerSummary {
  /**
   * Confirmed submissions, derived from `applications` (unique ids whose status
   * is "submitted") so this number cannot drift away from what the python agent
   * actually recorded. Falls back to the legacy counter on trackers that carry
   * no applications list.
   */
  submitted: number;
  /**
   * The legacy stats["submitted"] counter as written by update_tracker.py, which
   * only ever increments and never recomputes. Reported alongside so the gap is
   * visible rather than silently resolving to whichever number looks nicer.
   */
  statsSubmitted: number;
  /** statsSubmitted - submitted. Non-zero means the legacy counter is stranded. */
  drift: number;
  /**
   * Has the campaign declared itself finished? Decided the way the python agent
   * decides: EITHER count reaching target.
   *
   * This must NOT be derived from `submitted` alone. update_tracker.py prints
   * "CAMPAIGN COMPLETE" off stats["submitted"] (update_tracker.py ~line 284), so
   * with a non-zero drift there is a band where the agent has stopped but a
   * derived-only check would say the campaign is still running - which respawns
   * the worker every tick, rotates the VPN and flags the campaign stale forever
   * (the 2026-09-01 / 2026-09-09 incidents). Either signal counts as complete.
   */
  complete: boolean;
  /** Applications recorded as attempted (a submission with no portal confirmation). */
  attempted: number;
  target: number;
  lastApplied?: { source: string; company: string; roleTitle: string; at: string };
  updatedAt: string;
}

export interface CampaignEvent {
  at: string;
  /** Free-form action tag; the campaign uses a small known set but new ones
   *  appear over time, so this is open-ended. See AGENT_TICK.md for the set. */
  action: string;
  record: Record<string, unknown>;
}

export interface DecisionClassification {
  eventId?: string; // for skipped/submitted events with an id
  kind:
    'good-apply' | 'risky-apply' | 'missed-apply' | 'bad-skip' | 'duplicate-risk' | 'portal-error' | 'stale-campaign';
  severity: 'info' | 'warn' | 'critical';
  reason: string; // human-readable, for the LLM and ledger
  evidence?: string; // the field/value that triggered it
}

export interface Patch {
  id: string; // uuid
  createdAt: string; // ISO 8601
  overrides: Record<string, string>; // KEY=VALUE pairs to write to director-overrides.env
  rationale: string; // why
  risk: 'low' | 'medium' | 'high';
  classifications: string[]; // ids of the DecisionClassifications that motivated it
}

export interface PatchDecision {
  patchId: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
  decidedBy: string; // 'null-surface' | 'slack:<user>' | 'cli:<user>'
  reason?: string;
}

export interface LedgerEntry {
  at: string;
  kind: 'proposed' | 'decided' | 'applied' | 'restart' | 'observation' | 'error';
  patchId?: string;
  decision?: PatchDecision;
  patch?: Patch; // present on 'proposed' entries
  detail?: string;
}

/** A Slack message that failed to send and is awaiting retry. The outbox is a
 *  JSON file next to the ledger so undelivered posts survive process restarts. */
export interface SlackOutboxEntry {
  /** Stable id (crypto.randomUUID) so dedup survives reloads. */
  id: string;
  /** The full message text to post. */
  message: string;
  /** Number of delivery attempts so far (0 = just enqueued). */
  attempts: number;
  /** ISO timestamp of the last failure; set on each failed attempt. */
  lastErrorAt?: string;
  /** Last error message, for logging/diagnostics. */
  lastError?: string;
}

export interface DirectorSurface {
  postProposal(patch: Patch): Promise<void>;
  postDecision(decision: PatchDecision): Promise<void>;
  postApplied(patch: Patch): Promise<void>;
  postObservation(snapshot: {
    submitted: number;
    target: number;
    statsSubmitted?: number;
    drift?: number;
    attempted?: number;
  }): Promise<void>;
  postRestart(detail: { pid: number; logPath: string }): Promise<void>;
  pollSlackMessages(lastTs?: string): Promise<{ decisions: PatchDecision[]; latestTs?: string }>;
  /** Re-attempt all pending outbox messages. Called once at the top of each
   *  Director tick before any new posts. A no-op for surfaces with no outbox
   *  (NullSurface) or no pending entries. Returns the count still pending. */
  flushOutbox(): Promise<number>;
}

export interface DirectorRunResult {
  observed: number; // events seen this run
  classifications: number;
  proposed: number;
  applied: number;
  reason: string;
}

export interface Checkpoint {
  eventsReadOffset: number; // byte offset in events.jsonl
  lastTickAt: string; // ISO 8601
  /** Latest Slack message ts processed (dedup for pollSlackMessages). */
  lastSlackTs?: string;
  /** Last known submitted count (suppresses duplicate observation events). */
  lastSubmitted?: number;
  /** Hash of last proposal's actionable classifications (suppresses duplicate proposals). */
  lastProposalHash?: string;
  /** True when a stale-campaign warning was sent and the campaign is still idle.
   *  Cleared when new events arrive. Prevents re-sending the same warning every tick. */
  staleWarningActive?: boolean;
  /** Hash of the last published observation payload (submitted/target).
   *  Suppresses duplicate observation events while classifications repeat
   *  every tick (e.g. a persistently stale campaign re-classifying hourly). */
  lastObservationHash?: string;
  /** ISO timestamp of last Proton VPN IP rotation. */
  lastVpnRotation?: string;
}
