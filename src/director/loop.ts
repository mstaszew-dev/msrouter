/**
 * loop.ts: DirectorLoop orchestrates one observation cycle. observe -> classify
 * -> (if anything non-info) propose -> surface.postProposal for each -> persist
 * checkpoint. Patches are not applied here; the surface owns approval + apply.
 *
 * Bounded: per-run AbortSignal; never throws (logs and returns a result with
 * reason). Idempotent: a second run with no new events classifies nothing and
 * proposes nothing.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Logger } from 'pino';

import type { Env } from '../config/env.js';
import type { ProviderChain } from '../providers/chain.js';

import { classify } from './classify.js';
import { observe } from './observe.js';
import { propose } from './propose.js';
import { snapshot as snapshotWorker, startWorkerInIterm } from './restart.js';
import type { Checkpoint, DirectorRunResult, DirectorSurface } from './types.js';


export interface DirectorLoopOpts {
  env: Env;
  chain: ProviderChain;
  surface: DirectorSurface;
  log: Logger;
  checkpointPath: string;
}

export class DirectorLoop {
  constructor(private readonly opts: DirectorLoopOpts) {}

  /** Check if the campaign is running and start it via iTerm if not. */
  async ensureCampaignRunning(): Promise<void> {
    const state = snapshotWorker({
      entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
      workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
      cdpUrl: this.opts.env.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
      log: this.opts.log,
      cdpTimeoutMs: this.opts.env.DIRECTOR_CDP_URL ? 30_000 : 5000,
    });
    if (!state.running) {
      this.opts.log.info('Campaign not running; starting via iTerm');
      startWorkerInIterm({
        entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
        workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
        cdpUrl: this.opts.env.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
        log: this.opts.log,
      });
    }
  }

  /**
   * Poll Slack for approve/reject commands and apply approved patches.
   * Tracks latest ts in checkpoint for dedup. Called on each Director tick.
   */
  async pollAndApplyDecisions(checkpoint: Checkpoint): Promise<Checkpoint> {
    const { decisions, latestTs } = await this.opts.surface.pollSlackMessages(checkpoint.lastSlackTs);
    if (latestTs) checkpoint.lastSlackTs = latestTs;
    if (decisions.length === 0) return checkpoint;

    for (const decision of decisions) {
      this.opts.log.info(
        { patchId: decision.patchId, decision: decision.decision },
        'Slack decision received',
      );
      await this.opts.surface.postDecision(decision);
    }
    return checkpoint;
  }

  async runOnce(signal: AbortSignal): Promise<DirectorRunResult> {
    const e = this.opts.env;
    let checkpoint = await this.loadCheckpoint();
    let observed = 0;
    let classificationsCount = 0;
    let proposedCount = 0;

    try {
      // 1. Ensure campaign is running (supervisor)
      await this.ensureCampaignRunning();

      // 2. Observe campaign state
      const { snapshot, checkpoint: next } = await observe(checkpoint, {
        campaignDir: e.DIRECTOR_CAMPAIGN_DIR,
      });
      // Carry over Slack ts from previous checkpoint
      next.lastSlackTs = checkpoint.lastSlackTs;
      checkpoint = next;
      observed = snapshot.recentEvents.length;

      // 3. Classify decisions
      const classifications = classify(snapshot);
      classificationsCount = classifications.length;

      // 4. Propose patches if actionable
      const actionable = classifications.filter((c) => c.severity !== 'info');
      if (actionable.length > 0 && !signal.aborted) {
        const patches = await propose(snapshot, classifications, {
          chain: this.opts.chain,
          overridesPath: e.DIRECTOR_OVERRIDES,
          model: e.DIRECTOR_MODEL || e.WALK_ALIAS[0] || 'mst/free',
          log: this.opts.log,
          signal,
        });
        proposedCount = patches.length;
        for (const p of patches) {
          if (signal.aborted) break;
          await this.opts.surface.postProposal(p);
        }
      }

      // 5. Poll Slack for approve/reject commands (dedup via ts)
      checkpoint = await this.pollAndApplyDecisions(checkpoint);

      await this.saveCheckpoint(checkpoint);
      return {
        observed,
        classifications: classificationsCount,
        proposed: proposedCount,
        applied: 0,
        reason: 'ok',
      };
    } catch (e2) {
      this.opts.log.error(
        { err: e2 instanceof Error ? e2.message : String(e2) },
        'director run failed',
      );
      return {
        observed,
        classifications: classificationsCount,
        proposed: proposedCount,
        applied: 0,
        reason: 'error',
      };
    }
  }

  private async loadCheckpoint(): Promise<Checkpoint> {
    try {
      const raw = await readFile(this.opts.checkpointPath, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return { eventsReadOffset: 0, lastTickAt: '' };
    }
  }

  private async saveCheckpoint(cp: Checkpoint): Promise<void> {
    await mkdir(dirname(this.opts.checkpointPath), { recursive: true });
    await writeFile(this.opts.checkpointPath, JSON.stringify(cp), 'utf8');
  }
}
