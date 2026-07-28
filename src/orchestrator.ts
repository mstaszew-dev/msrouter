/**
 * orchestrator.ts: Unified startup. Starts the gateway + Director + Slack poller
 * in a single Node process. Replaces the old multi-process architecture
 * (director-worker.ts, director-kafka-poller.ts, director-slack-sender.ts).
 *
 * Flow:
 *   main.ts → createGatewayServer() + startOrchestrator()
 *   startOrchestrator() → DirectorLoop (interval) + SlackPoller (interval)
 */

import { join } from 'node:path';

import type { Logger } from 'pino';

import { env } from './config/env.js';
import { DirectorLoop } from './director/index.js';
import { SlackPoller } from './director/slack-poller.js';
import { NullSurface, SlackSurface } from './director/surface.js';
import type { ProviderChain } from './providers/chain.js';

export interface OrchestratorOpts {
  chain: ProviderChain;
  log: Logger;
}

export interface OrchestratorHandles {
  directorLoop: DirectorLoop;
  poller?: SlackPoller;
  surface: NullSurface | SlackSurface;
  shutdown: () => void;
}

/**
 * Start the Director + Slack poller alongside the gateway.
 * Returns handles for graceful shutdown.
 */
export function startOrchestrator(opts: OrchestratorOpts): OrchestratorHandles {
  const e = env();
  const log = opts.log;

  // Resolve paths
  const ledgerPath = e.DIRECTOR_LEDGER || join(e.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'ledger.jsonl');
  const checkpointPath = join(e.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'checkpoint.json');

  // Create Slack poller (in-process, if configured)
  let poller: SlackPoller | undefined;
  if (e.SLACK_BOT_TOKEN && e.SLACK_CHANNEL) {
    poller = new SlackPoller(
      e.SLACK_BOT_TOKEN,
      e.SLACK_CHANNEL,
      e.KAFKA_POLL_INTERVAL_SECONDS,
      log,
    );
  }

  // Create surface (Slack if configured, else Null)
  let surface: NullSurface | SlackSurface;
  if (e.SLACK_BOT_TOKEN || e.SLACK_WEBHOOK) {
    surface = new SlackSurface({
      ledgerPath,
      log,
      slackBotToken: e.SLACK_BOT_TOKEN,
      slackChannel: e.SLACK_CHANNEL,
      slackWebhook: e.SLACK_WEBHOOK,
      slackPoller: poller,
    });
    log.info('Using Slack surface for Director');
  } else {
    surface = new NullSurface({ ledgerPath, log });
    log.info('Using NullSurface (Slack not configured)');
  }

  // Create Director loop
  const directorLoop = new DirectorLoop({
    env: e,
    chain: opts.chain,
    surface,
    log,
    checkpointPath,
  });

  // Start Director tick
  let runController: AbortController | undefined;

  if (e.DIRECTOR_INTERVAL_MINUTES >= 0) {
    const runOnce = async () => {
      if (runController) {
        log.warn('previous Director run still in progress; skipping tick');
        return;
      }
      runController = new AbortController();
      try {
        log.info('Director tick starting');
        const result = await directorLoop.runOnce(runController.signal);
        log.info(
          { observed: result.observed, classifications: result.classifications, proposed: result.proposed, reason: result.reason },
          'Director tick finished',
        );
      } catch (e2) {
        log.error({ err: e2 instanceof Error ? e2.message : String(e2) }, 'Director tick failed');
      } finally {
        runController = undefined;
      }
    };

    const intervalMs = e.DIRECTOR_INTERVAL_MINUTES * 60_000;
    const timer = setInterval(() => void runOnce(), intervalMs);
    void runOnce();
    log.info(
      { intervalMinutes: e.DIRECTOR_INTERVAL_MINUTES, ledgerPath },
      'Director scheduler started',
    );

    // Start Slack poller
    if (poller) poller.start();

    // Shutdown handler
    const shutdown = () => {
      log.info('Shutting down orchestrator...');
      clearInterval(timer);
      if (poller) poller.stop();
      if (runController) runController.abort();
      setTimeout(() => process.exit(0), 3_000).unref();
    };

    return { directorLoop, poller, surface, shutdown };
  }

  log.info('Director disabled (DIRECTOR_INTERVAL_MINUTES<0)');

  const shutdown = () => {
    if (poller) poller.stop();
    setTimeout(() => process.exit(0), 1_000).unref();
  };

  return { directorLoop, poller, surface, shutdown };
}
