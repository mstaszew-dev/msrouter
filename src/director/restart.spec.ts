import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { killWorkerByPidfile, launchWorker, pollCdp, restartWorker } from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

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
    // 2^31-1 is beyond any valid pid_t; no such process can exist.
    writeFileSync(path, `${2 ** 31 - 1}\n`);
    const out = await killWorkerByPidfile(path);
    expect(out.killed).toBe(0);
  });

  it('returns killed=1 when the pid is live and exits after SIGTERM', async () => {
    const realKill = process.kill;
    const path = pidfilePath();
    writeFileSync(path, '4242\n');
    let calls = 0;
    // First call (signal 0, the liveness check) succeeds; second (SIGTERM)
    // succeeds; subsequent calls (the exit poll) throw ESRCH.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      calls++;
      if (calls <= 2) return true;
      const e = new Error('ESRCH') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    });
    try {
      const out = await killWorkerByPidfile(path);
      expect(out.killed).toBe(1);
      expect(out.pid).toBe(4242);
    } finally {
      vi.restoreAllMocks();
      // Drop the spy safely even if restoreAllMocks left state.
      (process.kill as unknown as { mockClear?: () => void }).mockClear?.();
      process.kill = realKill;
    }
  });

  it('returns killed=0 if the live pid never exits within the wait window', async () => {
    const realKill = process.kill;
    const path = pidfilePath();
    writeFileSync(path, '4243\n');
    // Every kill() call succeeds (process never exits).
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const out = await killWorkerByPidfile(path);
      expect(out.killed).toBe(0);
    } finally {
      process.kill = realKill;
    }
  }, 15_000);
});

describe('launchWorker', () => {
  it('spawns the runner and returns a pid + log path', async () => {
    // /usr/bin/true exits 0 immediately; a safe stand-in for the real launcher.
    const out = await launchWorker('/usr/bin/true', '/tmp');
    expect(out.pid).toBeGreaterThan(0);
    expect(out.logPath).toMatch(/^\/tmp\/director-worker-\d+\.log$/);
  });
});

describe('pollCdp', () => {
  it('returns false on a non-listening URL within timeout', async () => {
    // Port 1 is never listening on macOS; pollCdp must return false fast.
    const out = await pollCdp('http://127.0.0.1:1', 500);
    expect(out).toBe(false);
  });
});

describe('restartWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kills (no-op on missing pidfile), launches, and polls CDP', async () => {
    const pidfile = pidfilePath(); // missing -> kill is a no-op
    const out = await restartWorker({
      pidfile,
      runner: '/usr/bin/true',
      workspace: '/tmp',
      cdpUrl: 'http://127.0.0.1:1', // not listening -> poll returns false fast
      cdpTimeoutMs: 500,
      log: silent,
    });
    expect(out.pid).toBeGreaterThan(0);
    expect(out.logPath).toMatch(/director-worker-.*\.log$/);
  }, 15_000);
});
