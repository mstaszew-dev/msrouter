/**
 * surface.ts: NullSurface implements DirectorSurface by writing every event to
 * the ledger and logging it. No external I/O, no auto-apply. P3 swaps in a
 * SlackSurface that ALSO posts to Slack and only applies on user approval.
 *
 * The surface is the runtime approval gate. There is no dry-run flag: a
 * NullSurface IS the pre-Slack state of the world, where every proposal lands
 * in ledger.jsonl and waits for a human (or a future surface) to decide.
 *
 * Slack delivery durability: SlackSurface.sendToSlack enqueues any message
 * that fails (network error or Slack ok:false) into a JSON outbox file next to
 * the ledger. flushOutbox() re-attempts every pending entry at the top of each
 * Director tick, so a transient failure (the cause of the missing 1200/1200
 * status post) is recovered on the next tick instead of lost forever. Entries
 * are dropped after MAX_OUTBOX_ATTEMPTS to avoid an unbounded poison queue.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Logger } from 'pino';

import { appendLedger } from './ledger.js';
import type { SlackPoller } from './slack-poller.js';
import type { DirectorSurface, Patch, PatchDecision, SlackOutboxEntry } from './types.js';

/** Drop an outbox entry after this many failed attempts (poison-queue guard). */
export const MAX_OUTBOX_ATTEMPTS = 10;

/**
 * Read the Slack outbox. Missing/corrupt file -> empty array (self-healing).
 * Shape: { entries: SlackOutboxEntry[] }. Kept under one key so a partial write
 * cannot leave a truncated JSON array.
 */
export async function readOutbox(path: string): Promise<SlackOutboxEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: SlackOutboxEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Atomically overwrite the outbox (temp file + rename) so a crash mid-write
 * cannot corrupt the queue. Creates parent dirs as needed.
 */
export async function writeOutbox(path: string, entries: SlackOutboxEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify({ entries }, null, 2), 'utf8');
  await rename(tmp, path);
}

export interface SurfaceOpts {
  ledgerPath: string;
  log: Logger;
  /** Slack Bot Token (xoxb-...) for SlackSurface. */
  slackBotToken?: string;
  /** Slack Channel ID to post to and poll from. */
  slackChannel?: string;
  /** Slack Webhook URL for outbound messages (alternative to Bot Token for posting). */
  slackWebhook?: string;
  /** In-process Slack poller (if provided, pollSlackMessages drains its queue). */
  slackPoller?: SlackPoller;
  /** Path to the durable Slack outbox JSON. Defaults to ledgerPath + '.slack-outbox.json'
   *  so it lives next to the ledger without extra config. */
  outboxPath?: string;
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

  async postObservation(snapshot: { submitted: number; target: number; queueLength: number }): Promise<void> {
    await appendLedger(this.opts.ledgerPath, {
      at: new Date().toISOString(),
      kind: 'observation',
      detail: `submitted=${snapshot.submitted} target=${snapshot.target} queue=${snapshot.queueLength}`,
    });
    this.opts.log.debug({ submitted: snapshot.submitted }, 'observation recorded');
  }

  async pollSlackMessages(_lastTs?: string): Promise<{ decisions: PatchDecision[]; latestTs?: string }> {
    // NullSurface has no Slack connection; return empty.
    return { decisions: [], latestTs: _lastTs };
  }

  /** No outbox on NullSurface; nothing to flush. */
  async flushOutbox(): Promise<number> {
    return 0;
  }
}

/**
 * SlackSurface posts proposals to a Slack channel via Bot Token or Webhook.
 * Uses the Slack Web API (chat.postMessage) for outbound messages.
 */
export class SlackSurface extends NullSurface {
  private readonly botToken?: string;
  private readonly channel?: string;
  private readonly webhookUrl?: string;
  private readonly log: Logger;
  private readonly poller?: SlackPoller;
  private readonly outboxPath: string;

  constructor(opts: SurfaceOpts) {
    super(opts);
    this.log = opts.log;
    this.botToken = opts.slackBotToken;
    this.channel = opts.slackChannel;
    this.webhookUrl = opts.slackWebhook;
    this.poller = opts.slackPoller;
    this.outboxPath = opts.outboxPath ?? `${opts.ledgerPath}.slack-outbox.json`;
  }

  override async postProposal(patch: Patch): Promise<void> {
    await super.postProposal(patch);
    const message = this.buildProposalMessage(patch);
    await this.sendToSlack(message);
  }

  override async postDecision(decision: PatchDecision): Promise<void> {
    await super.postDecision(decision);
    const message = this.buildDecisionMessage(decision);
    await this.sendToSlack(message);
  }

  override async postApplied(patch: Patch): Promise<void> {
    await super.postApplied(patch);
    const message = this.buildAppliedMessage(patch);
    await this.sendToSlack(message);
  }

  override async postRestart(detail: { pid: number; logPath: string }): Promise<void> {
    await super.postRestart(detail);
    const message = this.buildRestartMessage(detail);
    await this.sendToSlack(message);
  }

  override async postObservation(snapshot: { submitted: number; target: number; queueLength: number }): Promise<void> {
    await super.postObservation(snapshot);
    const message = this.buildObservationMessage(snapshot);
    await this.sendToSlack(message);
  }

  /**
   * Attempt to deliver a message to Slack. Returns true on success, false on
   * any failure (network error or Slack ok:false). The caller decides whether
   * to enqueue the failure; post* methods enqueue so the next tick recovers it.
   */
  private async deliverToSlack(message: string): Promise<boolean> {
    if (!this.botToken && !this.webhookUrl) {
      this.log.debug('No Slack credentials configured; skipping Slack post');
      // No credentials is a permanent no-op, not a failure to retry.
      return true;
    }

    try {
      // Prefer botToken + explicit channel (routes to #jobcampaign).
      // Fall back to webhook only if no bot token is configured — webhook URLs
      // are tied to the channel they were created for and may not match.
      if (this.botToken && this.channel) {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel: this.channel, text: message }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (!data.ok) {
          this.log.error({ error: data.error }, 'Slack chat.postMessage failed');
          return false;
        }
        return true;
      } else if (this.webhookUrl) {
        const res = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        });
        if (!res.ok) {
          this.log.error({ status: res.status }, 'Slack webhook post failed');
          return false;
        }
        return true;
      }
      return true;
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Slack post failed');
      return false;
    }
  }

  /** Deliver now; on failure, enqueue to the outbox for the next tick. */
  private async sendToSlack(message: string): Promise<void> {
    if (await this.deliverToSlack(message)) return;
    await this.enqueueOutbox(message);
  }

  /** Append a message to the durable outbox for later retry. */
  private async enqueueOutbox(message: string): Promise<void> {
    const entries = await readOutbox(this.outboxPath);
    entries.push({ id: randomUUID(), message, attempts: 0 });
    await writeOutbox(this.outboxPath, entries);
    this.log.warn({ outboxSize: entries.length, outboxPath: this.outboxPath }, 'Slack post failed; enqueued to outbox for retry');
  }

  /**
   * Re-attempt every pending outbox entry. Called once at the top of each
   * Director tick. Removes entries that succeed or that exceed
   * MAX_OUTBOX_ATTEMPTS (poison-queue guard). Returns the count still pending.
   */
  override async flushOutbox(): Promise<number> {
    let entries = await readOutbox(this.outboxPath);
    if (entries.length === 0) return 0;

    const remaining: SlackOutboxEntry[] = [];
    for (const entry of entries) {
      const ok = await this.deliverToSlack(entry.message);
      if (ok) {
        this.log.info({ id: entry.id }, 'Outbox entry delivered to Slack');
        continue;
      }
      const attempts = entry.attempts + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        this.log.error(
          { id: entry.id, attempts, message: entry.message.slice(0, 120) },
          'Dropping outbox entry after max attempts',
        );
        continue;
      }
      remaining.push({
        ...entry,
        attempts,
        lastErrorAt: new Date().toISOString(),
      });
    }

    // Persist the new state. writeOutbox is atomic (temp + rename), so a crash
    // between deliveries leaves either the old or the new file, never a hybrid.
    await writeOutbox(this.outboxPath, remaining);

    if (remaining.length < entries.length) {
      this.log.info(
        { delivered: entries.length - remaining.length, remaining: remaining.length },
        'Outbox flush complete',
      );
    }
    entries = remaining;
    return entries.length;
  }

  /**
   * Poll Slack channel for approve/reject commands newer than `lastTs`.
   * Returns PatchDecision[] for any approve/reject messages found, plus the
   * latest ts seen (for dedup on the next poll).
   * Uses Slack conversations.history API (polling, not socket mode).
   */
  override async pollSlackMessages(lastTs?: string): Promise<{
    decisions: PatchDecision[];
    latestTs?: string;
  }> {
    // If we have an in-process poller, drain its queue instead of calling Slack API directly
    if (this.poller) {
      const msgs = this.poller.drain();
      const decisions: PatchDecision[] = [];
      for (const msg of msgs) {
        const text = msg.text.trim();
        const approveMatch = text.match(/^approve\s+([a-zA-Z0-9_-]+)/i);
        if (approveMatch) {
          decisions.push({
            patchId: approveMatch[1]!,
            decision: 'approved',
            decidedAt: new Date().toISOString(),
            decidedBy: 'slack',
          });
          continue;
        }
        const rejectMatch = text.match(/^reject\s+([a-zA-Z0-9_-]+)/i);
        if (rejectMatch) {
          decisions.push({
            patchId: rejectMatch[1]!,
            decision: 'rejected',
            decidedAt: new Date().toISOString(),
            decidedBy: 'slack',
          });
        }
      }
      return { decisions, latestTs: this.poller.latestTs };
    }

    // Fallback: direct Slack API call (for standalone use without poller)
    if (!this.botToken || !this.channel) {
      return { decisions: [], latestTs: lastTs };
    }
    try {
      const params = new URLSearchParams({ channel: this.channel, limit: '20' });
      if (lastTs) params.set('oldest', lastTs);
      const url = `https://slack.com/api/conversations.history?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.botToken}` },
      });
      const data = await res.json() as {
        ok?: boolean;
        messages?: Array<{ text?: string; ts?: string }>;
        error?: string;
      };
      if (!data.ok || !data.messages) {
        this.log.debug({ error: data.error }, 'Slack conversations.history failed');
        return { decisions: [], latestTs: lastTs };
      }
      const decisions: PatchDecision[] = [];
      let newestTs = lastTs;
      for (const msg of data.messages) {
        if (!msg.text || !msg.ts) continue;
        // Track newest ts for next poll's dedup.
        if (!newestTs || msg.ts > newestTs) newestTs = msg.ts;
        const text = msg.text.trim();
        const approveMatch = text.match(/^approve\s+([a-zA-Z0-9_-]+)/i);
        if (approveMatch) {
          decisions.push({
            patchId: approveMatch[1]!,
            decision: 'approved',
            decidedAt: new Date().toISOString(),
            decidedBy: 'slack',
          });
          continue;
        }
        const rejectMatch = text.match(/^reject\s+([a-zA-Z0-9_-]+)/i);
        if (rejectMatch) {
          decisions.push({
            patchId: rejectMatch[1]!,
            decision: 'rejected',
            decidedAt: new Date().toISOString(),
            decidedBy: 'slack',
          });
        }
      }
      return { decisions, latestTs: newestTs };
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Slack poll failed');
      return { decisions: [], latestTs: lastTs };
    }
  }

  private buildProposalMessage(patch: Patch): string {
    const lines = [
      `*Director Proposal* (risk: ${patch.risk})`,
      `Rationale: ${patch.rationale}`,
      '',
      `*Overrides to apply: *`,
      ...Object.entries(patch.overrides).map(([k, v]) => `  ${k}=${v}`),
      '',
      `Reply \`approve ${patch.id}\` or \`reject ${patch.id}\``,
    ];
    return lines.join('\n');
  }

  private buildDecisionMessage(decision: PatchDecision): string {
    return `*Director Decision*: ${decision.decision} on patch ${decision.patchId}${decision.reason ? ` — ${decision.reason}` : ''}`;
  }

  private buildAppliedMessage(patch: Patch): string {
    return `*Director Applied*: Patch ${patch.id} has been applied to the overrides file.`;
  }

  private buildRestartMessage(detail: { pid: number; logPath: string }): string {
    return `*Director Restart*: Campaign restarted (PID: ${detail.pid}). Log: ${detail.logPath}`;
  }

  private buildObservationMessage(snapshot: { submitted: number; target: number; queueLength: number }): string {
    return `*Campaign Status*: ${snapshot.submitted}/${snapshot.target} submitted (${snapshot.target - snapshot.submitted} to go). Queue: ${snapshot.queueLength}`;
  }
}
