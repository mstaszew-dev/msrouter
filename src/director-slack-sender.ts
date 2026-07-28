/**
 * director-slack-sender.ts: Standalone process that consumes Director events
 * from the Kafka topic director-events and posts them to Slack. This decouples
 * outbound Slack delivery from the Director's tick.
 *
 * Flow: kafkaConsume(director-events) -> parse event JSON -> format message -> sendToSlack
 *
 * Runs a poll loop (every KAFKA_POLL_INTERVAL_SECONDS) that drains the topic
 * and delivers any pending events to Slack.
 */

import 'dotenv/config';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { kafkaConsume } from './director/kafka.js';

const TOPIC = 'director-events';

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

async function main(): Promise<void> {
  const { env } = loadEnv();
  const log = createLogger(env, 'slack-sender');

  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL) {
    log.info('SLACK_BOT_TOKEN or SLACK_CHANNEL not set; sender disabled. Exiting.');
    return;
  }

  const intervalSec = env.KAFKA_POLL_INTERVAL_SECONDS;
  const statePath = join(env.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'sender-state.json');

  log.info(
    { intervalSec, channel: env.SLACK_CHANNEL, topic: TOPIC },
    'Kafka->Slack sender started',
  );

  let lastOffset = await loadLastOffset(statePath);
  let runController: AbortController | undefined;

  const sendOnce = async () => {
    if (runController) {
      log.warn('previous send cycle still in progress; skipping');
      return;
    }
    runController = new AbortController();
    try {
      const messages = await kafkaConsume(TOPIC, {
        kafkaHome: expandTilde(env.KAFKA_HOME),
        bootstrap: env.KAFKA_BOOTSTRAP,
        log,
        maxMessages: 50,
        timeoutMs: 5000,
      });

      if (messages.length === 0) {
        return;
      }

      let count = 0;
      for (const msg of messages) {
        const event = JSON.parse(msg.value) as {
          kind?: string;
          patch?: { id?: string; rationale?: string; risk?: string; overrides?: Record<string, string> };
          decision?: { patchId?: string; decision?: string; reason?: string };
          snapshot?: { submitted?: number; target?: number };
          detail?: string;
        };

        const text = formatEvent(event);
        if (!text) continue;

        await sendToSlack(text, env.SLACK_BOT_TOKEN!, env.SLACK_CHANNEL!);
        count++;
      }

      // Update offset (simplified: we track message count, not true Kafka offsets)
      lastOffset += messages.length;
      await saveLastOffset(statePath, lastOffset);
      log.info({ count, totalSeen: lastOffset }, 'send cycle complete');
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'send cycle failed');
    } finally {
      runController = undefined;
    }
  };

  const timer = setInterval(() => void sendOnce(), intervalSec * 1000);
  void sendOnce();

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down sender...`);
    if (timer) clearInterval(timer);
    if (runController) runController.abort();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function formatEvent(event: Record<string, unknown>): string | undefined {
  const kind = event['kind'] as string | undefined;
  if (!kind) return undefined;

  switch (kind) {
    case 'proposed': {
      const patch = event['patch'] as { id?: string; rationale?: string; risk?: string; overrides?: Record<string, string> } | undefined;
      if (!patch) return undefined;
      const overrides = patch.overrides
        ? Object.entries(patch.overrides).map(([k, v]) => `  ${k}=${v}`).join('\n')
        : '(none)';
      return [
        `*Director Proposal* (risk: ${patch.risk ?? '?'})`,
        `Rationale: ${patch.rationale ?? '(none)'}`,
        `*Overrides:*`,
        overrides,
        '',
        `Reply \`approve ${patch.id}\` or \`reject ${patch.id}\``,
      ].join('\n');
    }
    case 'decided': {
      const decision = event['decision'] as { patchId?: string; decision?: string; reason?: string } | undefined;
      if (!decision) return undefined;
      return `*Director Decision*: ${decision.decision} on patch ${decision.patchId}${decision.reason ? ` — ${decision.reason}` : ''}`;
    }
    case 'applied': {
      const patch = event['patch'] as { id?: string } | undefined;
      return `*Director Applied*: Patch ${patch?.id ?? '?'} has been applied.`;
    }
    case 'restart': {
      const detail = event['detail'] as string | undefined;
      return `*Director Restart*: ${detail ?? 'Campaign restarted'}`;
    }
    case 'observation': {
      const snapshot = event['snapshot'] as { submitted?: number; target?: number } | undefined;
      return `*Director Observation*: submitted=${snapshot?.submitted ?? '?'}/${snapshot?.target ?? '?'}`;
    }
    default:
      return JSON.stringify(event);
  }
}

async function sendToSlack(text: string, botToken: string, channel: string): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      // Logged but not fatal
    }
  } catch {
    // Logged by caller
  }
}

async function loadLastOffset(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8');
    return (JSON.parse(raw) as { lastOffset?: number }).lastOffset ?? 0;
  } catch {
    return 0;
  }
}

async function saveLastOffset(path: string, offset: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify({ lastOffset: offset }), 'utf8');
}

void main();
