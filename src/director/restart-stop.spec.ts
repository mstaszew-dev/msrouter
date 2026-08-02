import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// execFileSync defaults to the real implementation (needed by the
// real-process stopTree/childrenOf tests); detectWorker tests override it.
const realExec = vi.hoisted(() => ({
  execFileSync: null as unknown as typeof import('node:child_process')['execFileSync'],
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  realExec.execFileSync = actual.execFileSync;
  return {
    ...actual,
    execFileSync: vi.fn(((file: string, ...args: any[]) =>
      realExec.execFileSync(file, ...args)) as never),
  };
});

import { execFileSync, spawn as realSpawn } from 'node:child_process';

import { childrenOf, detectWorker, stopTree } from './restart.js';

const mockedExec = vi.mocked(execFileSync);

const silent = {
  warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined,
} as unknown as pino.Logger;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  // Reset to the real pass-through implementation between tests.
  mockedExec.mockImplementation(((file: string, ...args: any[]) =>
    realExec.execFileSync(file, ...args)) as never);
});

describe('detectWorker', () => {
  it('unions the launcher basename and the python agent child pattern', () => {
    mockedExec.mockImplementation(((file: string, args: string[]) => {
      if (file !== 'pgrep') throw new Error('no');
      const pattern = args[1] ?? '';
      if (pattern.includes('job-search-agent')) return '100\n';
      if (pattern.includes('campaign_agent.main')) return '200\n';
      throw new Error('pgrep: no match');
    }) as never);
    expect(detectWorker('/x/job-search-agent')).toEqual([100, 200]);
  });

  it('dedupes overlapping pids', () => {
    mockedExec.mockImplementation((() => '100\n') as never);
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
});
