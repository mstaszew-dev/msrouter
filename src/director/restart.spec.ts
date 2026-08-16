vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { detectWorker, detectProcess, ensureOverrideFiles, isStartLocked, pollCdp, readStartLock, snapshot, startWorkerInIterm, startKafkaInIterm } from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const kafkaOpts = {
  entryCommand: 'job-search-agent',
  workspace: '/test/workspace',
  cdpUrl: 'http://127.0.0.1:9222',
  log: silent,
};

describe('detectWorker', () => {
  it('returns a number[] of pids (length depends on whether campaign is running)', () => {
    const pids = detectWorker(kafkaOpts.entryCommand);
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    }
  });

  it('returns a number[] even when only the python child pattern matches', () => {
    const pids = detectWorker('/this/path/does/not/exist/zzz-not-a-real-script-9999');
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe('snapshot', () => {
  it('returns a SuperviseState with running flag consistent with pids', () => {
    const s = snapshot(kafkaOpts);
    expect(s).toHaveProperty('pids');
    expect(s).toHaveProperty('running');
    expect(Array.isArray(s.pids)).toBe(true);
    expect(s.running).toBe(s.pids.length > 0);
  });
});

describe('pollCdp', () => {
  it('returns false on a non-listening URL within timeout', async () => {
    const out = await pollCdp('http://127.0.0.1:1', 500);
    expect(out).toBe(false);
  });
});

describe('ensureOverrideFiles', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = process.env['HOME']!;
    const tmpHome = mkdtempSync(join(tmpdir(), 'director-restart-home-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('creates director-overrides.env if missing', () => {
    ensureOverrideFiles();
    const envPath = join(process.env['HOME']!, '.campaign-agent', 'director-overrides.env');
    expect(existsSync(envPath)).toBe(true);
  });

  it('creates director-prompt-overrides.md if missing', () => {
    ensureOverrideFiles();
    const mdPath = join(process.env['HOME']!, '.campaign-agent', 'director-prompt-overrides.md');
    expect(existsSync(mdPath)).toBe(true);
  });

  it('does not overwrite existing files', () => {
    // Pre-create with content
    ensureOverrideFiles();
    const envPath = join(process.env['HOME']!, '.campaign-agent', 'director-overrides.env');
    writeFileSync(envPath, 'EXISTING_KEY=1\n');

    // Call again; should not truncate
    ensureOverrideFiles();
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('EXISTING_KEY=1');
  });
});

describe('detectProcess', () => {
  it('returns pids for a running process pattern (launchd)', () => {
    const pids = detectProcess('launchd');
    expect(pids.length).toBeGreaterThan(0);
    expect(pids[0]).toBeGreaterThan(0);
  });

  it('returns [] for a non-existent pattern', () => {
    const pids = detectProcess('zzz-this-does-not-exist-9999');
    expect(pids).toEqual([]);
  });
});

describe('startKafkaInIterm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts Kafka in a separate iTerm tab', () => {
    startKafkaInIterm(kafkaOpts);
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    expect(firstCall[0]).toBe('osascript');
    expect(firstCall[1][0]).toContain('kafka');
    expect(firstCall[1][0]).toContain('scripts/kafka.sh');
  });
});