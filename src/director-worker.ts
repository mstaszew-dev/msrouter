/**
 * Director agent worker process. Sibling to worker.ts. Runs DirectorLoop on a
 * fixed interval (DIRECTOR_INTERVAL_MINUTES, -1 disables). SIGTERM drains an
 * in-flight run and exits. Uses the same ProviderChain as the gateway.
 *
 * In P2 the surface is NullSurface (ledger-only). P3 will add SlackSurface and
 * the approval -> apply -> restart wiring.
 */

// Load .env before any module that reads process.env.
import 'dotenv/config';

import { join } from 'node:path';
import { homedir } from 'node:os';

import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { ProviderChain } from './providers/chain.js';
import { buildProviders } from './providers/instances.js';
import { DirectorLoop, NullSurface } from './director/index.js';

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

async function main(): Promise<void> {
  const { env } = loadEnv();
  const log = createLogger(env, 'director');

  if (env.DIRECTOR_INTERVAL_MINUTES < 0) {
    log.info('DIRECTOR_INTERVAL_MINUTES<0; Director disabled. Exiting.');
    return;
  }

  const providers = buildProviders(log);
  const chain = new ProviderChain(providers, log);
  const ledgerPath =
    env.DIRECTOR_LEDGER || join(env.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'ledger.jsonl');
  const checkpointPath = join(env.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'checkpoint.json');
  const surface = new NullSurface({ ledgerPath, log });
  const loop = new DirectorLoop({ env, chain, surface, log, checkpointPath });

  // AbortController shared across the in-flight run; aborted on shutdown.
  let runController: AbortController | undefined;

  const runOnce = async () => {
    if (runController) {
      log.warn('previous Director run still in progress; skipping tick');
      return;
    }
    runController = new AbortController();
    try {
      log.info('Director run starting');
      const result = await loop.runOnce(runController.signal);
      log.info(
        {
          observed: result.observed,
          classifications: result.classifications,
          proposed: result.proposed,
          reason: result.reason,
        },
        'Director run finished',
      );
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'Director run failed');
    } finally {
      runController = undefined;
    }
  };

  const intervalMs = env.DIRECTOR_INTERVAL_MINUTES * 60_000;
  const timer = setInterval(() => void runOnce(), intervalMs);
  // Run immediately on boot so the first observation doesn't wait a full interval.
  void runOnce();
  log.info(
    { intervalMinutes: env.DIRECTOR_INTERVAL_MINUTES, ledgerPath },
    'Director scheduler started',
  );

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down Director...`);
    if (timer) clearInterval(timer);
    if (runController) runController.abort();
    // Give the in-flight run a moment to observe the abort, then exit.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Reserved for future pidfile/runner path expansion when restart is wired.
  void expandTilde;
}

void main();
