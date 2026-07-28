/**
 * director-kafka-poller.ts: Standalone process that polls Slack for new messages
 * every KAFKA_POLL_INTERVAL_SECONDS (default 30) and pushes them to the Kafka
 * topic director-slack-raw. This decouples Slack responsiveness (30s) from the
 * Director's heavier 5-min tick.
 *
 * Flow: Slack conversations.history -> kafkaProduce(director-slack-raw, ts, json)
 *
 * The Director worker consumes from director-slack-raw on its own schedule.
 */

import 'dotenv/config';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { kafkaProduce } from './director/kafka.js';

const TOPIC = 'director-slack-raw';

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

async function main(): Promise<void> {
  const { env } = loadEnv();
  const log = createLogger(env, 'kafka-poller');

  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL) {
    log.info('SLACK_BOT_TOKEN or SLACK_CHANNEL not set; poller disabled. Exiting.');
    return;
  }

  const intervalSec = env.KAFKA_POLL_INTERVAL_SECONDS;
  const statePath = join(env.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'poller-state.json');

  log.info(
    { intervalSec, channel: env.SLACK_CHANNEL, topic: TOPIC },
    'Slack->Kafka poller started',
  );

  let lastTs = await loadLastTs(statePath);
  let runController: AbortController | undefined;

  const pollOnce = async () => {
    if (runController) {
      log.warn('previous poll still in progress; skipping');
      return;
    }
    runController = new AbortController();
    try {
      const params = new URLSearchParams({ channel: env.SLACK_CHANNEL!, limit: '20' });
      if (lastTs) params.set('oldest', lastTs);
      const res = await fetch(
        `https://slack.com/api/conversations.history?${params.toString()}`,
        { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        messages?: Array<{ text?: string; ts?: string; user?: string }>;
        error?: string;
      };
      if (!data.ok || !data.messages) {
        log.warn({ error: data.error }, 'Slack API returned error');
        return;
      }

      let count = 0;
      let newest = lastTs;
      for (const msg of data.messages) {
        if (!msg.ts) continue;
        if (!newest || msg.ts > newest) newest = msg.ts;
        const value = JSON.stringify({ text: msg.text, ts: msg.ts, user: msg.user });
        await kafkaProduce(TOPIC, msg.ts, value, {
          kafkaHome: expandTilde(env.KAFKA_HOME),
          bootstrap: env.KAFKA_BOOTSTRAP,
          log,
        });
        count++;
      }

      if (newest !== lastTs) {
        lastTs = newest;
        await saveLastTs(statePath, lastTs ?? '');
      }

      log.info({ count, lastTs }, 'poll cycle complete');
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'poll cycle failed');
    } finally {
      runController = undefined;
    }
  };

  const timer = setInterval(() => void pollOnce(), intervalSec * 1000);
  void pollOnce();

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down poller...`);
    if (timer) clearInterval(timer);
    if (runController) runController.abort();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function loadLastTs(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return (JSON.parse(raw) as { lastTs?: string }).lastTs;
  } catch {
    return undefined;
  }
}

async function saveLastTs(path: string, lastTs: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
  await writeFile(path, JSON.stringify({ lastTs }), 'utf8');
}

void main();
