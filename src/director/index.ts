/**
 * Public exports for the Director agent module.
 */

export { DirectorLoop } from './loop.js';
export type { DirectorLoopOpts } from './loop.js';
export { NullSurface } from './surface.js';
export type { SurfaceOpts } from './surface.js';
export { RagClient } from './rag.js';
export type { RagClientOpts, RagResult } from './rag.js';
export { observe, parseEventsLine } from './observe.js';
export type { ObserveOptions } from './observe.js';
export { classify } from './classify.js';
export { propose, parseProposeResponse } from './propose.js';
export type { ProposeContext } from './propose.js';
export { applyPatch, readOverrides, serializeOverrides } from './apply.js';
export {
  detectWorker,
  snapshot as snapshotWorker,
  stopWorker,
  startWorker,
  waitForStartup,
  pollCdp,
  restartWorker,
} from './restart.js';
export type { SuperviseOpts, SuperviseState } from './restart.js';
export { appendLedger, readLedger, readPending } from './ledger.js';
export type {
  CampaignSnapshot,
  TrackerSummary,
  CampaignEvent,
  DecisionClassification,
  Patch,
  PatchDecision,
  LedgerEntry,
  DirectorSurface,
  DirectorRunResult,
  Checkpoint,
} from './types.js';
