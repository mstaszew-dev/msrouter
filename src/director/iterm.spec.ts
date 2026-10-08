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

    expect(() => iterm.assertInIterm(100, lookup, 'darwin')).toThrow('process exited');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('assertInIterm exits on a non-macOS platform even with iTerm in ancestry', () => {
    // The ancestry check implies macOS (iTerm2 is macOS-only) but the refusal
    // should name the real problem on Linux/CI, not blame a missing iTerm.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });
    const lookup = chain({ 100: { ppid: 200, comm: 'iTerm2' }, 200: { ppid: 1, comm: 'launchd' } });

    expect(() => iterm.assertInIterm(100, lookup, 'linux')).toThrow('process exited');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('assertInIterm passes on darwin when iTerm2 is an ancestor', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });
    const lookup = chain({ 100: { ppid: 200, comm: 'iTerm2' }, 200: { ppid: 1, comm: 'launchd' } });

    expect(() => iterm.assertInIterm(100, lookup, 'darwin')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
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

    expect(() => iterm.assertInIterm(100, lookup, 'darwin')).not.toThrow();
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

// 2026-10-08 (review finding S4): the recovery path typed BOTH start-or-init and
// monitor into a new tab on every tick where the broker probe flaked. With the
// broker already up, start-or-init is pure noise (it adopts the running broker),
// and with a monitor already up the whole tab is noise. These tests pin the
// decision: broker+monitor up means no tab, broker up alone means a monitor-only
// tab, broker down means the full start-or-init+monitor tab.
describe('startKafkaInIterm - tab creation follows broker AND monitor state', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic-import typing under the fs mock
  type ItermModule = typeof import('./iterm.js');

  const opts = {
    entryCommand: '',
    workspace: '/tmp/does-not-matter',
    kafkaBootstrap: 'localhost:19092',
    kafkaHome: '/opt/kafka-3.7.0',
    log: silent,
  };

  /**
   * A private logger for assertions. The shared `silent` above is never cleared,
   * so a test that counted its calls would also count every earlier describe.
   */
  function localLogger() {
    const log = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    return { log: log as unknown as pino.Logger, spies: log };
  }

  beforeAll(async () => {
    fsState.denyAll = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Steer both probes. `monitorPids` is what `kafka.sh monitor-pids` prints;
   * null makes that call fail, which is the "cannot tell" case.
   */
  async function stubKafka(o: { brokerUp: boolean; monitorPids: string | null }) {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
      const file = String(callArgs[0]);
      const cb = callArgs[callArgs.length - 1] as (
        e: Error | null,
        out: string,
        err: string,
      ) => void;
      if (file === 'lsof') {
        cb(null, o.brokerUp ? 'java 1 1 0x0 0 0 TCP *:19092 (LISTEN)' : '', '');
        return;
      }
      if (file.endsWith('kafka-topics.sh')) {
        if (o.brokerUp) cb(null, 'director-events\n', '');
        else cb(new Error('topics failed'), '', '');
        return;
      }
      if (file === 'bash') {
        if (o.monitorPids === null) cb(new Error('probe failed'), '', '');
        else cb(null, o.monitorPids, '');
        return;
      }
      cb(new Error(`unexpected exec: ${file}`), '', '');
    }) as never);
  }

  /**
   * Every AppleScript startKafkaInIterm typed, oldest first.
   * Async because vi.resetModules() hands out a fresh mock instance, so the
   * child's process import has to be re-taken inside each test.
   */
  async function osascriptScripts(): Promise<string[]> {
    const { execFileSync } = await import('node:child_process');
    return vi
      .mocked(execFileSync)
      .mock.calls.filter((c) => c[0] === 'osascript')
      .map((c) => ((c[1] as readonly string[])[1]) ?? '');
  }

  beforeEach(async () => {
    const iterm: ItermModule = await import('./iterm.js');
    iterm.__resetKafkaFailureState();
  });

  it('creates NO tab when the broker and a monitor are both running', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubKafka({ brokerUp: true, monitorPids: '54370\n' });

    await iterm.startKafkaInIterm(opts);

    expect(await osascriptScripts()).toHaveLength(0);
  });

  it('creates a monitor-only tab when the broker runs but no monitor does', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubKafka({ brokerUp: true, monitorPids: '' });

    await iterm.startKafkaInIterm(opts);

    const [script] = await osascriptScripts();
    expect(script).toContain('bash scripts/kafka.sh monitor');
    // start-or-init against a live broker is what created the duplicate tabs.
    expect(script).not.toContain('start-or-init');
  });

  it('creates the full start-or-init + monitor tab when the broker is down', async () => {
    vi.useFakeTimers();
    try {
      const iterm: ItermModule = await import('./iterm.js');
      await stubKafka({ brokerUp: false, monitorPids: '' });
      const t0 = Date.parse('2026-10-08T12:00:00Z');
      vi.setSystemTime(t0);

      // First call is the debounced probe miss; a miss 61s later (the two tick
      // probes are seconds apart, so a spaced-out miss reads as an outage) is
      // the real recovery.
      await iterm.startKafkaInIterm(opts);
      vi.setSystemTime(new Date(t0 + 61_000));
      await iterm.startKafkaInIterm(opts);

      const [script] = await osascriptScripts();
      expect(script).toContain('bash scripts/kafka.sh start-or-init');
      expect(script).toContain('bash scripts/kafka.sh monitor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates NO tab when the monitor probe cannot answer', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubKafka({ brokerUp: true, monitorPids: null });

    await iterm.startKafkaInIterm(opts);

    // Unknown state must not become a tab per tick; the broker-up case already
    // returned without spawning before this probe existed.
    expect(await osascriptScripts()).toHaveLength(0);
  });

  it('asks kafka.sh with the configured KAFKA_HOME, not the gateway env default', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    await stubKafka({ brokerUp: true, monitorPids: '' });

    await iterm.startKafkaInIterm(opts);

    const { execFile } = await import('node:child_process');
    const probe = vi.mocked(execFile).mock.calls.find((c) => c[0] === 'bash');
    expect(probe).toBeDefined();
    // A `~`-prefixed or relative KAFKA_HOME would otherwise resolve to the
    // script's $HOME default and inspect the WRONG install's monitors.
    expect((probe![2] as { env?: Record<string, string> }).env?.['KAFKA_HOME']).toBe(
      '/opt/kafka-3.7.0',
    );
    expect((probe![1] as readonly string[]).join(' ')).toContain('monitor-pids');
  });

  it('backs off instead of opening a fresh monitor tab on every tick', async () => {
    const iterm: ItermModule = await import('./iterm.js');
    // The monitor never appears, so the second tick must not open another tab:
    // a consumer that cannot start would otherwise leak a tab every 5 minutes.
    await stubKafka({ brokerUp: true, monitorPids: '' });

    await iterm.startKafkaInIterm(opts);
    await iterm.startKafkaInIterm(opts);

    expect(await osascriptScripts()).toHaveLength(1);
  });

  // Review finding S1: the brokerWasUp flag was unverified - deleting its use on
  // the success path kept every test green, so the one semantic thing the
  // spawnKafkaTab extraction introduced had no coverage at all.
  it('does not count a monitor-only spawn as a broker start failure', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.parse('2026-10-08T12:00:00Z');
      vi.setSystemTime(t0);
      const iterm: ItermModule = await import('./iterm.js');
      await stubKafka({ brokerUp: true, monitorPids: '' });
      const { execFileSync } = await import('node:child_process');
      const localLog = localLogger();

      // Six monitor-only spawns, an hour apart. The gap clears the MONITOR
      // backoff at every rung (its cap is 30min, and each attempt pushes the
      // ladder one rung further), so nothing blocks a repeat. Do NOT call
      // __resetKafkaFailureState between them: that would clear the very
      // counter under test and make the assertions vacuous.
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(t0 + i * 3_600_000);
        await iterm.startKafkaInIterm({ ...opts, log: localLog.log });
      }
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(t0 + (3 + i) * 3_600_000);
        vi.mocked(execFileSync).mockImplementationOnce(() => {
          throw new Error('iTerm2 is not running');
        });
        await expect(iterm.startKafkaInIterm({ ...opts, log: localLog.log })).rejects.toThrow(
          /iTerm2 launch failed/,
        );
      }

      expect(await osascriptScripts()).toHaveLength(6);
      // HONEST SCOPE: this assertion also holds with the brokerWasUp guard
      // deleted, because the broker-up branch zeroes kafkaConsecutiveFailures
      // at the top of every call, so a monitor-only spawn can never reach the
      // threshold. The guard is defensive, not load-bearing; the next test pins
      // the half that IS load-bearing.
      expect(localLog.log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still advances the broker backoff when the broker really is down', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.parse('2026-10-08T12:00:00Z');
      vi.setSystemTime(t0);
      const iterm: ItermModule = await import('./iterm.js');
      await stubKafka({ brokerUp: false, monitorPids: '' });
      const localLog = localLogger();

      // Six ticks an hour apart. Every spawn needs TWO consecutive misses (the
      // debounce) and clears the miss counter, so this yields exactly three
      // spawns; the broker cooldown (cap 30min) never blocks one. The broker
      // failure counter must then reach 3 and warn, because a broker that keeps
      // failing to start has to back off rather than retry every tick.
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(t0 + i * 3_600_000);
        await iterm.startKafkaInIterm({ ...opts, log: localLog.log });
      }

      expect(await osascriptScripts()).toHaveLength(3);
      expect(localLog.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ failures: 3 }),
        expect.stringContaining('backing off'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding S1, second half: the misses counter must return to its base
  // once a monitor is actually seen, otherwise a single bad hour permanently
  // doubles the recovery interval.
  it('restarts the monitor backoff at the base after a monitor is seen', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
      const iterm: ItermModule = await import('./iterm.js');
      await stubKafka({ brokerUp: true, monitorPids: '' });
      await iterm.startKafkaInIterm(opts); // misses 0 -> 1 (next window 120s)
      vi.setSystemTime(new Date('2026-10-08T12:02:00Z'));
      await iterm.startKafkaInIterm(opts); // misses 1 -> 2 (next window 240s)

      vi.setSystemTime(new Date('2026-10-08T12:04:00Z'));
      await stubKafka({ brokerUp: true, monitorPids: '54370\n' });
      await iterm.startKafkaInIterm(opts); // a monitor is up: misses -> 0

      // 60s after the last spawn attempt. At the base (misses 0) this opens a
      // tab; at the uncorrected misses of 2 it would wait out a 240s window.
      vi.setSystemTime(new Date('2026-10-08T12:05:00Z'));
      await stubKafka({ brokerUp: true, monitorPids: '' });
      await iterm.startKafkaInIterm(opts);

      expect(await osascriptScripts()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-10-08, after S4 shipped: the only path left that can still open a
// recovery tab for no reason is a SINGLE failed broker probe. Measured on this
// box, a healthy `kafka-topics.sh --list` costs 2.16s against a 10s timeout, so
// one slow or contended run flips the Director to "Kafka is down" and types
// start-or-init + monitor into a fresh tab. These tests pin the debounce.
// Review follow-up: loop.ts's tick flow probes twice (ensureKafkaRunning +
// the ensureCampaignRunning block), so the two misses must also be spaced
// KAFKA_PROBE_DEBOUNCE_GAP_MS apart, or two flaky probes seconds apart in one
// tick still opened the tab.
describe('startKafkaInIterm - one missed probe is not a dead broker', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic-import typing under the fs mock
  type ItermModule = typeof import('./iterm.js');

  const opts = {
    entryCommand: '',
    workspace: '/tmp/does-not-matter',
    kafkaBootstrap: 'localhost:19092',
    kafkaHome: '/opt/kafka-3.7.0',
    log: silent,
  };

  beforeAll(async () => {
    fsState.denyAll = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const iterm: ItermModule = await import('./iterm.js');
    iterm.__resetKafkaFailureState();
  });

  /** Broker down or up, as this tick sees it. Up also reports a live monitor. */
  async function stubBroker(brokerUp: boolean): Promise<void> {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
      const file = String(callArgs[0]);
      const cb = callArgs[callArgs.length - 1] as (
        e: Error | null,
        out: string,
        err: string,
      ) => void;
      if (file === 'lsof') {
        cb(null, 'java 1 1 0x0 0 0 TCP *:19092 (LISTEN)', '');
        return;
      }
      if (file.endsWith('kafka-topics.sh')) {
        if (brokerUp) cb(null, 'director-events\n', '');
        else cb(new Error('topics timed out'), '', '');
        return;
      }
      if (file === 'bash') {
        cb(null, brokerUp ? '54370\n' : '', '');
        return;
      }
      cb(new Error(`unexpected exec: ${file}`), '', '');
    }) as never);
  }

  async function osascriptCount(): Promise<number> {
    const { execFileSync } = await import('node:child_process');
    return vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'osascript').length;
  }

  it('waits for a second miss spaced at least a gap apart before opening a recovery tab', async () => {
    vi.useFakeTimers();
    try {
      const iterm: ItermModule = await import('./iterm.js');
      await stubBroker(false);
      const t0 = Date.parse('2026-10-08T12:00:00Z');
      vi.setSystemTime(t0);

      await iterm.startKafkaInIterm(opts);
      expect(await osascriptCount()).toBe(0);

      // 10s later: the tick flow probes twice (ensureKafkaRunning + the
      // ensureCampaignRunning block), so a miss seconds after the first is the
      // same flake under load, not an outage. It must not open a tab.
      vi.setSystemTime(new Date(t0 + 10_000));
      await iterm.startKafkaInIterm(opts);
      expect(await osascriptCount()).toBe(0);

      // Over a minute after the first miss: a genuinely later miss, and the
      // cooldown from the (suppressed) earlier attempts must not block it.
      vi.setSystemTime(new Date(t0 + 61_000));
      await iterm.startKafkaInIterm(opts);
      expect(await osascriptCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets earlier misses as soon as a probe succeeds', async () => {
    vi.useFakeTimers();
    try {
      const iterm: ItermModule = await import('./iterm.js');
      const t0 = Date.parse('2026-10-08T12:00:00Z');
      vi.setSystemTime(t0);

      await stubBroker(false);
      await iterm.startKafkaInIterm(opts); // miss 1
      await stubBroker(true);
      await iterm.startKafkaInIterm(opts); // healthy again: counter must clear
      await stubBroker(false);
      await iterm.startKafkaInIterm(opts); // miss 1 again, not miss 2
      expect(await osascriptCount()).toBe(0);

      // A minute later: a second miss in its own right, not the stale one.
      vi.setSystemTime(new Date(t0 + 61_000));
      await iterm.startKafkaInIterm(opts); // miss 2
      expect(await osascriptCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
