/**
 * Admin console entrypoint: loads env, opens the users flat file, and serves
 * the admin API + built web console on ADMIN_PORT (default 8790). Deliberately
 * separate from src/main.ts (the gateway + Director) so the console can run
 * without provider keys and can never influence routing.
 *
 * Start with: npm run admin        (from dist)  |  npm run admin:dev  (tsx)
 */

import 'dotenv/config';

import { join } from 'node:path';

import { env, loadEnv } from '../config/env.js';
import { createLogger } from '../config/logger.js';

import { parseAdminEnv } from './config.js';
import type { ObsDeps } from './obs.js';
import { RateLimiter } from './rateLimit.js';
import { createAdminServer } from './server.js';
import { UserStore } from './userStore.js';

async function main(): Promise<void> {
  const adminEnv = parseAdminEnv();
  // The gateway env module needs explicit initialization before env().
  loadEnv();
  const gatewayEnv = env();
  const log = createLogger(gatewayEnv, 'msrouter-admin');

  if (adminEnv.jwtSecretEphemeral) {
    log.warn(
      'JWT_SECRET not set: using an ephemeral secret (sessions reset on restart). Set JWT_SECRET in .env.',
    );
  }

  const store = await UserStore.load(adminEnv.USERS_FILE);

  const ledgerPath =
    gatewayEnv.DIRECTOR_LEDGER ||
    join(gatewayEnv.DIRECTOR_OPENCLAW_WORKSPACE, 'director', 'ledger.jsonl');
  const checkpointPath = join(
    gatewayEnv.DIRECTOR_OPENCLAW_WORKSPACE,
    'director',
    'checkpoint.json',
  );
  const ragDbPath =
    gatewayEnv.DIRECTOR_RAG_DB || join(gatewayEnv.DIRECTOR_OPENCLAW_WORKSPACE, 'rag', 'index.db');

  const obsDeps: ObsDeps = {
    gatewayBaseUrl: adminEnv.GATEWAY_URL,
    gatewayToken: gatewayEnv.GATEWAY_TOKEN || undefined,
    fetchImpl: fetch,
    ledgerPath,
    checkpointPath,
    ragDbPath,
    kafkaEnabled: gatewayEnv.KAFKA_ENABLED,
    kafkaBootstrap: gatewayEnv.KAFKA_BOOTSTRAP,
    slackConfigured: Boolean(gatewayEnv.SLACK_BOT_TOKEN || gatewayEnv.SLACK_WEBHOOK),
  };

  const server = createAdminServer({
    store,
    storePath: adminEnv.USERS_FILE,
    jwtSecret: adminEnv.JWT_SECRET,
    tokenTtlSeconds: adminEnv.JWT_TTL_SECONDS,
    rateLimiter: new RateLimiter({ maxAttempts: 5, windowMs: 60_000 }),
    obsDeps,
    webDistDir: adminEnv.WEB_DIST,
    log,
  });

  server.listen(adminEnv.ADMIN_PORT, () => {
    log.info(
      `admin console on http://127.0.0.1:${adminEnv.ADMIN_PORT} (users: ${adminEnv.USERS_FILE})`,
    );
  });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down admin console`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  // Bootstrap errors (bad env, missing users file) must be visible on stderr.
  console.error('admin console failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
