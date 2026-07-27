/**
 * surface.ts: NullSurface implements DirectorSurface by writing every event to
 * the ledger and logging it. No external I/O, no auto-apply. P3 swaps in a
 * SlackSurface that ALSO posts to Slack and only applies on user approval.
 *
 * The surface is the runtime approval gate. There is no dry-run flag: a
 * NullSurface IS the pre-Slack state of the world, where every proposal lands
 * in ledger.jsonl and waits for a human (or a future surface) to decide.
 */

import type { Logger } from 'pino';

import { appendLedger } from './ledger.js';
import type { DirectorSurface, Patch, PatchDecision } from './types.js';

export interface SurfaceOpts {
  ledgerPath: string;
  log: Logger;
}

export class NullSurface implements DirectorSurface {
  constructor(private readonly opts: SurfaceOpts) {}

  async postProposal(patch: Patch): Promise<void> {
    await appendLedger(this.opts.ledgerPath, {
      at: new Date().toISOString(),
      kind: 'proposed',
      patchId: patch.id,
      patch,
    });
    this.opts.log.info({ patchId: patch.id, risk: patch.risk }, 'proposal posted (null surface)');
  }

  async postDecision(decision: PatchDecision): Promise<void> {
    await appendLedger(this.opts.ledgerPath, {
      at: new Date().toISOString(),
      kind: 'decided',
      patchId: decision.patchId,
      decision,
    });
    this.opts.log.info(
      { patchId: decision.patchId, decision: decision.decision },
      'decision recorded',
    );
  }

  async postApplied(patch: Patch): Promise<void> {
    await appendLedger(this.opts.ledgerPath, {
      at: new Date().toISOString(),
      kind: 'applied',
      patchId: patch.id,
    });
    this.opts.log.info({ patchId: patch.id }, 'patch applied');
  }

  async postRestart(detail: { pid: number; logPath: string }): Promise<void> {
    await appendLedger(this.opts.ledgerPath, {
      at: new Date().toISOString(),
      kind: 'restart',
      detail: `pid=${detail.pid} log=${detail.logPath}`,
    });
    this.opts.log.info({ pid: detail.pid }, 'worker restart recorded');
  }
}
