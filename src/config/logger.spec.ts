import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

/**
 * Regression: with LOG_FILE set in development, the logger set BOTH
 * `transport: pino-pretty` and `streams`. pino-pretty owns stdout via
 * transport, so the file stream was silently dropped and no log file was ever
 * written - the exact gap this feature was added to close.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msrouter-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createLogger - LOG_FILE', () => {
  it('writes a log line to LOG_FILE in development mode', async () => {
    const file = join(dir, 'msrouter.log');
    const log = createLogger(
      {
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        LOG_REDACT: [],
        LOG_FILE: file,
        LOG_FILE_MAX_BYTES: 1_000_000,
        LOG_FILE_MAX_FILES: 3,
      } as never,
    );
    log.info('durable-log-probe');
    // pino writes synchronously to our fd-backed stream; give the event loop
    // a tick so any async transport setup can settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('durable-log-probe');
  });

  it('still logs to stdout when LOG_FILE is empty', async () => {
    // No file, no streams override: the previous stdout-only behavior.
    const log = createLogger({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      LOG_REDACT: [],
      LOG_FILE: '',
      LOG_FILE_MAX_BYTES: 1_000_000,
      LOG_FILE_MAX_FILES: 3,
    } as never);
    expect(() => log.info('stdout-probe')).not.toThrow();
  });
});