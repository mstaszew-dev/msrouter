import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the restart module so VPN rotation + agent restart are fully controlled.
vi.mock('./restart.js', () => ({
  ensureCdpRunning: vi.fn(async () => undefined),
  ensureInfrastructureHealthy: vi.fn(async () => false),
  restartWorker: vi.fn(async () => ({ iterm: true, state: { pids: [1], running: true, orphaned: false } })),
  rotateVpnIp: vi.fn(async () => true),
  shouldRotateVpn: vi.fn(() => true),
  snapshot: vi.fn(() => ({ pids: [], running: false })),
  startWorkerInIterm: vi.fn(),
}));

import { DirectorLoop } from './loop.js';
import {
  restartWorker,
  rotateVpnIp,
  shouldRotateVpn,
} from './restart.js';
import type { DirectorSurface } from './types.js';

const silent = {
  warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as pino.Logger;

const mockedRotate = vi.mocked(rotateVpnIp);
const mockedRestart = vi.mocked(restartWorker);
const mockedShouldRotate = vi.mocked(shouldRotateVpn);

function makeCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-restart-'));
  writeFileSync(join(dir, 'tracker.json'), JSON.stringify({
    targetApplications: 1200, stats: { submitted: 5, skippedDuplicate: 0, skippedSalary: 0, skippedFilter: 0, blockedManual: 0, errors: 0 },
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  return dir;
}

function makeEnv(over: Record<string, unknown> = {}) {
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
    VPN_ROTATION_INTERVAL_MINUTES: '30',
    ...over,
  };
}

function nullSurface(): DirectorSurface {
  return {
    postProposal: vi.fn(), postDecision: vi.fn(), postApplied: vi.fn(),
    postObservation: vi.fn(), postRestart: vi.fn(),
    pollSlackMessages: vi.fn(async () => ({ decisions: [], latestTs: undefined })),
    flushOutbox: vi.fn(async () => 0),
  };
}

async function runLoop(env: Record<string, unknown>, checkpoint: Record<string, unknown> = {}) {
  const campaign = makeCampaign();
  const stateDir = mkdtempSync(join(tmpdir(), 'director-restart-state-'));
  const cpPath = join(stateDir, 'checkpoint.json');
  writeFileSync(cpPath, JSON.stringify({ eventsReadOffset: 0, lastTickAt: 't', ...checkpoint }));
  const chain = { handle: vi.fn() };
  const loop = new DirectorLoop({
    env: { ...makeEnv(env), DIRECTOR_CAMPAIGN_DIR: campaign } as never,
    chain: chain as never,
    surface: nullSurface(),
    log: silent,
    checkpointPath: cpPath,
  });
  return loop.runOnce(new AbortController().signal);
}

beforeEach(() => {
  mockedRotate.mockReset().mockResolvedValue(true);
  mockedRestart.mockReset();
  mockedShouldRotate.mockReset().mockReturnValue(true);
});

describe('DirectorLoop - restart after VPN rotation', () => {
  it('restarts the agent after a successful VPN IP rotation', async () => {
    await runLoop({});
    expect(mockedRotate).toHaveBeenCalled();
    expect(mockedRestart).toHaveBeenCalled();
  });

  it('does not restart the agent when VPN rotation fails', async () => {
    mockedRotate.mockResolvedValue(false);
    await runLoop({});
    expect(mockedRotate).toHaveBeenCalled();
    expect(mockedRestart).not.toHaveBeenCalled();
  });

  it('does not rotate or restart when the interval has not elapsed', async () => {
    mockedShouldRotate.mockReturnValue(false);
    await runLoop({}, { lastVpnRotation: new Date().toISOString() });
    expect(mockedRotate).not.toHaveBeenCalled();
    expect(mockedRestart).not.toHaveBeenCalled();
  });

  it('disables rotation entirely when the interval is 0', async () => {
    await runLoop({ VPN_ROTATION_INTERVAL_MINUTES: '0' });
    expect(mockedRotate).not.toHaveBeenCalled();
    expect(mockedRestart).not.toHaveBeenCalled();
  });
});
