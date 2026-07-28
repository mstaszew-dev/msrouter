import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { detectWorker, pollCdp, snapshot } from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const opts = {
  runnerScript: '/Users/mst/ZCodeProject/openclaw-job-search/run-one-job',
  workspace: '/Users/mst/ZCodeProject/openclaw-job-search',
  cdpUrl: 'http://127.0.0.1:9222',
  log: silent,
};

describe('detectWorker', () => {
  it('returns a number[] of pids (length depends on whether campaign is running)', () => {
    // We only assert the shape; whether the campaign is up is environment-dependent.
    const pids = detectWorker(opts.runnerScript);
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    }
  });

  it('returns [] for a runner script name that nothing matches', () => {
    const pids = detectWorker('/this/path/does/not/exist/zzz-not-a-real-script-9999');
    expect(pids).toEqual([]);
  });
});

describe('snapshot', () => {
  it('returns a SuperviseState with running flag consistent with pids', () => {
    const s = snapshot(opts);
    expect(s).toHaveProperty('pids');
    expect(s).toHaveProperty('running');
    expect(Array.isArray(s.pids)).toBe(true);
    expect(s.running).toBe(s.pids.length > 0);
  });
});

describe('pollCdp', () => {
  it('returns false on a non-listening URL within timeout', async () => {
    // Port 1 is never listening on macOS; pollCdp must return false fast.
    const out = await pollCdp('http://127.0.0.1:1', 500);
    expect(out).toBe(false);
  });
});
