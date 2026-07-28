/**
 * loop.ts: DirectorLoop orchestrates one observation cycle. observe -> classify
 * -> (if anything non-info) propose -> surface.postProposal for each -> persist
 * checkpoint. Patches are not applied here; the surface owns approval + apply.
 *
 * Bounded: per-run AbortSignal; never throws (logs and returns a result with
 * reason). Idempotent: a second run with no new events classifies nothing and
 * proposes nothing.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import type { Env } from '../config/env.js';
import type { ProviderChain } from '../providers/chain.js';

import { runDirectorAgent } from './agent-loop.js';
import { readOverrides, applyPatch } from './apply.js';
import { classify } from './classify.js';
import { kafkaProduce, type KafkaOpts } from './kafka.js';
import { readApprovedPatches, readPending } from './ledger.js';
import { observe } from './observe.js';
import { snapshot as snapshotWorker, startWorkerInIterm } from './restart.js';
import type { Checkpoint, DirectorRunResult, DirectorSurface } from './types.js';
import type { DecisionClassification } from './types.js';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);

function readDirectorPrompt(): string {
  try {
    return readFileSync(join(MODULE_DIR, 'prompt.md'), 'utf8');
  } catch {
    return `You are the Campaign Director. Supervise the campaign. Use tools when needed. Output {"patches":[]} when nothing to propose.`;
  }
}

/** Hash actionable classifications for duplicate-proposal suppression. */
function hashClassifications(classifications: DecisionClassification[]): string {
  const sig = classifications
    .map((c) => `${c.kind}:${c.severity}:${c.evidence ?? c.reason}`)
    .sort()
    .join('|');
  return createHash('md5').update(sig).digest('hex');
}

const execFileP = promisify(execFile);

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}


export interface DirectorLoopOpts {
  env: Env;
  chain: ProviderChain;
  surface: DirectorSurface;
  log: Logger;
  checkpointPath: string;
}

export class DirectorLoop {
  private kafkaOpts: KafkaOpts | undefined;

  constructor(private readonly opts: DirectorLoopOpts) {
    if (opts.env.KAFKA_ENABLED) {
      this.kafkaOpts = {
        kafkaHome: expandTilde(opts.env.KAFKA_HOME),
        bootstrap: opts.env.KAFKA_BOOTSTRAP,
        log: opts.log,
      };
    }
  }

  /** Publish an event to Kafka if enabled. */
  private async publishEvent(key: string, value: string): Promise<void> {
    if (!this.kafkaOpts) return;
    await kafkaProduce('director-events', key, value, this.kafkaOpts);
  }

  /** Rebuild the campaign RAG index after new submissions. */
  private async rebuildRag(): Promise<void> {
    const workspace = this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE;
    const ragDir = join(workspace, 'rag');
    const pythonPath = join(ragDir, '.venv', 'bin', 'python');
    const builder = join(ragDir, 'index_builder.py');
    try {
      this.opts.log.info('Rebuilding campaign RAG index...');
      const { stdout } = await execFileP(pythonPath, [builder], {
        cwd: ragDir,
        timeout: 120_000,
      });
      this.opts.log.info({ lines: stdout.split('\n').length }, 'RAG rebuild complete');
    } catch (e) {
      this.opts.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'RAG rebuild failed');
    }
  }

  /** Run the read-only agent loop and post proposals to Slack. Returns count proposed. */
  private async proposePatches(
    actionable: DecisionClassification[],
    snapshot: { tracker: { submitted: number; target: number; queueLength: number } },
    e: Env,
    signal: AbortSignal,
  ): Promise<number> {
    const overridesText = await readOverrides(e.DIRECTOR_OVERRIDES).then((r) => JSON.stringify(r)).catch(() => '(none)');
    const classificationsText = actionable.map((c) => `[${c.severity}] ${c.kind}: ${c.reason}`).join('\n');
    const directorPrompt = readDirectorPrompt();
    const systemPrompt = `${directorPrompt}\n\nYou are in READ-ONLY mode. Investigate freely but do NOT write anything.\n\nCurrent overrides:\n${overridesText}\n\nRecent classifications:\n${classificationsText}`;
    const goal = `Campaign: ${snapshot.tracker.submitted}/${snapshot.tracker.target} submitted. Queue: ${snapshot.tracker.queueLength}. Investigate and output {"patches":[...]} or nothing.`;

    this.opts.log.info(
      { classifications: actionable.length, model: e.DIRECTOR_MODEL || e.WALK_ALIAS[0] || 'mst/free' },
      'Proposal agent loop starting (read-only)',
    );
    const t0 = Date.now();
    const result = await runDirectorAgent(
      this.opts.chain,
      systemPrompt,
      goal,
      e.DIRECTOR_MODEL || e.WALK_ALIAS[0] || 'mst/free',
      this.opts.log,
      signal,
      'read',
    );
    const elapsed = Date.now() - t0;
    let count = 0;
    for (const p of result.patches) {
      if (signal.aborted) break;
      await this.opts.surface.postProposal(p);
      await this.publishEvent(p.id, JSON.stringify({ kind: 'proposed', patch: p }));
      count++;
    }
    this.opts.log.info({ steps: result.steps, patches: count, elapsedMs: elapsed }, 'Proposal agent loop complete');
    return count;
  }

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
      // Publish decision to Kafka
      await this.publishEvent(
        decision.patchId,
        JSON.stringify({ kind: 'decided', decision }),
      );
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
      const t0 = Date.now();
      this.opts.log.info('Phase 1: Campaign supervision');
      // 1. Ensure campaign is running (supervisor)
      await this.ensureCampaignRunning();

      // 2. Observe campaign state
      this.opts.log.info('Phase 2: Observing campaign state');
      const { snapshot, checkpoint: next } = await observe(checkpoint, {
        campaignDir: e.DIRECTOR_CAMPAIGN_DIR,
      });
      // Carry over Slack ts + tracking fields from previous checkpoint
      // (observe() only sets eventsReadOffset and lastTickAt)
      next.lastSlackTs = checkpoint.lastSlackTs;
      next.lastSubmitted = checkpoint.lastSubmitted;
      next.lastQueueLength = checkpoint.lastQueueLength;
      next.lastProposalHash = checkpoint.lastProposalHash;
      checkpoint = next;
      observed = snapshot.recentEvents.length;
      this.opts.log.debug({ events: observed, submitted: snapshot.tracker.submitted, target: snapshot.tracker.target }, 'Observe complete');

      // 3. Classify decisions
      this.opts.log.info('Phase 3: Classifying decisions');
      const classifications = classify(snapshot);
      classificationsCount = classifications.length;
      this.opts.log.debug({ classifications: classificationsCount, kinds: classifications.map(c => c.kind) }, 'Classification complete');

      // Publish observation event to Kafka (only when data changed)
      const subChanged = snapshot.tracker.submitted !== checkpoint.lastSubmitted;
      const queueChanged = snapshot.tracker.queueLength !== checkpoint.lastQueueLength;
      const hasClassifications = classificationsCount > 0;
	      if (subChanged || queueChanged || hasClassifications) {
	        checkpoint.lastSubmitted = snapshot.tracker.submitted;
	        checkpoint.lastQueueLength = snapshot.tracker.queueLength;
	        await this.publishEvent(
	          `obs-${Date.now()}`,
	          JSON.stringify({
	            kind: 'observation',
	            snapshot: {
	              submitted: snapshot.tracker.submitted,
	              target: snapshot.tracker.target,
	              queueLength: snapshot.tracker.queueLength,
	            },
	            classifications: classificationsCount,
	          }),
	        );
	        // Also post to Slack (surface handles ledger + Slack message)
	        await this.opts.surface.postObservation({
	          submitted: snapshot.tracker.submitted,
	          target: snapshot.tracker.target,
	          queueLength: snapshot.tracker.queueLength,
	        });
	        this.opts.log.debug({ subChanged, queueChanged, hasClassifications }, 'Observation event published');
	      }

      // Auto-rebuild RAG when new submissions are detected
      if (subChanged) {
        this.opts.log.info('Phase 3b: Rebuilding RAG (new submissions detected)');
        await this.rebuildRag();
      }

      // 4. READ-ONLY agent loop to propose patches (skip if same state)
      const actionable = classifications.filter((c) => c.severity !== 'info');
      if (actionable.length > 0 && !signal.aborted) {
        this.opts.log.info({ actionable: actionable.length }, 'Phase 4: Proposing patches');
        const currentHash = hashClassifications(actionable);
        if (currentHash === checkpoint.lastProposalHash) {
          this.opts.log.info({ hash: currentHash }, 'Skipping proposal: same state as last tick');
        } else {
          checkpoint.lastProposalHash = currentHash;
          proposedCount = await this.proposePatches(actionable, snapshot, e, signal);
          this.opts.log.info({ proposedCount }, 'Proposal phase complete');
        }
      }

      // 5. Poll Slack for approve/reject commands
      this.opts.log.info('Phase 5: Polling Slack for approvals');
      checkpoint = await this.pollAndApplyDecisions(checkpoint);
      if (checkpoint.lastSlackTs) {
        this.opts.log.debug({ lastSlackTs: checkpoint.lastSlackTs }, 'Slack poll complete');
      }

      // 6. Execute approved patches (from any tick) via write-enabled agent loop
      this.opts.log.info('Phase 6: Checking for approved patches');
      const approved = await readApprovedPatches(e.DIRECTOR_LEDGER || join(e.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'ledger.jsonl'));
      if (approved.length > 0 && !signal.aborted) {
        this.opts.log.info({ approved: approved.length }, 'Phase 6b: Executing approved patches');
        const overridesText = await readOverrides(e.DIRECTOR_OVERRIDES).then(r => JSON.stringify(r)).catch(() => '(none)');
        const patchesText = approved.map(p => `- ${p.id}: ${p.rationale}  overrides: ${JSON.stringify(p.overrides)}`).join('\n');
        const execPrompt = `You are in EXECUTION mode. Apply the following approved patches by writing overrides.\n\nCurrent overrides:\n${overridesText}\n\nApproved patches to apply:\n${patchesText}\n\nFor each patch, call write_prompt_override with the rationale and then output {"applied":["patch-id-1",...]}.`;
        const execGoal = `Apply ${approved.length} approved patches by writing overrides.`;

        await runDirectorAgent(
          this.opts.chain,
          execPrompt,
          execGoal,
          e.DIRECTOR_MODEL || e.WALK_ALIAS[0] || 'mst/free',
          this.opts.log,
          signal,
          'write',
        );

        // After execution loop, directly apply patches to overrides file
        for (const p of approved) {
          this.opts.log.info({ patchId: p.id, risk: p.risk }, 'Applying approved patch');
          await applyPatch(p, e.DIRECTOR_OVERRIDES);
          await this.opts.surface.postApplied(p);
          await this.publishEvent(p.id, JSON.stringify({ kind: 'applied', patch: p }));
          this.opts.log.debug({ patchId: p.id, overrides: p.overrides }, 'Patch applied to overrides file');
        }
      }

      const t1 = Date.now();
      this.opts.log.info({ elapsedMs: t1 - t0, observed, classifications: classificationsCount, proposed: proposedCount }, 'Director tick complete');
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
