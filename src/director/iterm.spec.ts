import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pino from 'pino';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
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

describe('iTerm ancestry guard', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic-import typing under the fs mock
  type ItermModule = typeof import('./iterm.js');
  type Lookup = NonNullable<Parameters<ItermModule['isItermInAncestry']>[1]>;
  let iterm: ItermModule;

  beforeAll(async () => {
    fsState.denyAll = false; // let module-load findRoot() find its fallback
    vi.resetModules();
    iterm = await import('./iterm.js');
  });

  // A fake ps: pid → {ppid, comm} map; unknown pids simulate a dead process.
  const chain =
    (map: Record<number, { ppid: number; comm: string }>): Lookup =>
    (pid) =>
      map[pid] ?? null;

  afterEach(() => {
    delete process.env['TERM_PROGRAM'];
    vi.restoreAllMocks();
  });

  it('is true when iTerm2 is a live ancestor', () => {
    const lookup = chain({
      100: { ppid: 200, comm: 'npm' },
      200: { ppid: 300, comm: 'zsh' },
      300: { ppid: 1, comm: 'iTerm2' },
    });
    expect(iterm.isItermInAncestry(100, lookup)).toBe(true);
  });

  it('is FALSE when the chain has no iTerm ancestor even with TERM_PROGRAM=iTerm.app', () => {
    // THE regression (2026-09-09): run.sh nohups the gateway, which detaches
    // to launchd within minutes; the inherited TERM_PROGRAM env var survived
    // and the old env-only guard passed for a fully detached process.
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    const lookup = chain({
      100: { ppid: 200, comm: 'node' },
      200: { ppid: 1, comm: 'launchd' },
    });
    expect(iterm.isItermInAncestry(100, lookup)).toBe(false);
  });

  it('is false when a dead ancestor fails the ps walk (fail closed)', () => {
    const lookup = chain({ 100: { ppid: 999, comm: 'npm' } }); // 999: dead
    expect(iterm.isItermInAncestry(100, lookup)).toBe(false);
  });

  it('walk terminates on a self-referential chain', () => {
    const lookup = chain({ 100: { ppid: 100, comm: 'init' } });
    expect(iterm.isItermInAncestry(100, lookup)).toBe(false);
  });

  it('assertInIterm exits when ancestry lacks iTerm even with TERM_PROGRAM set', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });
    const lookup = chain({ 100: { ppid: 1, comm: 'bash' } });

    expect(() => iterm.assertInIterm(100, lookup)).toThrow('process exited');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('assertInIterm passes when iTerm2 is an ancestor (no exit)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });
    const lookup = chain({
      100: { ppid: 200, comm: 'npm' },
      200: { ppid: 300, comm: 'zsh' },
      300: { ppid: 1, comm: 'iTerm2' },
    });

    expect(() => iterm.assertInIterm(100, lookup)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('headless mode (MSROUTER_HEADLESS, for k3s/Linux containers)', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic-import typing under the fs mock
  type ItermModule = typeof import('./iterm.js');
  type Lookup = NonNullable<Parameters<ItermModule['isItermInAncestry']>[1]>;
  let iterm: ItermModule;
  let realHome: string;

  beforeAll(async () => {
    fsState.denyAll = false;
    vi.resetModules();
    iterm = await import('./iterm.js');
  });

  beforeEach(() => {
    // Isolate the start-lock bookkeeping (~/.campaign-agent/agent-start.lock)
    // from the developer's real home, like the sibling describes do.
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-iterm-headless-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
    delete process.env['MSROUTER_HEADLESS'];
    delete process.env['TERM_PROGRAM'];
    vi.restoreAllMocks();
  });

  // No iTerm2 anywhere in the chain (the pod/container situation).
  const noIterm: Lookup = (pid) => (pid === 100 ? { ppid: 1, comm: 'bash' } : null);

  it('assertInIterm passes without iTerm ancestry when MSROUTER_HEADLESS is set', () => {
    process.env['MSROUTER_HEADLESS'] = '1';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });

    expect(() => iterm.assertInIterm(100, noIterm)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('assertInIterm still exits without iTerm ancestry when headless mode is unset', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });

    expect(() => iterm.assertInIterm(100, noIterm)).toThrow('process exited');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('startWorkerInIterm spawns the worker detached via bash (cwd, no osascript) when headless', async () => {
    process.env['MSROUTER_HEADLESS'] = '1';
    const { execFileSync, spawn } = await import('node:child_process');
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);

    iterm.startWorkerInIterm({
      entryCommand: 'job-search-agent',
      workspace: '/test/workspace',
      log: silent,
    });

    expect(vi.mocked(execFileSync)).not.toHaveBeenCalledWith(
      'osascript',
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'job-search-agent'],
      expect.objectContaining({ cwd: '/test/workspace', detached: true }),
    );
    // B1 regression: the spawn 'error' event must be handled or a spawn
    // failure (missing bash, EACCES) crashes the whole process.
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(silent.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/test/workspace' }),
      expect.stringContaining('headless'),
    );
  });

  it('startWorkerInIterm writes the worker log and closes the parent fd when the workspace is writable', async () => {
    process.env['MSROUTER_HEADLESS'] = '1';
    const { spawn } = await import('node:child_process');
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);
    const workspace = mkdtempSync(join(tmpdir(), 'director-iterm-workspace-'));

    iterm.startWorkerInIterm({
      entryCommand: 'job-search-agent',
      workspace,
      log: silent,
    });

    const stdio = vi.mocked(spawn).mock.calls[0]?.[2]?.stdio;
    expect(Array.isArray(stdio)).toBe(true); // ['ignore', fd, fd]
    // The spec's top-level existsSync is the mocked fs; use the real one so
    // the log-file assertion can actually fail.
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline typeof import() needed for importActual typing
    const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');
    expect(fsActual.existsSync(join(workspace, 'worker-headless.log'))).toBe(true);
  });

  it('startWorkerInIterm falls back to stdio ignore when the headless log file cannot be opened', async () => {
    process.env['MSROUTER_HEADLESS'] = '1';
    const { spawn } = await import('node:child_process');
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);

    iterm.startWorkerInIterm({
      entryCommand: 'job-search-agent',
      workspace: '/dev/null/not-a-dir',
      log: silent,
    });

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      '/bin/bash',
      expect.anything(),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('startKafkaInIterm spawns kafka.sh directly instead of osascript when headless', async () => {
    process.env['MSROUTER_HEADLESS'] = '1';
    const { execFileSync, spawn } = await import('node:child_process');
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);

    iterm.startKafkaInIterm({
      entryCommand: 'job-search-agent',
      workspace: '/test/workspace',
      log: silent,
    });

    expect(vi.mocked(execFileSync)).not.toHaveBeenCalledWith(
      'osascript',
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining([expect.stringContaining('kafka.sh'), 'start-or-init']),
      expect.objectContaining({ detached: true }),
    );
    expect(silent.info).toHaveBeenCalledWith('started Kafka in headless mode');
  });
});
