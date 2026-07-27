import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { observe, parseEventsLine } from './observe.js';

function makeCampaignDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-obs-'));
  // Minimal tracker.json matching the shape observe() reads.
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      submittedCount: 100,
      targetApplications: 1200,
      target: 1200,
      applyQueue: [],
      lastApplied: { source: 'drushim', company: 'Acme', roleTitle: 'BE Dev', status: 'submitted' },
      updatedAt: '2026-07-27T12:00:00Z',
      stats: {
        submitted: 100,
        skippedDuplicate: 5,
        skippedSalary: 1,
        skippedFilter: 2,
        blockedManual: 0,
        errors: 0,
      },
    }),
  );
  return dir;
}

describe('parseEventsLine', () => {
  it('parses a submitted event', () => {
    const line = JSON.stringify({
      at: '2026-07-27T10:00:00Z',
      action: 'submitted',
      record: { id: 'abc', company: 'Acme', roleTitle: 'BE Dev', status: 'submitted' },
    });
    const e = parseEventsLine(line);
    expect(e?.action).toBe('submitted');
    expect(e?.record['company']).toBe('Acme');
  });

  it('returns null for a malformed line', () => {
    expect(parseEventsLine('not json')).toBeNull();
    expect(parseEventsLine('')).toBeNull();
  });

  it('returns null for a line missing required fields', () => {
    expect(parseEventsLine(JSON.stringify({ at: 'x' }))).toBeNull(); // no action/record
  });
});

describe('observe', () => {
  it('reads tracker.json into TrackerSummary', async () => {
    const dir = makeCampaignDir();
    writeFileSync(join(dir, 'events.jsonl'), '');
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.tracker.submitted).toBe(100);
    expect(snapshot.tracker.target).toBe(1200);
    expect(snapshot.tracker.queueLength).toBe(0);
  });

  it('tails events.jsonl from the checkpoint byte offset', async () => {
    const dir = makeCampaignDir();
    const e1 = JSON.stringify({
      at: '2026-07-27T10:00:00Z',
      action: 'submitted',
      record: { id: 'a' },
    });
    const e2 = JSON.stringify({
      at: '2026-07-27T11:00:00Z',
      action: 'skippedFilter',
      record: { reason: 'manual' },
    });
    writeFileSync(join(dir, 'events.jsonl'), `${e1}\n${e2}\n`);
    const { snapshot, checkpoint } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.recentEvents).toHaveLength(2);
    expect(snapshot.recentEvents[0]!.action).toBe('submitted');
    expect(checkpoint.eventsReadOffset).toBe(Buffer.byteLength(`${e1}\n${e2}\n`));
  });

  it('does not re-read events already past the checkpoint', async () => {
    const dir = makeCampaignDir();
    const e1 = JSON.stringify({
      at: '2026-07-27T10:00:00Z',
      action: 'submitted',
      record: { id: 'a' },
    });
    const e2 = JSON.stringify({
      at: '2026-07-27T11:00:00Z',
      action: 'submitted',
      record: { id: 'b' },
    });
    const content = `${e1}\n${e2}\n`;
    writeFileSync(join(dir, 'events.jsonl'), content);
    const offsetAfterFirst = Buffer.byteLength(`${e1}\n`);
    const { snapshot, checkpoint } = await observe(
      { eventsReadOffset: offsetAfterFirst, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.recentEvents).toHaveLength(1);
    expect(snapshot.recentEvents[0]!.record['id']).toBe('b');
    expect(checkpoint.eventsReadOffset).toBe(Buffer.byteLength(content));
  });

  it('produces an empty recentEvents array when events.jsonl is absent', async () => {
    const dir = makeCampaignDir();
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('drops a trailing partial line (no newline) and does not advance past it', async () => {
    const dir = makeCampaignDir();
    const complete = JSON.stringify({
      at: 't',
      action: 'submitted',
      record: { id: 'a' },
    });
    const partial = '{"at":"t","action":"submitted","record":{'; // no closing, no newline
    writeFileSync(join(dir, 'events.jsonl'), `${complete}\n${partial}`);
    const { snapshot, checkpoint } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    // Only the complete event is parsed.
    expect(snapshot.recentEvents).toHaveLength(1);
    // Offset advanced past the complete line + its newline, NOT past the partial.
    expect(checkpoint.eventsReadOffset).toBe(Buffer.byteLength(`${complete}\n`));
  });

  it('respects maxEvents cap', async () => {
    const dir = makeCampaignDir();
    const one = JSON.stringify({ at: 't', action: 'submitted', record: { id: 'x' } });
    writeFileSync(join(dir, 'events.jsonl'), `${one}\n${one}\n${one}\n`);
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir, maxEvents: 2 },
    );
    expect(snapshot.recentEvents).toHaveLength(2);
  });
});
