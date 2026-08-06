/**
 * Tests for Director surfaces (NullSurface + SlackSurface).
 * Focuses on message building, poller parsing, and NullSurface ledger behavior.
 * SlackSurface.fetch calls are NOT tested here (requires network mocking).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { NullSurface, SlackSurface } from './surface.js';
import { appendLedger } from './ledger.js';
import type { Patch, PatchDecision, SurfaceOpts } from './types.js';

vi.mock('./ledger.js', () => ({
  appendLedger: vi.fn().mockResolvedValue(undefined),
}));

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeOpts(overrides: Partial<SurfaceOpts> = {}): SurfaceOpts {
  return {
    ledgerPath: '/tmp/ledger.jsonl',
    log: mockLog as any,
    slackBotToken: 'xoxb-test',
    slackChannel: 'C12345',
    ...overrides,
  };
}

const samplePatch: any = {
  id: 'patch-123',
  risk: 'low',
  rationale: 'test rationale',
  overrides: { MAX_STEPS: '200', TIMEOUT_SECONDS: '300' },
};

describe('NullSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('postProposal writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    await surface.postProposal(samplePatch);

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'proposed',
        patchId: 'patch-123',
        patch: samplePatch,
      })
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      { patchId: 'patch-123', risk: 'low' },
      'proposal posted (null surface)'
    );
  });

  it('postDecision writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    const decision = {
      patchId: 'patch-123',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
    };
    await surface.postDecision(decision);

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'decided',
        patchId: 'patch-123',
        decision,
      })
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      { patchId: 'patch-123', decision: 'approved' },
      'decision recorded'
    );
  });

  it('postApplied writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    await surface.postApplied(samplePatch);

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'applied',
        patchId: 'patch-123',
      })
    );
  });

  it('postRestart writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    await surface.postRestart({ pid: 12345, logPath: '/tmp/log.txt' });

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'restart',
        detail: 'pid=12345 log=/tmp/log.txt',
      })
    );
  });

  it('postObservation writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    await surface.postObservation({ submitted: 5, target: 10, queueLength: 2 });

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'observation',
        detail: 'submitted=5 target=10 queue=2',
      })
    );
  });

  it('pollSlackMessages returns empty for NullSurface', async () => {
    const surface = new NullSurface(makeOpts());
    const result = await surface.pollSlackMessages('ts-123');
    expect(result).toEqual({ decisions: [], latestTs: 'ts-123' });
  });
});

describe('SlackSurface message builders (pure functions)', () => {
  const opts = makeOpts({ slackBotToken: 'xoxb-test', slackChannel: 'C12345' });
  const surface = new SlackSurface(opts);
  const patch = {
    id: 'patch-456',
    risk: 'high',
    rationale: 'increase steps',
    overrides: { MAX_STEPS: '300', TIMEOUT_SECONDS: '600' },
  };

  it('buildProposalMessage formats correctly', () => {
    const msg = surface.buildProposalMessage(patch);
    expect(msg).toContain('*Director Proposal* (risk: high)');
    expect(msg).toContain('Rationale: increase steps');
    expect(msg).toContain('MAX_STEPS=300');
    expect(msg).toContain('TIMEOUT_SECONDS=600');
    expect(msg).toContain('approve patch-456');
    expect(msg).toContain('reject patch-456');
  });

  it('buildDecisionMessage includes reason', () => {
    const msg = surface.buildDecisionMessage({
      patchId: 'patch-789',
      decision: 'rejected',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
      reason: 'too risky',
    });
    expect(msg).toContain('rejected on patch patch-789');
    expect(msg).toContain('too risky');
  });

  it('buildDecisionMessage works without reason', () => {
    const msg = surface.buildDecisionMessage({
      patchId: 'patch-789',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
    });
    expect(msg).toContain('approved on patch patch-789');
    expect(msg).not.toContain('—');
  });

  it('buildAppliedMessage', () => {
    const msg = surface.buildAppliedMessage(patch);
    expect(msg).toContain('*Director Applied*');
    expect(msg).toContain('patch-456');
  });

  it('buildRestartMessage', () => {
    const msg = surface.buildRestartMessage({ pid: 999, logPath: '/var/log/agent.log' });
    expect(msg).toContain('*Director Restart*');
    expect(msg).toContain('PID: 999');
    expect(msg).toContain('/var/log/agent.log');
  });

  it('buildObservationMessage', () => {
    const msg = surface.buildObservationMessage({ submitted: 99, target: 1200, queueLength: 5 });
    expect(msg).toContain('99/1200');
    expect(msg).toContain('1101 to go');
    expect(msg).toContain('Queue: 5');
  });
});

describe('SlackSurface pollSlackMessages with in-process poller', () => {
  it('drains poller and parses approve/reject', async () => {
    const mockPoller = {
      drain: vi.fn().mockReturnValue([
        { text: 'approve patch-111', ts: '1700000001.001' },
        { text: 'reject patch-222', ts: '1700000002.002' },
        { text: 'irrelevant message', ts: '1700000003.003' },
      ]),
      latestTs: '1700000003.003',
    };
    const surface = new SlackSurface(makeOpts({ slackPoller: mockPoller as any }));

    const result = await surface.pollSlackMessages('1700000000.000');

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]).toEqual({
      patchId: 'patch-111',
      decision: 'approved',
      decidedAt: expect.any(String),
      decidedBy: 'slack',
    });
    expect(result.decisions[1]).toEqual({
      patchId: 'patch-222',
      decision: 'rejected',
      decidedAt: expect.any(String),
      decidedBy: 'slack',
    });
    expect(result.latestTs).toBe('1700000003.003');
  });

  it('ignores messages without approve/reject', async () => {
    const mockPoller = {
      drain: vi.fn().mockReturnValue([
        { text: 'hello world', ts: '1700000001.001' },
        { text: 'approve', ts: '1700000002.002' }, // no patch id
      ]),
      latestTs: '1700000002.002',
    };
    const surface = new SlackSurface(makeOpts({ slackPoller: mockPoller as any }));

    const result = await surface.pollSlackMessages();
    expect(result.decisions).toHaveLength(0);
  });

  it('returns empty when no poller and no botToken', async () => {
    const surface = new SlackSurface(makeOpts({ slackBotToken: undefined }));
    const result = await surface.pollSlackMessages('ts-123');
    expect(result).toEqual({ decisions: [], latestTs: 'ts-123' });
  });
});

describe('SlackSurface Slack API fallback (pollSlackMessages direct API)', () => {
  const surface = new SlackSurface(makeOpts());

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty when Slack API returns ok:false', async () => {
    (fetch as any).mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });

    const result = await surface.pollSlackMessages();
    expect(result.decisions).toHaveLength(0);
  });

  it('parses approve/reject from conversations.history', async () => {
    (fetch as any).mockResolvedValueOnce({
      json: async () => ({
        ok: true,
        messages: [
          { text: 'approve patch-abc', ts: '1700000010.001' },
          { text: 'reject patch-xyz', ts: '1700000011.002' },
        ],
      }),
    });

    const result = await surface.pollSlackMessages();
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].decision).toBe('approved');
    expect(result.decisions[0].patchId).toBe('patch-abc');
    expect(result.decisions[1].decision).toBe('rejected');
    expect(result.decisions[1].patchId).toBe('patch-xyz');
    expect(result.latestTs).toBe('1700000011.002');
  });

  it('returns empty when no botToken or channel', async () => {
    const surface = new SlackSurface(makeOpts({ slackBotToken: undefined }));
    const result = await surface.pollSlackMessages('ts-123');
    expect(result).toEqual({ decisions: [], latestTs: 'ts-123' });
  });
});
