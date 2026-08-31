import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// execFileSync defaults to the real implementation (needed by the
// real-process stopTree/childrenOf tests); detectWorker tests override it.
const realExec = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  execFileSync: null as unknown as typeof execFileSync,
}));
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
vi.mock('node:child_process', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:child_process')>();
  realExec.execFileSync = actual.execFileSync;
  return {
    ...actual,
    execFileSync: vi.fn((realExec.execFileSync as (...a: unknown[]) => unknown).bind(realExec)),
  };
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import {
  childrenOf,
  detectWorker,
  ensureInfrastructureHealthy,
  isOrphaned,
  snapshot,
  stopTree,
} from './restart.js';

const mockedExec = vi.mocked(execFileSync);

const silent = {
  warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined,
} as unknown as pino.Logger;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  // Reset to the real pass-through implementation between tests.
  mockedExec.mockImplementation(
    (realExec.execFileSync as (...a: unknown[]) => unknown).bind(realExec) as never,
  );
});

describe('snapshot', () => {
  it('marks orphaned as true when all detected processes have PPID 1', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'pgrep') return '100\n';
      if (file === 'ps' && args.includes('-o')) return '  1\n';
      throw new Error('unexpected');
    }) as never);
    const state = snapshot({ entryCommand: 'x', workspace: '/tmp', cdpUrl: '', log: silent });
    expect(state.running).toBe(true);
    expect(state.orphaned).toBe(true);
  });

  it('marks orphaned as false when process has a real parent', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'pgrep') return '100\n';
      if (file === 'ps' && args.includes('-o')) return '  90090\n';
      throw new Error('unexpected');
    }) as never);
    const state = snapshot({ entryCommand: 'x', workspace: '/tmp', cdpUrl: '', log: silent });
    expect(state.running).toBe(true);
    expect(state.orphaned).toBe(false);
  });

  it('marks orphaned as false when no processes are running', () => {
    mockedExec.mockImplementation(() => {
      throw new Error('no match');
    });
    const state = snapshot({ entryCommand: 'x', workspace: '/tmp', cdpUrl: '', log: silent });
    expect(state.running).toBe(false);
    expect(state.orphaned).toBe(false);
  });
});

describe('isOrphaned', () => {
  it('returns true when process parent is PID 1 (init)', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'ps' && args.includes('-o')) return '  1\n';
      throw new Error('unexpected call');
    }) as never);
    expect(isOrphaned(12345)).toBe(true);
  });

  it('returns false when process has a real parent', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'ps' && args.includes('-o')) return '  90090\n';
      throw new Error('unexpected call');
    }) as never);
    expect(isOrphaned(12345)).toBe(false);
  });

  it('returns false when ps fails (process dead or unknown)', () => {
    mockedExec.mockImplementation(() => {
      throw new Error('ps: no such process');
    });
    expect(isOrphaned(12345)).toBe(false);
  });
});

describe('detectWorker', () => {
  it('unions the launcher basename and the python agent child pattern', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file !== 'pgrep') throw new Error('no');
      const pattern = args[1] ?? '';
      if (pattern.includes('job-search-agent-hermes')) return '100\n';
      if (pattern.includes('jobhermes')) return '200\n';
      throw new Error('pgrep: no match');
    }) as never);
    expect(detectWorker('/x/job-search-agent-hermes')).toEqual([100, 200]);
  });

  it('dedupes overlapping pids', () => {
    mockedExec.mockImplementation((() => '100\n'));
    expect(detectWorker('/x/job-search-agent')).toEqual([100]);
  });
});

describe('childrenOf', () => {
  it('lists direct child pids of a process', async () => {
    const child = realSpawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const kids = childrenOf(process.pid);
      expect(kids).toContain(child.pid);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns [] for a dead/nonexistent pid', () => {
    expect(childrenOf(999_999_999)).toEqual([]);
  });
});

describe('stopTree', () => {
  it('kills a process and all its descendants', async () => {
    const parent = realSpawn('/bin/zsh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    await sleep(300);
    const parentPid = parent.pid!;
    const grandchildPids = childrenOf(parentPid);
    expect(grandchildPids.length).toBeGreaterThan(0);

    const killed = await stopTree([parentPid], silent);
    expect(killed).toContain(parentPid);
    expect(alive(parentPid)).toBe(false);
    for (const g of grandchildPids) {
      expect(alive(g)).toBe(false);
    }
  }, 15000);

  it('does not throw on an already-dead pid', async () => {
    const killed = await stopTree([999_999_999], silent);
    expect(Array.isArray(killed)).toBe(true);
  });

  it('SIGKILL survivors that ignore SIGTERM', async () => {
    const child = realSpawn('node', [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ], { stdio: 'ignore' });
    await sleep(300);
    const childPid = child.pid!;
    expect(alive(childPid)).toBe(true);

    const killed = await stopTree([childPid], silent, 500);
    expect(killed).toContain(childPid);
    await sleep(100);
    expect(alive(childPid)).toBe(false);
  }, 15000);
});

describe('ensureInfrastructureHealthy completion guard', () => {
  it('does NOT restart the campaign when the target is already met', async () => {
    // Regression: a finished campaign (submitted >= target) exits on purpose.
    // Missing playwright-mcp used to trigger restartWorker -> startWorkerInIterm,
    // re-opening iTerm tabs forever. The completion guard must short-circuit
    // even when infrastructure is unhealthy.
    const dir = mkdtempSync(join(tmpdir(), 'director-infra-done-'));
    writeFileSync(
      join(dir, 'tracker.json'),
      JSON.stringify({ stats: { submitted: 1200 }, targetApplications: 1200, target: 1200 }),
    );
    const opts = {
      entryCommand: 'job-search-agent',
      workspace: '/tmp/x',
      cdpUrl: 'http://127.0.0.1:9222',
      log: silent,
      campaignDir: dir,
    };
    // Infrastructure will report playwright-mcp missing, but the guard must
    // still return false (no restart) because the campaign is complete.
    const restarted = await ensureInfrastructureHealthy(opts);
    expect(restarted).toBe(false);
  });
});
