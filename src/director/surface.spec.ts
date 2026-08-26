/**
 * Tests for Director surfaces (NullSurface + SlackSurface).
 * Focuses on message building, poller parsing, and NullSurface ledger behavior.
 * SlackSurface.fetch calls are NOT tested here (requires network mocking).
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { appendLedger } from './ledger.js';
import type { SlackPoller } from './slack-poller.js';
import {
  NullSurface,
  SlackSurface,
  MAX_OUTBOX_ATTEMPTS,
  readOutbox,
  writeOutbox,
} from './surface.js';
import type { SurfaceOpts } from './surface.js';
import type { Patch, PatchDecision, SlackOutboxEntry } from './types.js';

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
    log: mockLog as unknown as pino.Logger,
    slackBotToken: 'xoxb-test',
    slackChannel: 'C12345',
    ...overrides,
  };
}

const samplePatch: Patch = {
  id: 'patch-123',
  createdAt: '2026-01-01T00:00:00Z',
  risk: 'low',
  rationale: 'test rationale',
  overrides: { MAX_STEPS: '200', TIMEOUT_SECONDS: '300' },
  classifications: ['class-1'],
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
      }),
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      { patchId: 'patch-123', risk: 'low' },
      'proposal posted (null surface)',
    );
  });

  it('postDecision writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    const decision: PatchDecision = {
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
      }),
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      { patchId: 'patch-123', decision: 'approved' },
      'decision recorded',
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
      }),
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
      }),
    );
  });

  it('postObservation writes to ledger and logs', async () => {
    const surface = new NullSurface(makeOpts());
    await surface.postObservation({ submitted: 5, target: 10});

    expect(appendLedger).toHaveBeenCalledWith(
      '/tmp/ledger.jsonl',
      expect.objectContaining({
        kind: 'observation',
        detail: 'submitted=5 target=10',
      }),
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
  // The builders are private; this block's whole purpose is unit-testing their
  // exact output. Expose them via a typed projection (they are pure, so the
  // cast is sound) instead of weakening to `any`.
  const builders = surface as unknown as {
    buildProposalMessage(patch: Patch): string;
    buildDecisionMessage(decision: PatchDecision): string;
    buildAppliedMessage(patch: Patch): string;
    buildRestartMessage(detail: { pid: number; logPath: string }): string;
    buildObservationMessage(snapshot: {
      submitted: number;
      target: number;
    }): string;
  };
  const patch: Patch = {
    id: 'patch-456',
    createdAt: '2026-01-01T00:00:00Z',
    risk: 'high',
    rationale: 'increase steps',
    overrides: { MAX_STEPS: '300', TIMEOUT_SECONDS: '600' },
    classifications: ['class-1'],
  };

  it('buildProposalMessage formats correctly', () => {
    const msg = builders.buildProposalMessage(patch);
    expect(msg).toContain('*Director Proposal* (risk: high)');
    expect(msg).toContain('Rationale: increase steps');
    expect(msg).toContain('MAX_STEPS=300');
    expect(msg).toContain('TIMEOUT_SECONDS=600');
    expect(msg).toContain('approve patch-456');
    expect(msg).toContain('reject patch-456');
  });

  it('buildDecisionMessage includes reason', () => {
    const msg = builders.buildDecisionMessage({
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
    const msg = builders.buildDecisionMessage({
      patchId: 'patch-789',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
    });
    expect(msg).toContain('approved on patch patch-789');
    expect(msg).not.toContain('—');
  });

  it('buildAppliedMessage', () => {
    const msg = builders.buildAppliedMessage(patch);
    expect(msg).toContain('*Director Applied*');
    expect(msg).toContain('patch-456');
  });

  it('buildRestartMessage', () => {
    const msg = builders.buildRestartMessage({ pid: 999, logPath: '/var/log/agent.log' });
    expect(msg).toContain('*Director Restart*');
    expect(msg).toContain('PID: 999');
    expect(msg).toContain('/var/log/agent.log');
  });

  it('buildObservationMessage', () => {
    const msg = builders.buildObservationMessage({ submitted: 99, target: 1200});
    expect(msg).toContain('99/1200');
    expect(msg).toContain('1101 to go');
    expect(msg).not.toContain('Queue');
  });
});

describe('SlackSurface pollSlackMessages with in-process poller', () => {
  it('drains poller and parses approve/reject', async () => {
    // Duck-typed poller stand-in: pollSlackMessages only calls drain() and
    // reads latestTs; the rest of SlackPoller is private state.
    const mockPoller = {
      drain: vi.fn().mockReturnValue([
        { text: 'approve patch-111', ts: '1700000001.001' },
        { text: 'reject patch-222', ts: '1700000002.002' },
        { text: 'irrelevant message', ts: '1700000003.003' },
      ]),
      latestTs: '1700000003.003',
    } as unknown as SlackPoller;
    const surface = new SlackSurface(makeOpts({ slackPoller: mockPoller }));

    const result = await surface.pollSlackMessages('1700000000.000');

    expect(result.decisions).toHaveLength(2);
    const first = result.decisions[0]!;
    const second = result.decisions[1]!;
    expect(first).toMatchObject({ patchId: 'patch-111', decision: 'approved', decidedBy: 'slack' });
    expect(second).toMatchObject({
      patchId: 'patch-222',
      decision: 'rejected',
      decidedBy: 'slack',
    });
    expect(typeof first.decidedAt).toBe('string');
    expect(result.latestTs).toBe('1700000003.003');
  });

  it('ignores messages without approve/reject', async () => {
    const mockPoller = {
      drain: vi.fn().mockReturnValue([
        { text: 'hello world', ts: '1700000001.001' },
        { text: 'approve', ts: '1700000002.002' }, // no patch id
      ]),
      latestTs: '1700000002.002',
    } as unknown as SlackPoller;
    const surface = new SlackSurface(makeOpts({ slackPoller: mockPoller }));

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

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty when Slack API returns ok:false', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });

    const result = await surface.pollSlackMessages();
    expect(result.decisions).toHaveLength(0);
  });

  it('parses approve/reject from conversations.history', async () => {
    fetchMock.mockResolvedValueOnce({
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
    expect(result.decisions[0]!.decision).toBe('approved');
    expect(result.decisions[0]!.patchId).toBe('patch-abc');
    expect(result.decisions[1]!.decision).toBe('rejected');
    expect(result.decisions[1]!.patchId).toBe('patch-xyz');
    expect(result.latestTs).toBe('1700000011.002');
  });

  it('returns empty when no botToken or channel', async () => {
    const surface = new SlackSurface(makeOpts({ slackBotToken: undefined }));
    const result = await surface.pollSlackMessages('ts-123');
    expect(result).toEqual({ decisions: [], latestTs: 'ts-123' });
  });
});

// ---------------------------------------------------------------------------
// Outbox I/O helpers (readOutbox / writeOutbox) - pure fs, no Slack.
// ---------------------------------------------------------------------------

describe('Slack outbox I/O helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-io-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readOutbox returns [] for a missing file', async () => {
    expect(await readOutbox(join(dir, 'nope.json'))).toEqual([]);
  });

  it('readOutbox self-heals on corrupt JSON', async () => {
    const path = join(dir, 'corrupt.json');
    await writeOutbox(path, [{ id: 'x', message: 'hi', attempts: 0 }]);
    // Corrupt it manually.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ this is not json', 'utf8');
    expect(await readOutbox(path)).toEqual([]);
  });

  it('writeOutbox + readOutbox round-trips entries', async () => {
    const path = join(dir, 'ob.json');
    const entries: SlackOutboxEntry[] = [
      { id: 'a', message: 'msg-a', attempts: 0 },
      {
        id: 'b',
        message: 'msg-b',
        attempts: 2,
        lastErrorAt: '2026-01-01T00:00:00Z',
        lastError: 'boom',
      },
    ];
    await writeOutbox(path, entries);
    expect(await readOutbox(path)).toEqual(entries);
  });

  it('readOutbox returns [] when entries is not an array', async () => {
    const path = join(dir, 'bad-shape.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ entries: 'not-an-array' }), 'utf8');
    expect(await readOutbox(path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SlackSurface outbox: enqueue on failure, drain on flush, attempt cap.
// Uses real temp files for the outbox; mocks global fetch.
// ---------------------------------------------------------------------------

describe('SlackSurface outbox durability', () => {
  let dir: string;
  let outboxPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-surface-'));
    outboxPath = join(dir, 'slack-outbox.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make fetch succeed (Slack chat.postMessage ok:true). */
  function mockFetchOk() {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: true }) });
  }

  /** Make fetch look like a network throw. */
  function mockFetchThrow(msg = 'network down') {
    fetchMock.mockRejectedValueOnce(new Error(msg));
  }

  /** Make Slack return ok:false (treated as delivery failure). */
  function mockFetchSlackError(error = 'rate_limited') {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error }) });
  }

  it('does NOT enqueue when delivery succeeds', async () => {
    mockFetchOk();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1200, target: 1200});

    expect(existsSync(outboxPath)).toBe(false);
    const remaining = await surface.flushOutbox();
    expect(remaining).toBe(0);
  });

  it('enqueues to the outbox on a network failure', async () => {
    mockFetchThrow('ECONNRESET');
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1200, target: 1200});

    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('1200/1200');
    expect(entries[0]!.attempts).toBe(0);
    // flushOutbox should have been called implicitly nowhere yet; the entry persists.
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxSize: 1 }),
      expect.stringContaining('enqueued to outbox'),
    );
  });

  it('enqueues on Slack ok:false and flushOutbox delivers it on the next tick', async () => {
    // Tick 1: Slack rejects (rate_limited) -> enqueued.
    mockFetchSlackError('rate_limited');
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1200, target: 1200});
    expect(await readOutbox(outboxPath)).toHaveLength(1);

    // Tick 2: flushOutbox retries and Slack now accepts -> drained.
    mockFetchOk();
    const remaining = await surface.flushOutbox();
    expect(remaining).toBe(0);
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  it('increments attempts on each failed flush and keeps the entry', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1, target: 2});

    // Three failed retries.
    for (let i = 0; i < 3; i++) {
      mockFetchThrow();
      await surface.flushOutbox();
    }
    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attempts).toBe(3);
    expect(entries[0]!.lastErrorAt).toBeTruthy();
  });

  it('drops an entry after MAX_OUTBOX_ATTEMPTS failed attempts', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1, target: 2});

    // Pre-seed attempts at the cap minus one so the next flush crosses the cap.
    const entries = await readOutbox(outboxPath);
    await writeOutbox(outboxPath, [{ ...entries[0]!, attempts: MAX_OUTBOX_ATTEMPTS - 1 }]);

    mockFetchThrow();
    const remaining = await surface.flushOutbox();
    expect(remaining).toBe(0);
    expect(await readOutbox(outboxPath)).toEqual([]);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_OUTBOX_ATTEMPTS }),
      expect.stringContaining('Dropping outbox entry'),
    );
  });

  it('flushOutbox is a no-op when the outbox is empty', async () => {
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    const remaining = await surface.flushOutbox();
    expect(remaining).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('flushOutbox drains multiple entries, keeping only the failures', async () => {
    // Pre-seed three entries.
    await writeOutbox(outboxPath, [
      { id: 'ok-1', message: 'will-deliver-1', attempts: 0 },
      { id: 'fail-1', message: 'will-fail', attempts: 0 },
      { id: 'ok-2', message: 'will-deliver-2', attempts: 0 },
    ]);
    const surface = new SlackSurface(makeOpts({ outboxPath }));

    mockFetchOk();
    mockFetchThrow();
    mockFetchOk();

    const remaining = await surface.flushOutbox();
    expect(remaining).toBe(1);
    const left = await readOutbox(outboxPath);
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe('fail-1');
  });

  it('outboxPath defaults to ledgerPath + .slack-outbox.json when not given', async () => {
    mockFetchThrow();
    const ledgerPath = join(dir, 'ledger.jsonl');
    const surface = new SlackSurface(makeOpts({ outboxPath: undefined, ledgerPath }));
    await surface.postObservation({ submitted: 1, target: 2});

    const expectedDefault = `${ledgerPath}.slack-outbox.json`;
    expect(existsSync(expectedDefault)).toBe(true);
    expect(await readOutbox(expectedDefault)).toHaveLength(1);
  });

  it('deliverToSlack treats missing credentials as success (no enqueue)', async () => {
    const surface = new SlackSurface(
      makeOpts({
        outboxPath,
        slackBotToken: undefined,
        slackChannel: undefined,
        slackWebhook: undefined,
      }),
    );
    await surface.postObservation({ submitted: 1, target: 2});
    expect(existsSync(outboxPath)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  // --- every post* method must enqueue on failure, not just postObservation ---

  it('postProposal enqueues to outbox when delivery fails', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postProposal(samplePatch);
    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('Director Proposal');
  });

  it('postDecision enqueues to outbox when delivery fails', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postDecision({
      patchId: 'p1',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
    });
    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('Director Decision');
  });

  it('postApplied enqueues to outbox when delivery fails', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postApplied(samplePatch);
    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('Director Applied');
  });

  it('postRestart enqueues to outbox when delivery fails', async () => {
    mockFetchThrow();
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postRestart({ pid: 12345, logPath: '/tmp/log' });
    const entries = await readOutbox(outboxPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('Director Restart');
  });

  it('all post* methods deliver (no enqueue) when Slack accepts', async () => {
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    mockFetchOk();
    await surface.postProposal(samplePatch);
    mockFetchOk();
    await surface.postDecision({
      patchId: 'p1',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'slack',
    });
    mockFetchOk();
    await surface.postApplied(samplePatch);
    mockFetchOk();
    await surface.postRestart({ pid: 1, logPath: '/tmp/log' });
    mockFetchOk();
    await surface.postObservation({ submitted: 1, target: 2});
    expect(existsSync(outboxPath)).toBe(false);
  });

  it('flushOutbox logs "Outbox flush complete" when at least one entry is delivered', async () => {
    await writeOutbox(outboxPath, [{ id: 'ok-1', message: 'm', attempts: 0 }]);
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    mockFetchOk();
    await surface.flushOutbox();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: 1, remaining: 0 }),
      'Outbox flush complete',
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook delivery path (separate from botToken path). Covers the else-if
// branch in deliverToSlack and its failure -> outbox enqueue.
// ---------------------------------------------------------------------------

describe('SlackSurface webhook delivery + outbox', () => {
  let dir: string;
  let outboxPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-webhook-'));
    outboxPath = join(dir, 'slack-outbox.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers via webhook when botToken is absent and does not enqueue', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const surface = new SlackSurface(
      makeOpts({
        outboxPath,
        slackBotToken: undefined,
        slackChannel: undefined,
        slackWebhook: 'https://hooks.slack.test/x',
      }),
    );
    await surface.postObservation({ submitted: 1, target: 2});
    expect(existsSync(outboxPath)).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.slack.test/x',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('enqueues to outbox when the webhook returns a non-ok HTTP status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const surface = new SlackSurface(
      makeOpts({
        outboxPath,
        slackBotToken: undefined,
        slackChannel: undefined,
        slackWebhook: 'https://hooks.slack.test/x',
      }),
    );
    await surface.postObservation({ submitted: 1, target: 2});
    expect(await readOutbox(outboxPath)).toHaveLength(1);
  });

  it('falls back to webhook when botToken is set but channel is missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const surface = new SlackSurface(
      makeOpts({ outboxPath, slackChannel: undefined, slackWebhook: 'https://hooks.slack.test/x' }),
    );
    await surface.postObservation({ submitted: 1, target: 2});
    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.slack.test/x',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(existsSync(outboxPath)).toBe(false);
  });

  it('treats botToken-without-channel-and-without-webhook as success (no fetch, no enqueue)', async () => {
    // Misconfiguration: bot token set, but neither channel nor webhook. This is
    // a permanent no-op (returns true), not a retryable failure.
    const surface = new SlackSurface(
      makeOpts({ outboxPath, slackChannel: undefined, slackWebhook: undefined }),
    );
    await surface.postObservation({ submitted: 1, target: 2});
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(outboxPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pollSlackMessages direct-API fallback: network error returns empty (covers
// the catch block, which predates the outbox work but shares the fetch seam).
// ---------------------------------------------------------------------------

describe('SlackSurface pollSlackMessages error handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty on a network error during conversations.history', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const surface = new SlackSurface(makeOpts());
    const result = await surface.pollSlackMessages();
    expect(result).toEqual({ decisions: [], latestTs: undefined });
  });

  it('passes lastTs as oldest param when provided', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: true, messages: [] }) });
    const surface = new SlackSurface(makeOpts());
    await surface.pollSlackMessages('1700000000.000');
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('oldest=1700000000.000');
  });

  it('skips messages missing text or ts, but still parses the valid ones', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        ok: true,
        messages: [
          { text: 'approve patch-ok', ts: '1700000020.000' },
          { text: 'no-ts-here' }, // missing ts -> skipped
          { ts: '1700000021.000' }, // missing text -> skipped
          { text: 'reject patch-ok2', ts: '1700000022.000' },
        ],
      }),
    });
    const surface = new SlackSurface(makeOpts());
    const result = await surface.pollSlackMessages();
    expect(result.decisions).toHaveLength(2);
    expect(result.latestTs).toBe('1700000022.000');
  });

  it('handles a non-Error throw in poll gracefully', async () => {
    fetchMock.mockRejectedValueOnce('string error, not an Error');
    const surface = new SlackSurface(makeOpts());
    const result = await surface.pollSlackMessages('ts-1');
    expect(result).toEqual({ decisions: [], latestTs: 'ts-1' });
  });
});

// ---------------------------------------------------------------------------
// deliverToSlack non-Error throw (covers the String(e) branch in its catch).
// ---------------------------------------------------------------------------

describe('SlackSurface deliverToSlack non-Error throws', () => {
  let dir: string;
  let outboxPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-nonerr-'));
    outboxPath = join(dir, 'slack-outbox.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues to outbox when fetch throws a non-Error value', async () => {
    fetchMock.mockRejectedValueOnce('a string, not an Error');
    const surface = new SlackSurface(makeOpts({ outboxPath }));
    await surface.postObservation({ submitted: 1, target: 2});
    expect(await readOutbox(outboxPath)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// NullSurface.flushOutbox is a no-op (no outbox).
// ---------------------------------------------------------------------------

describe('NullSurface.flushOutbox', () => {
  it('returns 0 and does nothing', async () => {
    const surface = new NullSurface(makeOpts());
    expect(await surface.flushOutbox()).toBe(0);
  });
});
