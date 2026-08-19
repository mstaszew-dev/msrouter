/**
 * loop-paths.spec.ts: covers the remaining DirectorLoop.runOnce branches with
 * fully controlled mocks (observe/classify/ledger/apply/kafka/agent-loop are
 * all stubbed so every phase is deterministic). Complements loop.spec.ts (real
 * observe/classify integration) and loop-restart.spec.ts (periodic VPN rotation).
 *
 * Targets the branches that integration tests cannot reach cheaply: Kafka
 * publish paths, the infra-restart short circuit, stall-triggered VPN rotation
 * + duplicate-proposal suppression, stale-warning clearing, proposal-hash
 * dedup, the RAG rebuild success log, and the approved-patch execution phase.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// readFileSync throws only for prompt.md so readDirectorPrompt() takes its
// fallback branch; every other file still reads through to the real fs.
vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(((path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith('prompt.md')) {
        throw new Error('simulated missing prompt.md');
      }
      return (actual.readFileSync as (...a: unknown[]) => string)(path, ...rest);
    }) as unknown as typeof actual.readFileSync),
  };
});

// execFile resolves success so rebuildRag() reaches its success log. Only
// exercised by the RAG rebuild test (subChanged true), so no reset needed.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      cb: (err: null, out: { stdout: string }, stderr: string) => void,
    ) => {
      cb(null, { stdout: 'line1\nline2\n' }, '');
    },
  ),
}));

vi.mock('./restart.js', () => ({
  ensureCdpRunning: vi.fn(async () => undefined),
  ensureInfrastructureHealthy: vi.fn(async () => false),
  restartWorker: vi.fn(async () => ({ iterm: true, state: { pids: [1], running: true, orphaned: false } })),
  rotateVpnIp: vi.fn(async () => true),
  shouldRotateVpn: vi.fn(() => false),
  snapshot: vi.fn(() => ({ pids: [1], running: true, orphaned: false })),
  stopWorker: vi.fn(async () => ({ killed: [] })),
  startWorkerInIterm: vi.fn(),
  startKafkaInIterm: vi.fn(),
}));

vi.mock('./classify.js', () => ({ classify: vi.fn() }));
vi.mock('./observe.js', () => ({
  observe: vi.fn(),
  isCampaignComplete: vi.fn(async () => false),
}));
vi.mock('./ledger.js', () => ({
  readApprovedPatches: vi.fn(async () => []),
  readPending: vi.fn(async () => []),
}));
vi.mock('./apply.js', () => ({
  applyPatch: vi.fn(async () => undefined),
  readOverrides: vi.fn(async () => ({})),
}));
vi.mock('./kafka.js', () => ({ kafkaProduce: vi.fn(async () => undefined) }));
vi.mock('./agent-loop.js', () => ({ runDirectorAgent: vi.fn() }));

import { runDirectorAgent } from './agent-loop.js';
import { applyPatch, readOverrides } from './apply.js';
import { classify } from './classify.js';
import { kafkaProduce } from './kafka.js';
import { readApprovedPatches } from './ledger.js';
import { DirectorLoop } from './loop.js';
import { observe } from './observe.js';
import {
  ensureInfrastructureHealthy,
  restartWorker,
  rotateVpnIp,
  shouldRotateVpn,
  snapshot as snapshotWorker,
  stopWorker,
  startWorkerInIterm,
} from './restart.js';
import type {
  CampaignEvent,
  CampaignSnapshot,
  DecisionClassification,
  Patch,
  PatchDecision,
} from './types.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const freshSignal = () => new AbortController().signal;

const PATCH1: Patch = {
  id: 'p1',
  createdAt: '2026-08-17T00:00:00Z',
  overrides: { TARGET_COMPANIES: 'company-a' },
  rationale: 'apply to company-a',
  risk: 'low',
  classifications: ['c1'],
};

const PATCH2: Patch = {
  id: 'p2',
  createdAt: '2026-08-17T00:00:00Z',
  overrides: { TARGET_COMPANIES: 'company-b' },
  rationale: 'apply to company-b',
  risk: 'medium',
  classifications: [],
};

const DECISION1: PatchDecision = {
  patchId: 'p1',
  decision: 'approved',
  decidedAt: '2026-08-17T00:00:00Z',
  decidedBy: 'null-surface',
};

const actionableWarn: DecisionClassification[] = [
  { kind: 'good-apply', severity: 'warn', reason: 'r1' },
];
const staleCritical: DecisionClassification[] = [
  { kind: 'stale-campaign', severity: 'critical', reason: 'stale' },
];
const riskyDup: DecisionClassification[] = [
  { kind: 'risky-apply', severity: 'warn', reason: 'dup', evidence: 'e' },
];

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
    VPN_ROTATION_INTERVAL_MINUTES: '0',
    ...over,
  };
}

function makeSurface() {
  return {
    postProposal: vi.fn(async () => undefined),
    postDecision: vi.fn(async () => undefined),
    postApplied: vi.fn(async () => undefined),
    postObservation: vi.fn(async () => undefined),
    postRestart: vi.fn(async () => undefined),
    pollSlackMessages: vi.fn(
      async (): Promise<{ decisions: PatchDecision[]; latestTs?: string }> => ({
        decisions: [],
        latestTs: undefined,
      }),
    ),
    flushOutbox: vi.fn(async () => 0),
  };
}

function defaultSnapshot(): CampaignSnapshot {
  return {
    fetchedAt: '2026-08-17T00:00:00Z',
    recentEvents: [],
    tracker: { submitted: 10, target: 1200, queueLength: 3, updatedAt: '2026-08-17T00:00:00Z' },
    tickStatus: '',
  };
}

function buildLoop(over: Record<string, unknown> = {}, checkpoint: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'director-paths-'));
  const cpPath = join(stateDir, 'checkpoint.json');
  writeFileSync(
    cpPath,
    JSON.stringify({
      eventsReadOffset: 0,
      lastTickAt: 't',
      lastSubmitted: 10,
      lastQueueLength: 3,
      ...checkpoint,
    }),
  );
  const surface = makeSurface();
  const loop = new DirectorLoop({
    env: { ...makeEnv(over), DIRECTOR_CAMPAIGN_DIR: stateDir } as never,
    chain: { handle: vi.fn() } as never,
    surface: surface,
    log: silent,
    checkpointPath: cpPath,
  });
  return { loop, surface, cpPath };
}

beforeEach(() => {
  // Fresh object per call: runOnce mutates the returned checkpoint, so a
  // shared mockResolvedValue reference would mask the staleWarningActive
  // carry-over (observe() only sets eventsReadOffset and lastTickAt).
  vi.mocked(observe)
    .mockReset()
    .mockImplementation(async () => ({
      snapshot: defaultSnapshot(),
      checkpoint: { eventsReadOffset: 0, lastTickAt: 't' },
    }));
  vi.mocked(classify).mockReset().mockReturnValue([]);
  vi.mocked(kafkaProduce).mockReset().mockResolvedValue(undefined);
  vi.mocked(runDirectorAgent)
    .mockReset()
    .mockResolvedValue({ steps: 0, patches: [], transcript: '' });
  vi.mocked(applyPatch).mockReset().mockResolvedValue(undefined);
  vi.mocked(readOverrides).mockReset().mockResolvedValue({});
  vi.mocked(readApprovedPatches).mockReset().mockResolvedValue([]);
  vi.mocked(rotateVpnIp).mockReset().mockResolvedValue(true);
  vi.mocked(restartWorker)
    .mockReset()
    .mockResolvedValue({ iterm: true, state: { pids: [1], running: true, orphaned: false } });
  vi.mocked(ensureInfrastructureHealthy).mockReset().mockResolvedValue(false);
});

describe('DirectorLoop.runOnce - remaining paths', () => {
  it('publishes proposed and decided Kafka events and drains Slack decisions', async () => {
    const { loop, surface, cpPath } = buildLoop({
      KAFKA_ENABLED: 'true',
      KAFKA_HOME: '~/kafka-home',
      KAFKA_BOOTSTRAP: 'localhost:19092',
    });
    const ac = new AbortController();
    vi.mocked(classify).mockReturnValue(actionableWarn);
    vi.mocked(runDirectorAgent).mockResolvedValue({
      steps: 1,
      patches: [PATCH1, PATCH2],
      transcript: '',
    });
    surface.postProposal.mockImplementationOnce(async () => {
      ac.abort();
    });
    surface.pollSlackMessages.mockResolvedValue({ decisions: [DECISION1], latestTs: 'ts-9' });

    const result = await loop.runOnce(ac.signal);

    expect(result.reason).toBe('ok');
    expect(result.proposed).toBe(1); // the abort breaks the proposal loop on patch 2
    expect(surface.postProposal).toHaveBeenCalledTimes(1);
    expect(surface.postDecision).toHaveBeenCalledWith(DECISION1);
    expect(vi.mocked(kafkaProduce)).toHaveBeenCalledWith(
      'director-events',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ bootstrap: 'localhost:19092' }),
    );
    const values = vi
      .mocked(kafkaProduce)
      .mock.calls.map((c) => String(c[2]))
      .join('\n');
    expect(values).toContain('"kind":"proposed"');
    expect(values).toContain('"kind":"decided"');
    const cp = JSON.parse(readFileSync(cpPath, 'utf8')) as { lastSlackTs?: string };
    expect(cp.lastSlackTs).toBe('ts-9');
  });

  it('executes approved patches via the write agent loop and publishes applied events', async () => {
    const { loop, surface } = buildLoop({
      KAFKA_ENABLED: 'true',
      KAFKA_HOME: '/plain/kafka',
      KAFKA_BOOTSTRAP: 'localhost:19092',
    });
    vi.mocked(readApprovedPatches).mockResolvedValue([PATCH1]);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(runDirectorAgent).mock.calls[0]?.[6]).toBe('write');
    expect(vi.mocked(applyPatch)).toHaveBeenCalledWith(PATCH1, expect.any(String));
    expect(vi.mocked(readOverrides)).toHaveBeenCalled();
    expect(surface.postApplied).toHaveBeenCalledWith(PATCH1);
    const values = vi
      .mocked(kafkaProduce)
      .mock.calls.map((c) => String(c[2]))
      .join('\n');
    expect(values).toContain('"kind":"applied"');
  });

  it('short-circuits the tick when infrastructure restart was required', async () => {
    const { loop } = buildLoop();
    vi.mocked(ensureInfrastructureHealthy).mockResolvedValueOnce(true);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('infra-restart');
    expect(result.observed).toBe(0);
    expect(vi.mocked(observe)).not.toHaveBeenCalled();
  });

  it('rotates VPN on a stale campaign and suppresses the duplicate proposal on the next tick', async () => {
    const { loop, cpPath } = buildLoop();
    vi.mocked(classify).mockReturnValue(staleCritical);

    const first = await loop.runOnce(freshSignal());
    const second = await loop.runOnce(freshSignal());

    expect(first.reason).toBe('ok');
    expect(second.reason).toBe('ok');
    expect(vi.mocked(rotateVpnIp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(restartWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDirectorAgent)).toHaveBeenCalledTimes(1);
    expect(second.proposed).toBe(0);
    // staleWarningActive must survive the checkpoint merge, or the rotation
    // + duplicate proposal would repeat on every tick.
    const cp = JSON.parse(readFileSync(cpPath, 'utf8')) as { staleWarningActive?: boolean };
    expect(cp.staleWarningActive).toBe(true);
  });

  it('still restarts the agent when the stall-triggered VPN rotation fails', async () => {
    const { loop } = buildLoop();
    vi.mocked(classify).mockReturnValue(staleCritical);
    vi.mocked(rotateVpnIp).mockResolvedValue(false);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(rotateVpnIp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(restartWorker)).toHaveBeenCalledTimes(1);
  });

  it('clears the stale-campaign warning when new events arrive', async () => {
    const { loop, cpPath } = buildLoop({}, { staleWarningActive: true });
    const event: CampaignEvent = {
      at: '2026-08-17T00:00:00Z',
      action: 'submitted',
      record: { id: 'x' },
    };
    vi.mocked(observe).mockImplementation(async () => ({
      snapshot: { ...defaultSnapshot(), recentEvents: [event] },
      checkpoint: { eventsReadOffset: 0, lastTickAt: 't' },
    }));

    await loop.runOnce(freshSignal());

    const cp = JSON.parse(readFileSync(cpPath, 'utf8')) as { staleWarningActive?: boolean };
    expect(cp.staleWarningActive).toBe(false);
  });

  it('skips a duplicate proposal when the actionable state is unchanged', async () => {
    const { loop } = buildLoop();
    vi.mocked(classify).mockReturnValue(riskyDup);

    const first = await loop.runOnce(freshSignal());
    const second = await loop.runOnce(freshSignal());

    expect(first.reason).toBe('ok');
    expect(second.reason).toBe('ok');
    expect(vi.mocked(runDirectorAgent)).toHaveBeenCalledTimes(1);
    expect(second.proposed).toBe(0);
  });

  it('rebuilds the RAG index when new submissions are detected', async () => {
    const { loop } = buildLoop({}, { lastSubmitted: undefined });

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(execFile)).toHaveBeenCalledOnce();
  });

  it('handles a bare tilde in KAFKA_HOME', async () => {
    const { loop } = buildLoop({
      KAFKA_ENABLED: 'true',
      KAFKA_HOME: '~',
      KAFKA_BOOTSTRAP: 'localhost:19092',
    });
    vi.mocked(classify).mockReturnValue(actionableWarn);
    vi.mocked(runDirectorAgent).mockResolvedValue({ steps: 1, patches: [PATCH1], transcript: '' });

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(kafkaProduce)).toHaveBeenCalled();
  });

  it('uses env fallbacks and spawns the worker when it is not running', async () => {
    const { loop } = buildLoop({ DIRECTOR_RUNNER: undefined, DIRECTOR_CDP_URL: undefined });
    vi.mocked(snapshotWorker).mockReturnValue({ pids: [], running: false, orphaned: false });

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(startWorkerInIterm)).toHaveBeenCalledWith(
      expect.objectContaining({
        entryCommand: 'job-search-agent',
      }),
    );
  });

  it('returns reason=error when observe rejects with a non-Error value', async () => {
    const { loop } = buildLoop();
    vi.mocked(observe).mockRejectedValue('boom');

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('error');
  });

  it('falls back to the first WALK_ALIAS model when DIRECTOR_MODEL is unset', async () => {
    const { loop } = buildLoop({ DIRECTOR_MODEL: undefined, WALK_ALIAS: ['free'] });
    vi.mocked(classify).mockReturnValue(actionableWarn);
    vi.mocked(readApprovedPatches).mockResolvedValue([PATCH1]);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(runDirectorAgent).mock.calls[0]?.[3]).toBe('free');
    expect(vi.mocked(runDirectorAgent).mock.calls[1]?.[3]).toBe('free');
  });

  it('falls back to the default model when no alias is configured', async () => {
    const { loop } = buildLoop({ DIRECTOR_MODEL: undefined, WALK_ALIAS: [] });
    vi.mocked(classify).mockReturnValue(actionableWarn);
    vi.mocked(readApprovedPatches).mockResolvedValue([PATCH1]);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(runDirectorAgent).mock.calls[0]?.[3]).toBe('mst/free');
    expect(vi.mocked(runDirectorAgent).mock.calls[1]?.[3]).toBe('mst/free');
  });

  it('skips executing approved patches when the signal is aborted', async () => {
    const { loop } = buildLoop();
    vi.mocked(readApprovedPatches).mockResolvedValue([PATCH1]);
    const ac = new AbortController();
    ac.abort();

    const result = await loop.runOnce(ac.signal);

    expect(result.reason).toBe('ok');
    expect(vi.mocked(runDirectorAgent)).not.toHaveBeenCalled();
  });

  it('uses env fallbacks when restarting the agent after a stall rotation', async () => {
    const { loop } = buildLoop({ DIRECTOR_RUNNER: undefined, DIRECTOR_CDP_URL: undefined });
    vi.mocked(classify).mockReturnValue(staleCritical);

    await loop.runOnce(freshSignal());

    expect(vi.mocked(restartWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        entryCommand: 'job-search-agent',
        cdpUrl: 'http://127.0.0.1:9222',
      }),
    );
  });

  it('uses env fallbacks when restarting the agent after a periodic rotation', async () => {
    const { loop } = buildLoop({
      DIRECTOR_RUNNER: undefined,
      DIRECTOR_CDP_URL: undefined,
      VPN_ROTATION_INTERVAL_MINUTES: '30',
    });
    vi.mocked(shouldRotateVpn).mockReturnValue(true);

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(restartWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        entryCommand: 'job-search-agent',
        cdpUrl: 'http://127.0.0.1:9222',
      }),
    );
  });

  it('treats a non-Error RAG rebuild failure as a warning, not a crash', async () => {
    const { loop } = buildLoop({}, { lastSubmitted: undefined });
    // execFile resolves through a callback; rejecting with a bare string
    // exercises the non-Error branch of the rebuildRag catch.
    (
      execFile as unknown as { mockImplementation: (impl: (...args: unknown[]) => unknown) => void }
    ).mockImplementation((..._args: unknown[]) => {
      const cb = _args[3] as (err: unknown) => void;
      cb('boom');
      return undefined;
    });

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
  });

  it('kills orphaned processes and restarts the worker in iTerm', async () => {
    const { loop } = buildLoop();
    vi.mocked(snapshotWorker).mockReturnValue({ pids: [999], running: true, orphaned: true });

    const result = await loop.runOnce(freshSignal());

    expect(result.reason).toBe('ok');
    expect(vi.mocked(stopWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ entryCommand: '/tmp/launch' }),
    );
    expect(vi.mocked(startWorkerInIterm)).toHaveBeenCalled();
  });
});
