vi.mock('node:child_process', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:child_process')>();
  // detection is async: promisify(execFile) appends (options, callback), so the
  // callback is always the LAST argument.
  // Detection probes via promisify(execFile). A mocked execFile has no
  // promisify.custom symbol, so generic promisify resolves the raw 2nd callback
  // arg; stubKafkaProbe drives that path directly.
  const execFileMock = vi.fn(
    (...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (e: Error | null, out: string) => void;
      cb(new Error('execFile not stubbed'), '');
    },
  );
  return { ...actual, execFileSync: vi.fn(), execFile: execFileMock, spawn: vi.fn() };
});
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  __resetKafkaSpawnCooldown,
  __resetKafkaFailureState,
  assertInIterm,
  checkInfrastructure,
  detectWorker,
  detectProcess,
  ensureCdpRunning,
  ensureInfrastructureHealthy,
  ensureOverrideFiles,
  isInIterm,
  isRunningInIterm,
  pollCdp,
  restartWorker,
  snapshot,
  startChromeCdp,
  startWorkerInIterm,
  startKafkaInIterm,
  waitForStartup,
} from './restart.js';


/**
 * Stub the async broker probe used by isKafkaRunningWith.
 * `lsof` reports the listener; `kafka-topics.sh` succeeds only when a real
 * broker answers.
 */
async function stubKafkaProbe(o: { listener: string; brokerUp: boolean }): Promise<void> {
  const { execFile } = await import('node:child_process');
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    const file = String(callArgs[0]);
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, out: string) => void;
    if (file === 'lsof') {
      cb(null, o.listener);
      return;
    }
    if (o.brokerUp) cb(null, 'director-events\n');
    else cb(new Error('not a broker'), '');
  }) as never);
}

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const kafkaOpts = {
  kafkaBootstrap: 'localhost:19092',
  kafkaHome: '/fake/kafka',
  entryCommand: '/Users/mst/bin/job-search-agent',
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
  it('returns pids for a matching pattern', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('4242\n4243\n');
    const pids = detectProcess('my-process');
    expect(pids).toEqual([4242, 4243]);
  });

  it('returns [] for a non-existent pattern', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('');
    const pids = detectProcess('zzz-this-does-not-exist-9999');
    expect(pids).toEqual([]);
  });
});

describe('startKafkaInIterm', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetKafkaSpawnCooldown();
    __resetKafkaFailureState();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-kafka-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('starts Kafka via start-or-init in an iTerm tab when broker is not running', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });
    await startKafkaInIterm(kafkaOpts);
    const calls = vi.mocked(execFileSync).mock.calls;
    const osaCalls = calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    const script = osaCalls[0]![1]![1]!;
    expect(script).toContain('kafka');
    expect(script).toContain('scripts/kafka.sh');
    expect(script).toContain('bash scripts/kafka.sh start-or-init');
    expect(script).toContain('bash scripts/kafka.sh monitor');
    expect(script).not.toContain('tell current session of newTab');
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    expect(script).toContain(`cd ${repoRoot}`);
    expect(script).not.toContain('/test/workspace');
  });

  // 2026-10-03: detection used to treat ANY listener on 19092 as "broker up",
  // so this stub only had to satisfy lsof. It now also requires a real broker
  // (kafka-topics.sh answering), which is what makes a hijacked port
  // distinguishable from a healthy broker.
  it('skips spawn when a real Kafka broker is already listening', async () => {
    await stubKafkaProbe({ listener: 'java  12345  mst  5u  IPv4  *:19092 (LISTEN)\n', brokerUp: true });
    await startKafkaInIterm(kafkaOpts);
    expect(execFileSync).not.toHaveBeenCalledWith('osascript', expect.anything());
  });

  // The bug that produced duplicate broker+monitor tabs: a non-Kafka process
  // holding the port read as "broker running", so the Director skipped the real
  // start. It must now start.
  it('does NOT skip spawn when a non-Kafka process holds the port', async () => {
    await stubKafkaProbe({ listener: 'nc  999  mst  5u  IPv4  *:19092 (LISTEN)\n', brokerUp: false });
    await startKafkaInIterm(kafkaOpts);
    const osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
  });

  it('finds a broker listening on a non-default KAFKA_BOOTSTRAP port', async () => {
    // The hardcoded-19092 bug: a broker on 29092 was invisible, so every tick
    // opened another tab.
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
      const file = String(callArgs[0]);
      const args = (callArgs[1] ?? []) as readonly string[];
      const cb = callArgs[callArgs.length - 1] as (e: Error | null, out: string) => void;
      if (file === 'lsof') {
        if (String(args).includes('19092')) cb(null, ''); // old code probed this
        else cb(null, 'java  12345  mst  5u  IPv4  *:29092 (LISTEN)\n');
        return;
      }
      cb(null, 'director-events\n');
    }) as never);
    await startKafkaInIterm({ ...kafkaOpts, kafkaBootstrap: 'localhost:29092' });
    const osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);
  });

  it('does not spam tabs when Kafka repeatedly fails to start (cooldown)', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });
    await startKafkaInIterm(kafkaOpts);
    let osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    vi.mocked(execFileSync).mockClear();
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);
  });

  it('rethrows when osascript fails in startKafkaInIterm', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      throw new Error('osascript failed');
    });
    // startKafkaInIterm is async (the broker probe must not block the gateway
    // event loop), so the failure surfaces as a rejected promise.
    await expect(startKafkaInIterm(kafkaOpts)).rejects.toThrow(
      'iTerm2 launch failed (is iTerm2 installed and running?). Start Kafka manually.',
    );
  });

  it('uses exponential backoff after consecutive Kafka start failures', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });
    const origNow = Date.now;

    // Failure #1 at t=0: backoff becomes 120s
    await startKafkaInIterm(kafkaOpts);
    let osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    vi.mocked(execFileSync).mockClear();

    // t=61s: within 120s backoff -> skip
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 61_000);
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);

    // t=121s: past 120s backoff -> failure #2, backoff becomes 240s
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 121_000);
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    vi.mocked(execFileSync).mockClear();

    // t=300s: within 240s of second attempt -> skip
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 300_000);
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);

    // t=362s: past 240s of second attempt -> failure #3, backoff becomes 480s
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 362_000);
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    vi.mocked(execFileSync).mockClear();

    // t=700s: within 480s of third attempt -> skip
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 700_000);
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);

    Date.now = origNow;
  });

  it('resets backoff when broker is detected running', async () => {
    // First: make a failed attempt to build up failures
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });
    await startKafkaInIterm(kafkaOpts);
    let osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    vi.mocked(execFileSync).mockClear();

    // Now broker is running: should skip and reset the failure ladder.
    vi.mocked(execFileSync).mockClear();
    await stubKafkaProbe({
      listener: 'java  12345  mst  5u  IPv4  *:19092 (LISTEN)\n',
      brokerUp: true,
    });
    await startKafkaInIterm(kafkaOpts);
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(0);

    // Advance past original cooldown (60s): should open because failures were reset
    const origNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 65_000);
    vi.mocked(execFileSync).mockClear();
    // Broker is down again; detection must use the async probe to see that.
    await stubKafkaProbe({ listener: '', brokerUp: false });
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });
    await startKafkaInIterm(kafkaOpts);
    // After reset, cooldown is back to 60s base; 65s > 60s so it should fire
    osaCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    Date.now = origNow;
  });

  it('warns after multiple consecutive Kafka start failures', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('not found');
      return '';
    });

    // 3 consecutive failures to trigger warning (backoff: 60->120->240s)
    const origNow = Date.now;
    await startKafkaInIterm(kafkaOpts); // failure #1
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 121_000);
    await startKafkaInIterm(kafkaOpts); // failure #2
    vi.spyOn(Date, 'now').mockReturnValue(origNow() + 362_000);
    await startKafkaInIterm(kafkaOpts); // failure #3

    expect(silent.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failures: 3 }),
      expect.stringContaining('Kafka has failed to start multiple times'),
    );
    Date.now = origNow;
  });
});

describe('isInIterm', () => {
  it('returns true when pgrep finds iTerm2', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('4242\n');
    expect(isInIterm()).toBe(true);
  });

  it('returns false when pgrep finds nothing', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('');
    expect(isInIterm()).toBe(false);
  });

  it('returns false when pgrep is unavailable', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('pgrep not found');
    });
    expect(isInIterm()).toBe(false);
  });
});

describe('isRunningInIterm', () => {
  let savedTermProgram: string | undefined;

  beforeEach(() => {
    savedTermProgram = process.env['TERM_PROGRAM'];
  });

  afterEach(() => {
    if (savedTermProgram === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = savedTermProgram;
    }
  });

  it('returns true when TERM_PROGRAM is iTerm.app', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(isRunningInIterm()).toBe(true);
  });

  it('returns false when TERM_PROGRAM is Apple_Terminal', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    expect(isRunningInIterm()).toBe(false);
  });

  it('returns false when TERM_PROGRAM is undefined', () => {
    delete process.env['TERM_PROGRAM'];
    expect(isRunningInIterm()).toBe(false);
  });

  it('returns false when TERM_PROGRAM is vscode', () => {
    process.env['TERM_PROGRAM'] = 'vscode';
    expect(isRunningInIterm()).toBe(false);
  });
});

describe('assertInIterm', () => {
  let savedTermProgram: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: ReturnType<typeof vi.spyOn<any, 'exit'>>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedTermProgram = process.env['TERM_PROGRAM'];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedTermProgram === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = savedTermProgram;
    }
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('does not exit when running inside iTerm2', () => {
    // Ancestry-based guard (2026-09-09): TERM_PROGRAM is inherited env and
    // proves nothing; this process's real parent chain decides. In vitest the
    // chain is vitest/node (no iTerm2), so inject an iTerm2-terminated chain.
    const lookup = (pid: number) =>
      pid === 1 ? { ppid: 0, comm: 'launchd' } : { ppid: 1, comm: 'iTerm2' };
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    // 'darwin' is pinned: assertInIterm also hard-refuses non-macOS, and this
    // case is about the ancestry guard, not the platform gate.
    assertInIterm(process.pid, lookup, 'darwin');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 1 when the parent chain has no iTerm2 (Apple_Terminal env included)', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    // real ps walk (lookup defaults when undefined): vitest's chain has no iTerm2
    assertInIterm(process.pid, undefined, 'darwin');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no live iTerm2 process'),
    );
  });

  it('exits with code 1 when TERM_PROGRAM is unset', () => {
    delete process.env['TERM_PROGRAM'];
    // real ps walk (lookup defaults when undefined): vitest's chain has no iTerm2
    assertInIterm(process.pid, undefined, 'darwin');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('TERM_PROGRAM=(unset)'),
    );
  });
});

describe('startChromeCdp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns Chrome with remote debugging on the cdpUrl port', () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    startChromeCdp('http://127.0.0.1:9333');
    const [file, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(args).toContain('--remote-debugging-port=9333');
  });

  it('defaults the port to 9222 when absent', () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    startChromeCdp('http://localhost');
    const args = vi.mocked(spawn).mock.calls[0]![1];
    expect(args).toContain('--remote-debugging-port=9222');
  });
});

describe('ensureCdpRunning', () => {
  it('launches Chrome when CDP is not reachable', async () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    await ensureCdpRunning('http://127.0.0.1:1');
    expect(spawn).toHaveBeenCalled();
  });
});

describe('checkInfrastructure', () => {
  it('flags components as alive when their processes are found', () => {
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const status = checkInfrastructure();
    expect(status).toEqual({
      cdpAlive: true,
      playwrightMcpAlive: true,
    });
  });

  it('flags all as down when no processes are found', () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const status = checkInfrastructure();
    expect(status).toEqual({
      cdpAlive: false,
      playwrightMcpAlive: false,
    });
  });
});

describe('waitForStartup', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-waitstart-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('resolves true when the worker registers and clears the lock', async () => {
    const lockPath = join(process.env['HOME']!, '.campaign-agent', 'agent-start.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '123\n456\n');
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const up = await waitForStartup(kafkaOpts, 1000);
    expect(up).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('resolves false when the worker never registers', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const up = await waitForStartup(kafkaOpts, 1);
    expect(up).toBe(false);
  });

  it('resolves true even when clearing the start lock fails (best-effort)', async () => {
    // A directory where the lock file should live makes writeFileSync throw
    // (EISDIR); waitForStartup must treat lock bookkeeping as best-effort.
    const lockPath = join(process.env['HOME']!, '.campaign-agent', 'agent-start.lock');
    mkdirSync(lockPath, { recursive: true });
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const up = await waitForStartup(kafkaOpts, 1000);
    expect(up).toBe(true);
  });
});

describe('startWorkerInIterm', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-worker-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('starts the worker in an iTerm tab', () => {
    startWorkerInIterm(kafkaOpts);
    const calls = vi.mocked(execFileSync).mock.calls;
    const osaCalls = calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    const workerScript = osaCalls[0]![1]![1]!;
    expect(workerScript).toContain(
      '/Users/mst/bin/job-search-agent',
    );
  });

  it('skips when the startup lock is held', () => {
    const lockPath = join(process.env['HOME']!, '.campaign-agent', 'agent-start.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
    startWorkerInIterm(kafkaOpts);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rethrows when osascript fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('osascript failed');
    });
    expect(() => startWorkerInIterm(kafkaOpts)).toThrow('iTerm2 launch failed');
  });
});

describe('ensureInfrastructureHealthy', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-infra-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('returns false without restart when playwright-mcp is alive', async () => {
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const restarted = await ensureInfrastructureHealthy({ ...kafkaOpts, cdpTimeoutMs: 1 });
    expect(restarted).toBe(false);
    expect(silent.warn).not.toHaveBeenCalledWith(
      { missing: ['playwright-mcp'] },
      'Campaign infrastructure unhealthy; restarting campaign',
    );
  });

  it('skips restart when the campaign target is already met', async () => {
    const campaignDir = mkdtempSync(join(tmpdir(), 'director-done-campaign-'));
    writeFileSync(
      join(campaignDir, 'tracker.json'),
      JSON.stringify({ stats: { submitted: 5 }, targetApplications: 5 }),
    );
    vi.mocked(execFileSync).mockReturnValue('');
    const restarted = await ensureInfrastructureHealthy({
      ...kafkaOpts,
      cdpTimeoutMs: 1,
      campaignDir,
    });
    expect(restarted).toBe(false);
    expect(silent.info).toHaveBeenCalledWith(
      'Campaign target met; skipping infrastructure health restart',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('restarts the campaign when playwright-mcp is missing', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const restarted = await ensureInfrastructureHealthy({ ...kafkaOpts, cdpTimeoutMs: 1 });
    expect(restarted).toBe(true);
    expect(silent.warn).toHaveBeenCalledWith(
      { missing: ['playwright-mcp'] },
      'Campaign infrastructure unhealthy; restarting campaign',
    );
  });

  it('reports Chrome still up (not down) when restarting with CDP alive', async () => {
    // chrome detected, playwright-mcp + openclaw missing -> the cdpAlive info
    // branch fires instead of the "Chrome CDP is also down" one.
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (file === 'pgrep') {
        return cmdArgs[1] === 'chrome.*remote-debugging' ? '900\n' : '';
      }
      if (file === 'osascript') return '';
      throw new Error(`unexpected exec ${file}`);
    });
    const restarted = await ensureInfrastructureHealthy({
      ...kafkaOpts,
      cdpTimeoutMs: 1,
      cdpUrl: 'http://127.0.0.1:1',
    });
    expect(restarted).toBe(true);
    expect(silent.info).toHaveBeenCalledWith(
      'Chrome CDP is still up; restarting campaign to reinitialize Playwright MCP',
    );
  });
});

describe('restartWorker', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-restartworker-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('logs stopped pids and a CDP warning across the full restart flow', async () => {
    let workerArmed = false;
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (file === 'pgrep') {
        // First detectWorker call sees pid 4242; every later poll sees none
        // (the tree was just killed), so stopTree/waitForStartup resolve fast.
        // detectWorker greps for the ANCHORED runner pattern (name at end,
        // preceded by start or a slash) since 2026-10-07.
        if (cmdArgs[1] === '(^|/)job-search-agent$' || cmdArgs[1] === '(^|/)job-search-agent-hermes$') {
          if (!workerArmed) {
            workerArmed = true;
            return '4242\n';
          }
          return '';
        }
        return ''; // unrelated patterns
      }
      if (file === 'osascript') return '';
      throw new Error(`unexpected exec ${file}`);
    });

    const out = await restartWorker({
      ...kafkaOpts,
      cdpUrl: 'http://127.0.0.1:1', // nothing listens here; CDP poll must fail
      cdpTimeoutMs: 5,
    });

    expect(out.iterm).toBe(true);
    expect(out.state.running).toBe(false);
    // Previous campaign pids were reported before relaunching.
    expect(silent.info).toHaveBeenCalledWith(
      { pids: [4242] },
      'stopped previous campaign',
    );
    // The worker never registered via pgrep within the tiny timeout...
    expect(silent.warn).toHaveBeenCalledWith(
      'campaign worker did not register via pgrep within timeout',
    );
    // ...and CDP never came up either.
    expect(silent.warn).toHaveBeenCalledWith(
      { cdpUrl: 'http://127.0.0.1:1' },
      'CDP did not become healthy; worker may still be starting',
    );
  });

  it('skips the "stopped previous campaign" log when nothing was running', async () => {
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      if (file === 'pgrep') return '';
      if (file === 'osascript') return '';
      throw new Error(`unexpected exec ${file}`);
    });
    const out = await restartWorker({ ...kafkaOpts, cdpTimeoutMs: 1, cdpUrl: 'http://127.0.0.1:1' });
    expect(out.iterm).toBe(true);
    const stopLog = vi
      .mocked(silent.info)
      .mock.calls.find((c) => c[1] === 'stopped previous campaign');
    expect(stopLog).toBeUndefined();
  });
});
