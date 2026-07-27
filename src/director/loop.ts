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

  async runOnce(signal: AbortSignal): Promise<DirectorRunResult> {
    const e = this.opts.env;
    const checkpoint = await this.loadCheckpoint();
    let observed = 0;
    let classificationsCount = 0;
    let proposedCount = 0;

    try {
      const { snapshot, checkpoint: next } = await observe(checkpoint, {
        campaignDir: e.DIRECTOR_CAMPAIGN_DIR,
      });
      observed = snapshot.recentEvents.length;
      const classifications = classify(snapshot);
      classificationsCount = classifications.length;

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

      await this.saveCheckpoint(next);
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
