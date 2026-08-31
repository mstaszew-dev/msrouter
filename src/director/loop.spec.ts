import { execFile } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as itermModule from './iterm.js';
import { kafkaProduce } from './kafka.js';
import { DirectorLoop } from './loop.js';
import {
  ensureInfrastructureHealthy,
  restartWorker,
  rotateVpnIp,
  snapshot as snapshotWorker,
  startWorkerInIterm,
  stopWorker,
} from './restart.js';
import type { DirectorSurface } from './types.js';

const itermSpies = vi.hoisted(() => ({
  startKafkaInIterm: vi.fn(),
  isRunningInIterm: vi.fn((): boolean => true),
}));

vi.mock('./kafka.js', () => ({
  kafkaProduce: vi.fn(async () => {}),
}));

// Mock the supervision/infra helpers to no-ops so runOnce is hermetic and
// fast (the real ones pgrep/osascript/iTerm and can take >5s). rotateVpnIp
// always FAILS: the regression test below asserts that a failed rotation
// still persists lastVpnRotation (no per-tick retry).
vi.mock('./restart.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const mod = await importOriginal<typeof import('./restart.js')>();
  return {
    ...mod,
    ensureCdpRunning: vi.fn(async () => {}),
    ensureInfrastructureHealthy: vi.fn(async () => false),
    snapshot: vi.fn(() => ({ pids: [], running: true, orphaned: false })),
    startWorkerInIterm: vi.fn(),
    startKafkaInIterm: itermSpies.startKafkaInIterm,
    stopWorker: vi.fn(async () => ({ killed: [] })),
    restartWorker: vi.fn(async () => ({ iterm: true, state: { pids: [], running: true, orphaned: false } })),
    rotateVpnIp: vi.fn(async () => false),
  };
});

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-loop-'));
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      submittedCount: 5,
      targetApplications: 1200,
      target: 1200,
      applyQueue: [],
      updatedAt: '2026-07-27T12:00:00Z',
      stats: {
        submitted: 5,
        skippedDuplicate: 0,
        skippedSalary: 0,
        skippedFilter: 0,
        blockedManual: 0,
        errors: 0,
      },
    }),
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({
      at: '2026-07-27T10:00:00Z',
      action: 'skippedFilter',
      record: {
        reason: 'manual',
        detail: 'login_or_captcha_required',
        id: 'e1',
        roleTitle: 'Senior Java Dev',
      },
    }) + '\n',
  );
  return dir;
}

/** A campaign whose submitted count meets/exceeds the target: the agent exits
 *  on purpose and the Director must NOT keep respawning it in iTerm2. */
function makeCompletedCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-done-'));
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      submittedCount: 1215,
      targetApplications: 1200,
      target: 1200,
      applyQueue: [],
      updatedAt: '2026-08-09T14:00:00Z',
      stats: {
        submitted: 1215,
        skippedDuplicate: 0,
        skippedSalary: 0,
        skippedFilter: 0,
        blockedManual: 0,
        errors: 0,
      },
    }),
  );
  writeFileSync(join(dir, 'events.jsonl'), '');
  return dir;
}

function makeEnv(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    DIRECTOR_INTERVAL_MINUTES: '-1',
    DIRECTOR_CAMPAIGN_DIR: '/tmp/x',
    DIRECTOR_OPENCLAW_WORKSPACE: '/tmp/oc',
    DIRECTOR_RUNNER: '/tmp/launch',
    DIRECTOR_PIDFILE: '/tmp/pid',
    DIRECTOR_OVERRIDES: '/tmp/ov.env',
    DIRECTOR_CDP_URL: 'http://127.0.0.1:9222',
    DIRECTOR_RAG_DB: '/tmp/index.db',
    DIRECTOR_LEDGER: '/tmp/ledger.jsonl',
    DIRECTOR_MODEL: 'mst/free',
    WALK_ALIAS: ['mst/free', 'free'],
    ...over,
  };
}

function nullSurface(): DirectorSurface {
  return {
    postProposal: vi.fn(),
    postDecision: vi.fn(),
    postApplied: vi.fn(),
    postObservation: vi.fn(),
    postRestart: vi.fn(),
    pollSlackMessages: vi.fn(async () => ({ decisions: [], latestTs: undefined })),
    flushOutbox: vi.fn(async () => 0),
  };
}

describe('DirectorLoop.runOnce', () => {
  it('observes, classifies, and records the run in the checkpoint', async () => {
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const ledgerPath = join(stateDir, 'ledger.jsonl');
    const overridesPath = join(stateDir, 'overrides.env');
    const checkpointPath = join(stateDir, 'checkpoint.json');
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_OVERRIDES: overridesPath,
      DIRECTOR_LEDGER: ledgerPath,
    });
    const chain = {
      handle: vi.fn(async () => ({
        response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
        servedBy: {},
      })),
    };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath,
    });
    const result = await loop.runOnce(new AbortController().signal);
    expect(result.observed).toBe(1);
    expect(result.classifications).toBeGreaterThan(0);
    expect(result.proposed).toBe(0); // chain returned no patches
    // Checkpoint persisted with advanced offset.
    const cp = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { eventsReadOffset: number };
    expect(cp.eventsReadOffset).toBeGreaterThan(0);
  });

  it('does not re-classify events already consumed', async () => {
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const checkpointPath = join(stateDir, 'checkpoint.json');
    // Pre-advance the checkpoint past the single event.
    const eventsBytes = readFileSync(join(campaign, 'events.jsonl')).length;
    writeFileSync(
      checkpointPath,
      JSON.stringify({ eventsReadOffset: eventsBytes, lastTickAt: 't' }),
    );
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
    });
    const chain = { handle: vi.fn() };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath,
    });
    const result = await loop.runOnce(new AbortController().signal);
    expect(result.observed).toBe(0);
    expect(result.classifications).toBe(0);
  });

  it('skips proposal when the signal is already aborted', async () => {
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
    });
    const chain = { handle: vi.fn() };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    const ac = new AbortController();
    ac.abort();
    const result = await loop.runOnce(ac.signal);
    // observe + classify run before the abort check; proposed stays 0 because
    // the actionable>0 + !signal.aborted guard skips propose().
    expect(result.proposed).toBe(0);
    expect(result.reason).toBe('ok');
  });

  it('returns reason=error when observe throws', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: '/this/path/does/not/exist',
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
    });
    const chain = { handle: vi.fn() };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    const result = await loop.runOnce(new AbortController().signal);
    expect(result.reason).toBe('error');
  });

  it('backs off a full interval when VPN rotation fails (no per-tick retry)', async () => {
    // Regression: a FAILED rotation (~30s of tunnel flap) must still persist
    // lastVpnRotation. Otherwise shouldRotateVpn() returns true every tick and
    // the disruption repeats every 5 min, breaking in-flight fetches (Slack
    // polls, agent requests).
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
      VPN_ROTATION_INTERVAL_MINUTES: 1,
    });
    const chain = {
      handle: vi.fn(async () => ({
        response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
        servedBy: {},
      })),
    };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    vi.mocked(rotateVpnIp).mockClear();
    await loop.runOnce(new AbortController().signal);
    await loop.runOnce(new AbortController().signal);
    expect(vi.mocked(rotateVpnIp)).toHaveBeenCalledTimes(1);
  });

  it('does NOT respawn the worker in iTerm2 when the campaign target is met', async () => {
    // Regression: when submitted >= target the agent exits on purpose. The
    // Director's ensureCampaignRunning saw running=false and re-opened an
    // iTerm2 tab every tick via startWorkerInIterm, forever. The completion
    // guard must suppress the spawn even when pgrep says the worker is gone.
    const campaign = makeCompletedCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
    });
    // Force the supervisor to observe the worker as NOT running (this is the
    // state that previously triggered the infinite-respawn loop).
    vi.mocked(snapshotWorker).mockReturnValueOnce({ pids: [], running: false, orphaned: false });
    vi.mocked(startWorkerInIterm).mockClear();

    const chain = { handle: vi.fn() };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    await loop.runOnce(new AbortController().signal);
    expect(vi.mocked(startWorkerInIterm)).not.toHaveBeenCalled();
  });

  it('tick completes when kafkaProduce throws (Kafka is non-fatal)', async () => {
    vi.mocked(kafkaProduce).mockRejectedValueOnce(new Error('kafka broker down'));
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
      KAFKA_ENABLED: 'true',
      KAFKA_HOME: '/opt/kafka',
      KAFKA_BOOTSTRAP: 'localhost:19092',
    });
    const chain = {
      handle: vi.fn(async () => ({
        response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
        servedBy: {},
      })),
    };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    const result = await loop.runOnce(new AbortController().signal);
    expect(result.reason).toBe('ok');
  });

  it('tick completes when kafkaProduce throws on every publishEvent call', async () => {
    vi.mocked(kafkaProduce).mockRejectedValue(new Error('kafka broker unreachable'));
    const campaign = makeCampaign();
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    const env = makeEnv({
      DIRECTOR_CAMPAIGN_DIR: campaign,
      DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
      KAFKA_ENABLED: 'true',
      KAFKA_HOME: '/opt/kafka',
      KAFKA_BOOTSTRAP: 'localhost:19092',
    });
    const chain = {
      handle: vi.fn(async () => ({
        response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
        servedBy: {},
      })),
    };
    const loop = new DirectorLoop({
      env: env as never,
      chain: chain as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
    const result = await loop.runOnce(new AbortController().signal);
    expect(result.reason).toBe('ok');
  });
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  void actual;
  // Default: instant no-op success so tests never touch the real filesystem
  // or scripts (ensureKafkaRunning would otherwise really start Kafka).
  return {
    ...actual,
    execFile: vi.fn(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: '', stderr: '' }),
    ),
  };
});

// Tab-first recovery rule: broker + monitor live in iTerm tabs like the agent;
// headless start-or-init is ONLY the fallback when not running inside iTerm.
vi.mock('./iterm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof itermModule>();
  return {
    ...actual,
    isRunningInIterm: () => itermSpies.isRunningInIterm(),
  };
});

describe('ensureKafkaRunning supervision', () => {
  const execFileMock = vi.mocked(execFile);

  beforeEach(() => {
    execFileMock.mockClear();
    itermSpies.startKafkaInIterm.mockClear();
    itermSpies.startKafkaInIterm.mockReturnValue(undefined);
    itermSpies.isRunningInIterm.mockClear();
    itermSpies.isRunningInIterm.mockReturnValue(true);
  });

  function kafkaLoop(stateDir: string, campaign: string, envOverrides: Record<string, unknown> = {}) {
    return new DirectorLoop({
      env: makeEnv({
        KAFKA_ENABLED: true,
        KAFKA_HOME: '/tmp/fake-kafka-home',
        DIRECTOR_CAMPAIGN_DIR: campaign,
        DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
        ...envOverrides,
      }) as never,
      chain: { handle: vi.fn(async () => ({ response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'), servedBy: {} })) } as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
  }

  function fakeExecStatus(ok: boolean) {
    execFileMock.mockImplementation(
      ((...cbArgs: unknown[]) => {
        const cb = cbArgs[3] as (
          err: Error | null,
          out?: { stdout: string; stderr: string },
        ) => void;
        if ((cbArgs[1] as string[])[1] === 'status') {
          if (ok) cb(null, { stdout: '[ok] running', stderr: '' });
          else cb(new Error('kafka not running'));
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }) as never,
    );
  }

  const subsCalled = () =>
    execFileMock.mock.calls.map((c) => ((c[1] as string[]) ?? [])[1]);

  it('does nothing when the broker is up', async () => {
    fakeExecStatus(true);
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await kafkaLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);
    expect(subsCalled()).toContain('status');
    // ensureCampaignRunning's own tab-spawn is fine when up (idempotent);
    // the supervision contract is only that no HEADLESS spawn happens.
    expect(subsCalled()).not.toContain('start-or-init');
  });

  it('delegates recovery to iTerm tabs when running inside iTerm', async () => {
    fakeExecStatus(false);
    itermSpies.isRunningInIterm.mockReturnValue(true);
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await kafkaLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);
    // >=1: supervision delegates; a second call comes from the legacy
    // idempotent ensureCampaignRunning path in the same tick.
    expect(itermSpies.startKafkaInIterm.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(itermSpies.startKafkaInIterm).toHaveBeenCalledWith(
      expect.objectContaining({ log: silent }),
    );
    // The rule: no headless spawns stealing the broker from its monitor tab.
    expect(subsCalled()).not.toContain('start-or-init');
  });

  it('falls back to headless start-or-init only outside iTerm', async () => {
    fakeExecStatus(false);
    itermSpies.isRunningInIterm.mockReturnValue(false);
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await kafkaLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);
    expect(subsCalled().filter((s) => s === 'start-or-init')).toHaveLength(1);
  });

  it('survives a failed iTerm delegation without throwing', async () => {
    fakeExecStatus(false);
    itermSpies.startKafkaInIterm.mockImplementation(() => {
      throw new Error('iTerm2 launch failed');
    });
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await expect(
      kafkaLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal),
    ).resolves.toBeDefined();
    expect(subsCalled()).not.toContain('start-or-init');
  });

  it('skips supervision entirely when KAFKA_ENABLED is false', async () => {
    fakeExecStatus(true);
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await kafkaLoop(stateDir, makeCampaign(), { KAFKA_ENABLED: false }).runOnce(
      new AbortController().signal,
    );
    expect(subsCalled()).not.toContain('status');
    expect(itermSpies.startKafkaInIterm).not.toHaveBeenCalled();
  });
});

describe('ensureKafkaRunning headless failure arm', () => {
  function kafkaLoop2(stateDir: string, campaign: string) {
    return new DirectorLoop({
      env: makeEnv({
        KAFKA_ENABLED: true,
        KAFKA_HOME: '/tmp/fake-kafka-home',
        DIRECTOR_CAMPAIGN_DIR: campaign,
        DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
      }) as never,
      chain: { handle: vi.fn(async () => ({ response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'), servedBy: {} })) } as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
  }

  const execFileMock = vi.mocked(execFile);

  beforeEach(() => {
    execFileMock.mockClear();
    itermSpies.isRunningInIterm.mockReturnValue(false);
  });

  it('warns and returns false when headless start-or-init fails', async () => {
    execFileMock.mockImplementation(
      ((...cbArgs: unknown[]) => {
        const cb = cbArgs[3] as (
          err: Error | null,
          out?: { stdout: string; stderr: string },
        ) => void;
        if ((cbArgs[1] as string[])[1] === 'status') {
          cb(new Error('kafka not running'));
        } else if ((cbArgs[1] as string[])[1] === 'start-or-init') {
          cb(new Error('broker did not become ready'));
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }) as never,
    );
    const stateDir = mkdtempSync(join(tmpdir(), 'director-state-'));
    await expect(
      kafkaLoop2(stateDir, makeCampaign()).runOnce(new AbortController().signal),
    ).resolves.toBeDefined();
    expect(
      execFileMock.mock.calls.filter((c) => (c[1] as string[])?.[1] === 'start-or-init'),
    ).toHaveLength(1);
  });
});

describe('DIRECTOR_AUTOSTART=false: observe-only supervision', () => {
  function autostartLoop(stateDir: string, campaign: string, envOver: Record<string, unknown> = {}) {
    return new DirectorLoop({
      env: makeEnv({
        DIRECTOR_AUTOSTART: false,
        DIRECTOR_CAMPAIGN_DIR: campaign,
        DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
        ...envOver,
      }) as never,
      chain: {
        handle: vi.fn(async () => ({
          response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
          servedBy: {},
        })),
      } as never,
      surface: nullSurface(),
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });
  }

  beforeEach(() => {
    // Isolate from earlier describes: reset supervision spies AND any
    // persistent mockReturnValue left on the shared snapshot mock.
    vi.mocked(snapshotWorker).mockReset();
    vi.mocked(snapshotWorker).mockReturnValue({ pids: [], running: false, orphaned: false });
    vi.mocked(startWorkerInIterm).mockClear();
    vi.mocked(restartWorker).mockClear();
    vi.mocked(stopWorker).mockClear();
    vi.mocked(ensureInfrastructureHealthy).mockClear();
    vi.mocked(rotateVpnIp).mockReset();
    vi.mocked(rotateVpnIp).mockResolvedValue(false);
  });

  it('never spawns the worker when it is not running', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'director-noauto-'));

    await autostartLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);

    expect(vi.mocked(startWorkerInIterm)).not.toHaveBeenCalled();
    expect(vi.mocked(restartWorker)).not.toHaveBeenCalled();
  });

  it('never kills or respawns an orphaned worker', async () => {
    // The user starts the agent manually from the GUI; the Director must not
    // kill a process it did not spawn just because its PPID is 1.
    const stateDir = mkdtempSync(join(tmpdir(), 'director-noauto-'));
    vi.mocked(snapshotWorker).mockReturnValue({ pids: [123], running: true, orphaned: true });

    await autostartLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);

    expect(vi.mocked(stopWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(restartWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(startWorkerInIterm)).not.toHaveBeenCalled();
  });

  it('skips the infrastructure restart path entirely', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'director-noauto-'));

    await autostartLoop(stateDir, makeCampaign()).runOnce(new AbortController().signal);

    expect(vi.mocked(ensureInfrastructureHealthy)).not.toHaveBeenCalled();
  });

  it('does not restart the worker even when VPN rotation succeeds', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'director-noauto-'));
    vi.mocked(rotateVpnIp).mockResolvedValue(true);

    await autostartLoop(stateDir, makeCampaign(), {
      VPN_ROTATION_INTERVAL_MINUTES: 30,
    }).runOnce(new AbortController().signal);

    expect(vi.mocked(rotateVpnIp)).toHaveBeenCalled();
    expect(vi.mocked(restartWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(startWorkerInIterm)).not.toHaveBeenCalled();
  });

  it('still observes the campaign (supervision remains observe-only, not off)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'director-noauto-'));
    const surface = nullSurface();
    const loop = new DirectorLoop({
      env: makeEnv({
        DIRECTOR_AUTOSTART: false,
        DIRECTOR_CAMPAIGN_DIR: makeCampaign(),
        DIRECTOR_LEDGER: join(stateDir, 'l.jsonl'),
      }) as never,
      chain: {
        handle: vi.fn(async () => ({
          response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
          servedBy: {},
        })),
      } as never,
      surface,
      log: silent,
      checkpointPath: join(stateDir, 'cp.json'),
    });

    await loop.runOnce(new AbortController().signal);

    expect(surface.postObservation).toHaveBeenCalled();
  });
});
