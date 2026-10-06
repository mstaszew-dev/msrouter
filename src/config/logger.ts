/**
 * Structured pino logger. Redacts configured secret-ish keys so an
 * OPENROUTER_KEY or api key never reaches logs. Pretty output in dev, JSON in
 * production. See NODEJS_CODE_REVIEW.md section 7 (observability) + section 4
 * (secrets).
 */

import { multistream, pino } from 'pino';

import type { Env } from './env.js';
import { createLogFileWritable } from './file-log.js';

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
  // pino-pretty is a `transport`, and a transport OWNS stdout: setting both
  // transport and streams made pino-pretty win and the file stream was
  // silently dropped (no log file was ever written). They are mutually
  // exclusive, so enabling the file mirror turns pretty off and both stdout
  // and the file get plain JSON.
  const useFile = !!env.LOG_FILE;
  const redactPaths = buildRedactPaths(env.LOG_REDACT);
  return pino({
    name: component,
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]', remove: false },
    base: { service: 'msrouter', env: env.NODE_ENV },
    ...(isDev && !useFile
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
    // When LOG_FILE is set, mirror everything into a rotated file as well as
    // stdout. pino-pretty (dev transport) cannot be combined with a custom
    // stream, so the file mirror is plain JSON lines - greppable, and it is
    // the reason a chain failure is diagnosable after the tab is closed.
  }, useFile ? multistream([{ stream: process.stdout }, { stream: createFileStream(env) }]) : undefined);
}

/** Rotated file destination shaped like a pino stream (write/end). */
function createFileStream(env: Env) {
  return createLogFileWritable(
    env.LOG_FILE,
    env.LOG_FILE_MAX_BYTES,
    env.LOG_FILE_MAX_FILES,
  );
}
