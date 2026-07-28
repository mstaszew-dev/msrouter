import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { DirectorLoop } from './loop.js';
import type { DirectorSurface } from './types.js';

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
});
