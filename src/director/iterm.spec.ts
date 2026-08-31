import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared switchboard so each test can steer the partially-mocked fs.
const fsState = vi.hoisted(() => ({
  // true: existsSync always lies (findRoot walks off the repo and hits its
  // fallback); false: first 5 checks lie, the fallback check tells the truth.
  denyAll: true,
  failWrite: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:fs')>();
  let existsCalls = 0;
  return {
    ...actual,
    existsSync: (_path: Parameters<typeof actual.existsSync>[0]) => {
      if (fsState.denyAll) return false;
      existsCalls += 1;
      // The 5-step walk up from this module all "fail"; the fallback check
      // (call #6) succeeds so findRoot() returns the validated fallback.
      return existsCalls > 5;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsState.failWrite) throw new Error('disk full');
      return actual.writeFileSync(...args);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(() => '') };
});

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('findRoot (module-load resolution of MSROUTER_ROOT)', () => {
  it('throws an actionable error when scripts/kafka.sh cannot be located anywhere', async () => {
    fsState.denyAll = true;
    // Module-level findRoot() rejects the whole import when neither the walk
    // nor the fallback can validate scripts/kafka.sh.
    await expect(import('./iterm.js')).rejects.toThrow(/findRoot\(\) failed/);
  });

  it('falls back to the validated two-levels-up root when the walk fails', async () => {
    fsState.denyAll = false;
    vi.resetModules();
    const iterm = await import('./iterm.js');
    const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
    expect(iterm.MSROUTER_ROOT).toBe(srcDir);
  });
});

describe('startWorkerInIterm - best-effort start-lock write', () => {
  let realHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    fsState.failWrite = false;
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-iterm-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('still launches the agent when writing the start lock fails', async () => {
    const iterm = await import('./iterm.js');
    fsState.failWrite = true; // writeFileSync(lockPath) throws EACCES-style error
    iterm.startWorkerInIterm({
      entryCommand: 'job-search-agent',
      workspace: '/test/workspace',
      log: silent,
    });
    // The launch proceeded despite the failed lock bookkeeping.
    expect(silent.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/test/workspace' }),
      'started campaign worker in iTerm2',
    );
    const { execFileSync } = await import('node:child_process');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'osascript',
      expect.anything(),
      expect.anything(),
    );
  });
});
