/**
 * Unified entrypoint. Starts the gateway HTTP server + the Director orchestrator
 * (Director tick + Slack poller + Kafka publisher) in a single process.
 */

// Load .env before any module that reads process.env.
import 'dotenv/config';

import { config, loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { assertInIterm } from './director/iterm.js';
import { createGatewayServer } from './gateway/server.js';
import { startOrchestrator } from './orchestrator.js';
import { ProviderChain } from './providers/chain.js';
import { buildProviders } from './providers/instances.js';

function main(): void {
  // Guard: msrouter must be launched from iTerm2. Prevents accidental starts
  // from Terminal.app / VSCode where iTerm2 tab spawning would fail silently.
  assertInIterm();

  const { env } = loadEnv();
  const log = createLogger(env, 'msrouter');

  const providers = buildProviders(log);
  const chain = new ProviderChain(providers, log);

  // Start gateway
  const server = createGatewayServer({ chain, log, port: env.PORT });
  server.on('listening', () => {
    log.info(
      {
        port: env.PORT,
        openrouterKeys: providers.openrouter.keyCount,
        openai: providers.openai.available,
        zai: providers.zai.available,
        opencode: providers.opencode.available,
      },
      'gateway listening',
    );
  });
  server.on('error', (err) => {
    log.error({ err: err.message }, 'server error');
    process.exit(1);
  });

  // Start Director + Slack poller (unified orchestrator)
  const orch = startOrchestrator({ chain, log });

  // Unified shutdown
  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down...`);
    orch.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Surface config
  const cfg = config();
  log.info(
    {
      walkAlias: cfg.env.WALK_ALIAS,
      openRouterModel: cfg.env.OPENROUTER_MODEL,
      forceFree: cfg.env.FORCE_FREE,
      directorInterval: cfg.env.DIRECTOR_INTERVAL_MINUTES,
      kafkaEnabled: cfg.env.KAFKA_ENABLED,
    },
    'config loaded',
  );
}

void main();
