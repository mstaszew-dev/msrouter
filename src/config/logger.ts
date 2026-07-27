/**
 * Structured pino logger. Redacts configured secret-ish keys so an
 * OPENROUTER_KEY or api key never reaches logs. Pretty output in dev, JSON in
 * production. See NODEJS_CODE_REVIEW.md section 7 (observability) + section 4
 * (secrets).
 */

import { pino } from 'pino';

import type { Env } from './env.js';

/**
 * Build pino redact paths from the CSV of secret substrings. pino redact uses
 * dot-notation paths where `*` is a full-segment wildcard. We seed well-known
 * locations and add each key at common nesting depths.
 */
export function buildRedactPaths(keys: readonly string[]): string[] {
  const paths = new Set<string>([
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    '*.headers.authorization',
    '*.authorization',
  ]);
  for (const k of keys) {
    const lower = k.toLowerCase();
    paths.add(`*.${lower}`);
    paths.add(`*.*.${lower}`);
  }
  paths.add('req.headers.*');
  paths.add('headers.*');
  return [...paths];
}

export function createLogger(env: Env, component = 'msrouter') {
  const isDev = env.NODE_ENV === 'development';
  const redactPaths = buildRedactPaths(env.LOG_REDACT);
  return pino({
    name: component,
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]', remove: false },
    base: { service: 'msrouter', env: env.NODE_ENV },
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
      : undefined,
  });
}
