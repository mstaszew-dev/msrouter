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
  // execFile is stubbed as an async callback: promisify(execFile) wraps it, and
  // detection is async precisely so a JVM probe cannot freeze the event loop.
  // execFile carries util.promisify.custom in real Node; promisify then resolves
  // to { stdout, stderr }. Attaching the same symbol here keeps the mocked probe
  // on the REAL promisify path, so tests exercise the production contract
  // instead of relying on a production fallback for a generic-promisify result.
  const execFileMock = vi.fn();
  (execFileMock as unknown as Record<symbol, unknown>)[
    (await import('node:util')).promisify.custom
  ] = (file: string, _args: readonly string[], opts: { encoding?: string }) =>
    new Promise((resolve, reject) => {
      execFileMock(file, _args, opts, (e: Error | null, stdout: string, stderr: string) => {
        if (e) reject(e);
        else resolve({ stdout, stderr });
      });
    });
  return { ...actual, execFileSync: vi.fn(() => ''), execFile: execFileMock };
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

// 2026-10-03 (review of kafka instance detection): isKafkaRunning hardcoded
// port 19092 and accepted ANY listener on it, so a non-Kafka process on 19092
// read as "broker running" and a broker on a KAFKA_PORT-overridden port was
// invisible (the Director then kept spawning duplicate tabs). These tests pin
// the fixed contract: derive the port from the bootstrap config, and require a
// real broker on it, not merely a bound socket.
describe('isKafkaRunning - port-aware and broker-verified', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic-import typing under the fs mock
  type ItermModule = typeof import('./iterm.js');

  beforeAll(async () => {
    fsState.denyAll = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub the two async probes detection shells out to (lsof, kafka-topics.sh). */
  async function stubProbes(o: { listener: string; topicsExit: number }) {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((
      ...callArgs: unknown[]
    ) => {
      const file = String(callArgs[0]);
      const cb = callArgs[callArgs.length - 1] as (
        e: Error | null,
        out: string,
        err: string,
      ) => void;
      if (file === 'lsof') {
        cb(null, o.listener, '');
        return;
      }
      // kafka-topics.sh: a non-zero exit arrives as an error to the callback.
      if (o.topicsExit !== 0) {
        cb(new Error('topics failed'), '', '');
        return;
      }
      cb(null, 'director-events\n', '');
    }) as never);
  }

  it('derives the port from KAFKA_BOOTSTRAP rather than hardcoding 19092', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubProbes({ listener: 'java 123 1 0x0 0 0 TCP *:29092 (LISTEN)', topicsExit: 0 });
    const running = await iterm.isKafkaRunningWith('broker.example.com:29092', 'kafka-home');

    expect(running).toBe(true);
    // The lsof call must target 29092, proving the port came from the config.
    const { execFile } = await import('node:child_process');
    const lsofArgs = vi
      .mocked(execFile)
      .mock.calls.filter((c) => c[0] === 'lsof')
      .map((c) => (c[1] as readonly string[]).join(' '));
    expect(lsofArgs.join(' ')).toContain('29092');
    expect(lsofArgs.join(' ')).not.toContain('19092');
  });

  it('is FALSE when something that is not Kafka holds the port', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubProbes({ listener: 'nc 999 1 0x0 0 0 TCP *:19092 (LISTEN)', topicsExit: 1 });

    expect(await iterm.isKafkaRunningWith('localhost:19092', 'kafka-home')).toBe(false);
  });

  it('is FALSE when no process holds the port at all', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubProbes({ listener: '', topicsExit: 1 });

    expect(await iterm.isKafkaRunningWith('localhost:19092', 'kafka-home')).toBe(false);
  });

  it('is TRUE only when the port is held AND the topic API answers', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubProbes({ listener: 'java 123 1 0x0 0 0 TCP *:19092 (LISTEN)', topicsExit: 0 });

    expect(await iterm.isKafkaRunningWith('localhost:19092', 'kafka-home')).toBe(true);
  });

  it('does not throw when the lsof probe itself fails', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (
        e: Error | null,
        out: string,
        err: string,
      ) => void;
      cb(new Error('lsof not found'), '', '');
    }) as never);

    expect(await iterm.isKafkaRunningWith('localhost:19092', 'kafka-home')).toBe(false);
  });
});
