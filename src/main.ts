/**
 * Gateway HTTP entrypoint. Boots the provider chain + HTTP server, and wires
 * SIGTERM/SIGINT to close the server gracefully (drain in-flight, then exit).
 */

// Load .env before any module that reads process.env. The dotenv import must be
// the very first side effect so config/env.ts sees the parsed values.
import 'dotenv/config';

import { config, loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createGatewayServer } from './gateway/server.js';
import { ProviderChain } from './providers/chain.js';
import { buildProviders } from './providers/instances.js';

function main(): void {
  const { env } = loadEnv();
  const log = createLogger(env, 'gateway');

  const providers = buildProviders(log);
  const chain = new ProviderChain(providers, log);

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
      'msrouter gateway listening',
    );
  });
  server.on('error', (err) => {
    log.error({ err: err.message }, 'server error');
    process.exit(1);
  });

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`${signal} received, shutting down gateway...`);
    server.close(() => process.exit(0));
    // Force exit after 10s if connections hang.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Surface the resolved config (no secrets) once at boot for operability.
  const cfg = config();
  log.info(
    {
      walkAlias: cfg.env.WALK_ALIAS,
      openRouterModel: cfg.env.OPENROUTER_MODEL,
      forceFree: cfg.env.FORCE_FREE,
    },
    'config loaded',
  );
}

void main();
