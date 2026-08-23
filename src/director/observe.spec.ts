import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { observe, parseEventsLine, isCampaignComplete } from './observe.js';

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

/** Write a tracker.json with the given submitted/target pair, returns the dir. */
function makeCampaignWith(submitted: number, target: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-complete-'));
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      submittedCount: submitted,
      targetApplications: target,
      target,
      stats: { submitted },
      updatedAt: '2026-07-27T12:00:00Z',
    }),
  );
  return dir;
}

describe('isCampaignComplete', () => {
  it('returns true when submitted meets target', async () => {
    const dir = makeCampaignWith(1200, 1200);
    await expect(isCampaignComplete(dir)).resolves.toBe(true);
  });

  it('returns true when submitted exceeds target (campaign overshoot)', async () => {
    const dir = makeCampaignWith(1215, 1200);
    await expect(isCampaignComplete(dir)).resolves.toBe(true);
  });

  it('returns false when submitted is below target', async () => {
    const dir = makeCampaignWith(748, 1200);
    await expect(isCampaignComplete(dir)).resolves.toBe(false);
  });

  it('returns false when target is zero (disabled / unknown)', async () => {
    // A target of 0 means the campaign has no goal defined; we must not treat
    // a fresh/empty tracker as "complete" or the Director would never start.
    const dir = makeCampaignWith(0, 0);
    await expect(isCampaignComplete(dir)).resolves.toBe(false);
  });

  it('returns false when the tracker is missing or unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-empty-'));
    await expect(isCampaignComplete(dir)).resolves.toBe(false);
  });

  it('returns false when the tracker is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-badjson-'));
    writeFileSync(join(dir, 'tracker.json'), '{ not json');
    await expect(isCampaignComplete(dir)).resolves.toBe(false);
  });
});

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

  it('captures trimmed stdout from a successful tick_status.sh run', async () => {
    const dir = makeCampaignDir();
    writeFileSync(join(dir, 'events.jsonl'), '');
    writeFileSync(join(dir, 'tick_status.sh'), '#!/bin/sh\necho "  submitted=5 ok  "\n');
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    // The raw script output is trimmed before landing in the snapshot.
    expect(snapshot.tickStatus).toBe('submitted=5 ok');
  });

  it('falls back across legacy tracker field spellings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-obs-legacy-'));
    writeFileSync(
      join(dir, 'tracker.json'),
      JSON.stringify({ submittedCount: 7, target: 9 }),
    );
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.tracker.submitted).toBe(7); // stats missing -> submittedCount
    expect(snapshot.tracker.target).toBe(9); // targetApplications missing -> target
    expect(snapshot.tracker.queueLength).toBe(0); // applyQueue missing
    expect(snapshot.tracker.lastApplied).toBeUndefined();
    expect(snapshot.tracker.updatedAt).toBe('');
  });

  it('maps lastApplied into the summary when a company is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-obs-applied-'));
    writeFileSync(
      join(dir, 'tracker.json'),
      JSON.stringify({
        stats: { submitted: 3 },
        targetApplications: 10,
        applyQueue: [{ id: 'q1' }, { id: 'q2' }],
        lastApplied: { company: 'Acme' }, // no source / roleTitle -> defaults
        updatedAt: '2026-08-01T00:00:00Z',
      }),
    );
    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir },
    );
    expect(snapshot.tracker.queueLength).toBe(2);
    expect(snapshot.tracker.lastApplied).toEqual({
      source: '',
      company: 'Acme',
      roleTitle: '',
      at: '2026-08-01T00:00:00Z',
    });
  });
});
