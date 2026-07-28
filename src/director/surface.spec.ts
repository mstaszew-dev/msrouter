import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { readLedger } from './ledger.js';
import { NullSurface, SlackSurface } from './surface.js';
import type { Patch } from './types.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const samplePatch: Patch = {
  id: 'p1',
  createdAt: '2026-07-27T10:00:00Z',
  overrides: { X: '1' },
  rationale: 'r',
  risk: 'low',
  classifications: [],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'director-surface-')), 'ledger.jsonl');
}

describe('NullSurface', () => {
  it('postProposal writes a proposed ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postProposal(samplePatch);
    const entries = await readLedger(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'proposed', patchId: 'p1' });
  });

  it('postDecision writes a decided ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postDecision({
      patchId: 'p1',
      decision: 'approved',
      decidedAt: 't',
      decidedBy: 'null-surface',
    });
    const entries = await readLedger(path);
    expect(entries[0]).toMatchObject({ kind: 'decided' });
  });

  it('postApplied writes an applied ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postApplied(samplePatch);
    expect((await readLedger(path))[0]).toMatchObject({ kind: 'applied', patchId: 'p1' });
  });

  it('postRestart writes a restart ledger entry with pid', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postRestart({ pid: 12345, logPath: '/tmp/x.log' });
    expect((await readLedger(path))[0]).toMatchObject({ kind: 'restart' });
  });

  it('pollSlackMessages returns empty on NullSurface', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    const result = await s.pollSlackMessages('123.456');
    expect(result.decisions).toEqual([]);
    expect(result.latestTs).toBe('123.456');
  });
});

describe('SlackSurface', () => {
  it('pollSlackMessages returns empty when no bot token configured', async () => {
    const path = ledgerPath();
    const s = new SlackSurface({ ledgerPath: path, log: silent });
    const result = await s.pollSlackMessages();
    expect(result.decisions).toEqual([]);
  });

  it('postProposal sends to Slack (mocked fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const path = ledgerPath();
    const s = new SlackSurface({
      ledgerPath: path,
      log: silent,
      slackWebhook: 'https://hooks.slack.com/test',
    });
    await s.postProposal(samplePatch);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe('https://hooks.slack.com/test');
    fetchSpy.mockRestore();
  });

  it('pollSlackMessages parses approve command (mocked fetch)', async () => {
    const mockMessages = {
      ok: true,
      messages: [
        { text: 'approve patch-abc-123', ts: '1000.1' },
        { text: 'some random message', ts: '1000.0' },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const path = ledgerPath();
    const s = new SlackSurface({
      ledgerPath: path,
      log: silent,
      slackBotToken: 'xoxb-test',
      slackChannel: 'C12345',
    });
    const result = await s.pollSlackMessages();
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      patchId: 'patch-abc-123',
      decision: 'approved',
      decidedBy: 'slack',
    });
    expect(result.latestTs).toBe('1000.1');
    fetchSpy.mockRestore();
  });

  it('pollSlackMessages parses reject command (mocked fetch)', async () => {
    const mockMessages = {
      ok: true,
      messages: [{ text: 'reject bad-patch-456', ts: '2000.5' }],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const path = ledgerPath();
    const s = new SlackSurface({
      ledgerPath: path,
      log: silent,
      slackBotToken: 'xoxb-test',
      slackChannel: 'C12345',
    });
    const result = await s.pollSlackMessages();
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      patchId: 'bad-patch-456',
      decision: 'rejected',
    });
    fetchSpy.mockRestore();
  });

  it('pollSlackMessages respects lastTs for dedup', async () => {
    const mockMessages = {
      ok: true,
      messages: [{ text: 'approve newer-patch', ts: '3000.0' }],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const path = ledgerPath();
    const s = new SlackSurface({
      ledgerPath: path,
      log: silent,
      slackBotToken: 'xoxb-test',
      slackChannel: 'C12345',
    });
    const result = await s.pollSlackMessages('2999.0');
    // Should have passed oldest=2999.0 to the API
    const callUrl = typeof fetchSpy.mock.calls[0]?.[0] === 'string'
      ? fetchSpy.mock.calls[0][0]
      : '';
    expect(callUrl).toContain('oldest=2999.0');
    expect(result.latestTs).toBe('3000.0');
    fetchSpy.mockRestore();
  });

  it('pollSlackMessages returns empty on API error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const path = ledgerPath();
    const s = new SlackSurface({
      ledgerPath: path,
      log: silent,
      slackBotToken: 'xoxb-test',
      slackChannel: 'C12345',
    });
    const result = await s.pollSlackMessages();
    expect(result.decisions).toEqual([]);
    fetchSpy.mockRestore();
  });
});
