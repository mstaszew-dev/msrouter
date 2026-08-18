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
import { readApprovedPatches } from './ledger.js';
import { observe, isCampaignComplete } from './observe.js';
import {
  ensureCdpRunning,
  ensureInfrastructureHealthy,
  restartWorker,
  rotateVpnIp,
  shouldRotateVpn,
  snapshot as snapshotWorker,
  startKafkaInIterm,
  startWorkerInIterm,
  stopWorker,
} from './restart.js';
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
    const overridesText = await readOverrides(e.DIRECTOR_OVERRIDES)
      .then((r) => JSON.stringify(r))
      .catch(() => '(none)');
    const classificationsText = actionable
      .map((c) => `[${c.severity}] ${c.kind}: ${c.reason}`)
      .join('\n');
    const directorPrompt = readDirectorPrompt();
    const systemPrompt = `${directorPrompt}\n\nYou are in READ-ONLY mode. Investigate freely but do NOT write anything.\n\nCurrent overrides:\n${overridesText}\n\nRecent classifications:\n${classificationsText}`;
    const goal = `Campaign: ${snapshot.tracker.submitted}/${snapshot.tracker.target} submitted. Queue: ${snapshot.tracker.queueLength}. Investigate and output {"patches":[...]} or nothing.`;

    this.opts.log.info(
      {
        classifications: actionable.length,
        model: e.DIRECTOR_MODEL || e.WALK_ALIAS[0] || 'mst/free',
      },
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
    this.opts.log.info(
      { steps: result.steps, patches: count, elapsedMs: elapsed },
      'Proposal agent loop complete',
    );
    return count;
  }

  /** Check if the campaign is running and start it via iTerm if not.
   *  Suppressed when the campaign target is already met: the agent exits on
   *  purpose in that state, so respawning it would open an iTerm tab every
   *  tick that immediately logs "Campaign complete" and quits. */
  async ensureCampaignRunning(): Promise<void> {
    // Completion guard: never respawn a finished campaign. isCampaignComplete
    // never throws (defaults to false on missing/unparseable tracker), so the
    // safe failure mode is to keep supervising as before.
    if (await isCampaignComplete(this.opts.env.DIRECTOR_CAMPAIGN_DIR)) {
      this.opts.log.info('Campaign target met; not respawning worker');
      return;
    }
    const state = snapshotWorker({
      entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
      workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
      cdpUrl: this.opts.env.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
      log: this.opts.log,
      cdpTimeoutMs: this.opts.env.DIRECTOR_CDP_URL ? 30_000 : 5000,
    });
    if (state.orphaned) {
      this.opts.log.warn(
        { pids: state.pids },
        'Agent is orphaned (PPID 1); killing and restarting in iTerm',
      );
      await stopWorker({
        entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
        workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
        cdpUrl: this.opts.env.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
        log: this.opts.log,
      });
      // Fall through to start a fresh iTerm tab below.
    }
    if (!state.running || state.orphaned) {
      this.opts.log.info('Campaign not running; starting via iTerm');
      try {
        startWorkerInIterm({
          entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
          workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
          log: this.opts.log,
        });
      } catch {
        // best-effort: agent startup failure should not block the director tick
      }
    }
    // Always ensure Kafka is running (idempotent: skips if already up).
    // Separated from worker startup so Kafka is started even when the agent
    // was already running on a previous tick.
    if (this.opts.env.KAFKA_ENABLED) {
      try {
        startKafkaInIterm({
          entryCommand: this.opts.env.DIRECTOR_RUNNER || 'job-search-agent',
          workspace: this.opts.env.DIRECTOR_OPENCLAW_WORKSPACE,
          log: this.opts.log,
        });
      } catch {
        // best-effort: Kafka startup failure should not block the director tick
      }
    }
  }

  /**
   * Poll Slack for approve/reject commands and apply approved patches.
   * Tracks latest ts in checkpoint for dedup. Called on each Director tick.
   */
  async pollAndApplyDecisions(checkpoint: Checkpoint): Promise<Checkpoint> {
    const { decisions, latestTs } = await this.opts.surface.pollSlackMessages(
      checkpoint.lastSlackTs,
    );
    if (latestTs) checkpoint.lastSlackTs = latestTs;
    if (decisions.length === 0) return checkpoint;

    for (const decision of decisions) {
      this.opts.log.info(
        { patchId: decision.patchId, decision: decision.decision },
        'Slack decision received',
      );
      await this.opts.surface.postDecision(decision);
      // Publish decision to Kafka
      await this.publishEvent(decision.patchId, JSON.stringify({ kind: 'decided', decision }));
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
      // 0. Drain any Slack posts that failed on a previous tick. Done first so
      // a recovered message (e.g. a missed 1200/1200 status) lands before this
      // tick emits new ones. No-op when the outbox is empty.
      await this.opts.surface.flushOutbox();
      this.opts.log.info('Phase 1: Campaign supervision');
      // 0. Ensure Chrome CDP is running (Playwright MCP depends on it)
      await ensureCdpRunning(e.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222');
      // 0a. Ensure infrastructure (Playwright MCP, OpenClaw gateway) is healthy
      const restarted = await ensureInfrastructureHealthy({
        entryCommand: e.DIRECTOR_RUNNER || 'job-search-agent',
        workspace: e.DIRECTOR_OPENCLAW_WORKSPACE,
        cdpUrl: e.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
        log: this.opts.log,
        campaignDir: e.DIRECTOR_CAMPAIGN_DIR,
      });
      if (restarted) {
        this.opts.log.info(
          'Campaign was restarted due to infrastructure issues; waiting for next tick',
        );
        return {
          observed: 0,
          classifications: 0,
          proposed: 0,
          applied: 0,
          reason: 'infra-restart',
        };
      }
      // 0b. Periodically rotate Proton VPN IP (if configured). After a
      // successful rotation, restart the agent so it reconnects on the new IP
      // with a fresh retry loop (a live-but-stuck agent is never restarted by
      // ensureCampaignRunning, which only starts missing processes).
      const vpnInterval = e.VPN_ROTATION_INTERVAL_MINUTES;
      if (vpnInterval > 0) {
        const shouldRotate = shouldRotateVpn(checkpoint.lastVpnRotation, vpnInterval);
        if (shouldRotate) {
          this.opts.log.info('Rotating Proton VPN IP...');
          const ok = await rotateVpnIp();
          // Back off a FULL interval on BOTH success and failure. A failed
          // rotation still stopped/started the tunnel (~30s of network flap),
          // so leaving lastVpnRotation unset would retry it every tick and
          // keep breaking in-flight fetches (Slack polls, agent requests).
          checkpoint.lastVpnRotation = new Date().toISOString();
          if (ok) {
            this.opts.log.info('Proton VPN IP rotated successfully; restarting agent');
            await restartWorker({
              entryCommand: e.DIRECTOR_RUNNER || 'job-search-agent',
              workspace: e.DIRECTOR_OPENCLAW_WORKSPACE,
              cdpUrl: e.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
              log: this.opts.log,
            });
          } else {
            this.opts.log.warn('Proton VPN IP rotation failed (may already be at new IP)');
          }
        }
      }
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
      next.staleWarningActive = checkpoint.staleWarningActive;
      next.lastVpnRotation = checkpoint.lastVpnRotation;
      checkpoint = next;
      observed = snapshot.recentEvents.length;
      this.opts.log.debug(
        {
          events: observed,
          submitted: snapshot.tracker.submitted,
          target: snapshot.tracker.target,
        },
        'Observe complete',
      );

      // 3. Classify decisions
      this.opts.log.info('Phase 3: Classifying decisions');
      const lastEventAt =
        snapshot.recentEvents.length > 0
          ? snapshot.recentEvents[snapshot.recentEvents.length - 1]!.at
          : checkpoint.lastTickAt;
      const classifications = classify(snapshot, new Date().toISOString(), lastEventAt);
      classificationsCount = classifications.length;
      this.opts.log.debug(
        { classifications: classificationsCount, kinds: classifications.map((c) => c.kind) },
        'Classification complete',
      );

      // 3a. Stall-triggered VPN rotation: if the campaign is stale (no progress
      // for 60+ min), the free-tier providers are likely rate-limiting the
      // current IP. Rotate the VPN IP and restart the agent to get a fresh IP.
      const hasStale = classifications.some((c) => c.kind === 'stale-campaign');
      if (hasStale && !checkpoint.staleWarningActive) {
        this.opts.log.warn('Campaign stale; rotating Proton VPN IP and restarting agent');
        const ok = await rotateVpnIp();
        // Back off a full interval even on failure (a failed rotation still
        // flapped the tunnel; retrying next tick would repeat the disruption).
        checkpoint.lastVpnRotation = new Date().toISOString();
        if (ok) {
          this.opts.log.info('Proton VPN IP rotated due to stall');
        } else {
          this.opts.log.warn('VPN rotation failed during stall recovery');
        }
        // Restart the agent so it picks up the new IP on fresh connections
        await restartWorker({
          entryCommand: e.DIRECTOR_RUNNER || 'job-search-agent',
          workspace: e.DIRECTOR_OPENCLAW_WORKSPACE,
          cdpUrl: e.DIRECTOR_CDP_URL || 'http://127.0.0.1:9222',
          log: this.opts.log,
        });
      }

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
        this.opts.log.debug(
          { subChanged, queueChanged, hasClassifications },
          'Observation event published',
        );
      }

      // Auto-rebuild RAG when new submissions are detected
      if (subChanged) {
        this.opts.log.info('Phase 3b: Rebuilding RAG (new submissions detected)');
        await this.rebuildRag();
      }

      // Clear stale-campaign warning when new activity arrives
      if (observed > 0 && checkpoint.staleWarningActive) {
        checkpoint.staleWarningActive = false;
        this.opts.log.info('New events detected; clearing stale-campaign warning');
      }

      // 4. READ-ONLY agent loop to propose patches (skip if same state)
      const actionable = classifications.filter((c) => c.severity !== 'info');
      if (actionable.length > 0 && !signal.aborted) {
        // Suppress repeated stale-campaign proposals: if the only actionable
        // classifications are stale-campaign and we already sent one, skip.
        const onlyStale = actionable.every((c) => c.kind === 'stale-campaign');
        if (onlyStale && checkpoint.staleWarningActive) {
          this.opts.log.info('Stale-campaign warning already active; skipping duplicate proposal');
        } else {
          this.opts.log.info({ actionable: actionable.length }, 'Phase 4: Proposing patches');
          const currentHash = hashClassifications(actionable);
          if (currentHash === checkpoint.lastProposalHash) {
            this.opts.log.info({ hash: currentHash }, 'Skipping proposal: same state as last tick');
          } else {
            checkpoint.lastProposalHash = currentHash;
            // Mark stale warning as active if we're about to propose one
            if (onlyStale) checkpoint.staleWarningActive = true;
            proposedCount = await this.proposePatches(actionable, snapshot, e, signal);
            this.opts.log.info({ proposedCount }, 'Proposal phase complete');
          }
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
      const approved = await readApprovedPatches(
        e.DIRECTOR_LEDGER || join(e.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'ledger.jsonl'),
      );
      if (approved.length > 0 && !signal.aborted) {
        this.opts.log.info({ approved: approved.length }, 'Phase 6b: Executing approved patches');
        const overridesText = await readOverrides(e.DIRECTOR_OVERRIDES)
          .then((r) => JSON.stringify(r))
          .catch(() => '(none)');
        const patchesText = approved
          .map((p) => `- ${p.id}: ${p.rationale}  overrides: ${JSON.stringify(p.overrides)}`)
          .join('\n');
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
          this.opts.log.debug(
            { patchId: p.id, overrides: p.overrides },
            'Patch applied to overrides file',
          );
        }
      }

      const t1 = Date.now();
      this.opts.log.info(
        {
          elapsedMs: t1 - t0,
          observed,
          classifications: classificationsCount,
          proposed: proposedCount,
        },
        'Director tick complete',
      );
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
