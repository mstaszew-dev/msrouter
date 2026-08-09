import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { DirectorLoop } from './loop.js';
import { rotateVpnIp, snapshotWorker, startWorkerInIterm } from './restart.js';
import type { DirectorSurface } from './types.js';

// Mock the supervision/infra helpers to no-ops so runOnce is hermetic and
// fast (the real ones pgrep/osascript/iTerm and can take >5s). rotateVpnIp
// always FAILS: the regression test below asserts that a failed rotation
// still persists lastVpnRotation (no per-tick retry).
vi.mock('./restart.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./restart.js')>();
  return {
    ...mod,
    ensureCdpRunning: vi.fn(async () => {}),
    ensureInfrastructureHealthy: vi.fn(async () => false),
    snapshotWorker: vi.fn(() => ({ pids: [], running: true })),
    startWorkerInIterm: vi.fn(),
    restartWorker: vi.fn(async () => ({ iterm: true, state: { pids: [], running: true } })),
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
      stats: { submitted: 1215, skippedDuplicate: 0, skippedSalary: 0, skippedFilter: 0, blockedManual: 0, errors: 0 },
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
    vi.mocked(snapshotWorker).mockReturnValueOnce({ pids: [], running: false });
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
});
