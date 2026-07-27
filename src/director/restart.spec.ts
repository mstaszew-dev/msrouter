import type pino from 'pino';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { killWorkerByPidfile, pollCdp } from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;
void silent;

function pidfilePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'director-restart-')), 'pid');
}

describe('killWorkerByPidfile', () => {
  it('returns killed=0 when pidfile is missing', async () => {
    const out = await killWorkerByPidfile(pidfilePath());
    expect(out.killed).toBe(0);
    expect(out.pid).toBeUndefined();
  });

  it('returns killed=0 when pidfile contains garbage', async () => {
    const path = pidfilePath();
    writeFileSync(path, 'not-a-number\n');
    const out = await killWorkerByPidfile(path);
    expect(out.killed).toBe(0);
  });

  it('returns killed=0 when the pid is not a live process', async () => {
    const path = pidfilePath();
    writeFileSync(path, '999999\n');
    const out = await killWorkerByPidfile(path);
    expect(out.killed).toBe(0);
  });
});

describe('pollCdp', () => {
  it('returns false on a non-listening URL within timeout', async () => {
    // Port 1 is never listening on macOS; pollCdp must return false fast.
    const out = await pollCdp('http://127.0.0.1:1', 500);
    expect(out).toBe(false);
  });
});
