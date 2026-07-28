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
  submitted: number;
  target: number;
  queueLength: number;
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
    'good-apply' | 'risky-apply' | 'missed-apply' | 'bad-skip' | 'duplicate-risk' | 'portal-error';
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

export interface DirectorSurface {
  postProposal(patch: Patch): Promise<void>;
  postDecision(decision: PatchDecision): Promise<void>;
  postApplied(patch: Patch): Promise<void>;
  postObservation(snapshot: { submitted: number; target: number; queueLength: number }): Promise<void>;
  postRestart(detail: { pid: number; logPath: string }): Promise<void>;
  pollSlackMessages(lastTs?: string): Promise<{ decisions: PatchDecision[]; latestTs?: string }>;
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
  /** Last known queue length (suppresses duplicate observation events). */
  lastQueueLength?: number;
  /** Hash of last proposal's actionable classifications (suppresses duplicate proposals). */
  lastProposalHash?: string;
}
