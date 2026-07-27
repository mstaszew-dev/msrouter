/**
 * Scheduled agent worker process. Separate from the gateway (BLOCKER pattern:
 * long-running agent work never blocks the HTTP server). Runs the AgentLoop on a
 * fixed interval (SCHEDULE_INTERVAL_MINUTES, -1 disables). SIGTERM drains an
 * in-flight run and exits.
 */

// Load .env before any module that reads process.env.
import 'dotenv/config';

import { AgentLoop } from './agent/loop.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { ProviderChain } from './providers/chain.js';
import { buildProviders } from './providers/instances.js';

async function main(): Promise<void> {
  const { env } = loadEnv();
  const log = createLogger(env, 'worker');

  if (env.SCHEDULE_INTERVAL_MINUTES < 0) {
    log.info('SCHEDULE_INTERVAL_MINUTES<0; scheduled agent disabled. Exiting.');
    return;
  }

  const providers = buildProviders(log);
  const chain = new ProviderChain(providers, log);
  const agent = new AgentLoop(chain, log);

  // AbortController shared across the in-flight run; aborted on shutdown.
  let runController: AbortController | undefined;

  const runOnce = async () => {
    if (runController) {
      log.warn('previous run still in progress; skipping tick');
      return;
    }
    runController = new AbortController();
    try {
      log.info('agent run starting');
      const result = await agent.runOnce(runController.signal);
      log.info(
        { steps: result.steps, goalMet: result.goalMet, reason: result.reason },
        'agent run finished',
      );
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'agent run failed');
    } finally {
      runController = undefined;
    }
  };

  const intervalMs = env.SCHEDULE_INTERVAL_MINUTES * 60_000;
  const timer = setInterval(() => void runOnce(), intervalMs);
  // Run immediately on boot so you don't wait a full interval for the first run.
  void runOnce();
  log.info({ intervalMinutes: env.SCHEDULE_INTERVAL_MINUTES }, 'agent scheduler started');

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down worker...`);
    if (timer) clearInterval(timer);
    if (runController) runController.abort();
    // Give the in-flight run a moment to observe the abort, then exit.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
