/**
 * Stale-campaign detection through the full DirectorLoop.runOnce path.
 *
 * Regression 2026-09-01: with the checkpoint offset at EOF (no recent
 * events), loop.ts fell back to checkpoint.lastTickAt - the previous tick's
 * OWN time - so idleMinutes never reached 60 and stale-campaign never fired.
 * A dead campaign worker made the Director go silent forever (observed live:
 * 18h idle, observed: 0, classifications: 0, LLM never consulted).
 *
 * Hermetic on purpose (separate from loop.spec): the staleness path runs the
 * VPN-rotation + proposal phases, which loop.spec's shared mock environment
 * does not cover; here every side-effectful module is mocked explicitly.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderChain } from '../providers/chain.js';

vi.mock('./kafka.js', () => ({ kafkaProduce: vi.fn(async () => {}) }));
vi.mock('./restart.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const mod = await importOriginal<typeof import('./restart.js')>();
  return {
    ...mod,
    ensureCdpRunning: vi.fn(async () => {}),
    ensureInfrastructureHealthy: vi.fn(async () => false),
    snapshot: vi.fn(() => ({ pids: [], running: true, orphaned: false })),
    startWorkerInIterm: vi.fn(),
    startKafkaInIterm: vi.fn(),
    stopWorker: vi.fn(async () => ({ killed: [] })),
    restartWorker: vi.fn(async () => ({
      iterm: true,
      state: { pids: [], running: true, orphaned: false },
    })),
    rotateVpnIp: vi.fn(async () => false),
  };
});

import { DirectorLoop } from './loop.js';
import { rotateVpnIp } from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function makeIdleCampaign(idleMs: number, submitted = 5, target = 2000): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-campaign-'));
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      submittedCount: submitted,
      targetApplications: target,
      target,
      applyQueue: [],
      updatedAt: new Date(Date.now() - idleMs).toISOString(),
      stats: { submitted, skippedDuplicate: 0, skippedSalary: 0, skippedFilter: 0, blockedManual: 0, errors: 0 },
    }),
  );
  // Empty events file: the checkpoint offset sits at EOF, nothing new.
  writeFileSync(join(dir, 'events.jsonl'), '');
  return dir;
}

function makeLoop(campaign: string, checkpointSeed?: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'stale-state-'));
  const checkpointPath = join(stateDir, 'cp.json');
  if (checkpointSeed) writeFileSync(checkpointPath, checkpointSeed);
  return {
    loop: new DirectorLoop({
      env: {
        DIRECTOR_CAMPAIGN_DIR: campaign,
        DIRECTOR_LEDGER: join(stateDir, 'ledger.jsonl'),
        DIRECTOR_INTERVAL_MINUTES: -1,
        DIRECTOR_MODEL: 'mst/free',
        WALK_ALIAS: ['mst/free'],
      } as never,
      chain: {
        handle: vi.fn(async () => ({
          response: new Response('{"choices":[{"message":{"content":"{\\"patches\\":[]}"}}]}'),
          servedBy: { provider: 'test', model: 'test' },
        })),
      } as unknown as ProviderChain,
      surface: {
        postProposal: vi.fn(),
        postDecision: vi.fn(),
        postApplied: vi.fn(),
        postObservation: vi.fn(),
        postRestart: vi.fn(),
        pollSlackMessages: vi.fn(async () => ({ decisions: [], latestTs: undefined })),
        flushOutbox: vi.fn(async () => 0),
      },
      log: silent,
      checkpointPath,
    }),
    stateDir,
  };
}

describe('stale-campaign detection (idle worker)', () => {
  it('classifies stale-campaign from tracker.updatedAt when no recent events exist', async () => {
    const { loop } = makeLoop(makeIdleCampaign(3 * 60 * 60_000)); // 3h idle
    const res = await loop.runOnce(new AbortController().signal);
    expect(res.classifications).toBeGreaterThan(0);
  });

  it('still emits stale-campaign when the checkpoint has a recent lastTickAt', async () => {
    // The old fallback (checkpoint.lastTickAt) must not mask staleness even
    // when a checkpoint exists: the campaign dir is the source of truth.
    const { loop } = makeLoop(
      makeIdleCampaign(5 * 60 * 60_000), // 5h idle
      JSON.stringify({ eventsReadOffset: 0, lastTickAt: new Date().toISOString() }),
    );
    const res = await loop.runOnce(new AbortController().signal);
    expect(res.classifications).toBeGreaterThan(0);
  });

  it('does not classify stale when the tracker was just updated', async () => {
    const { loop } = makeLoop(makeIdleCampaign(0)); // active right now
    const res = await loop.runOnce(new AbortController().signal);
    expect(res.classifications).toBe(0);
  });

  it('does not classify stale when the campaign is complete', async () => {
    // Completed = the agent exited on purpose; staleness would flap the VPN
    // and restart a finished worker forever.
    const { loop } = makeLoop(makeIdleCampaign(24 * 60 * 60_000, 2000, 2000));
    const res = await loop.runOnce(new AbortController().signal);
    expect(res.classifications).toBe(0);
  });

  it('rotates the VPN once when the campaign goes stale', async () => {
    vi.mocked(rotateVpnIp).mockClear();
    const { loop } = makeLoop(makeIdleCampaign(3 * 60 * 60_000));
    await loop.runOnce(new AbortController().signal);
    expect(vi.mocked(rotateVpnIp)).toHaveBeenCalledTimes(1);
  });
});
