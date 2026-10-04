import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { observe, parseEventsLine, isCampaignComplete, countConfirmedSubmissions } from './observe.js';

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
    expect(snapshot.tracker).not.toHaveProperty('queueLength');
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
    expect(snapshot.tracker).not.toHaveProperty('queueLength'); // applyQueue ignored
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
    expect(snapshot.tracker).not.toHaveProperty('queueLength'); // applyQueue ignored even when present
    expect(snapshot.tracker.lastApplied).toEqual({
      source: '',
      company: 'Acme',
      roleTitle: '',
      at: '2026-08-01T00:00:00Z',
    });
  });
});

// 2026-10-04: the kafka observation reported stats.submitted, which
// update_tracker.py only ever INCREMENTS and never recomputes. Any write that
// rewrote or de-duplicated the applications list left the counter stranded, so
// the observed count drifted ~70 above reality and then jumped in one step when
// something finally recomputed it (observed 1655 -> 1725). The observation must
// count the way the python agent decides a submission counts: unique ids whose
// status is "submitted".
describe('tracker summary is consistent with the python agent', () => {
  /** Build a tracker.json shaped exactly like the campaign's real file. */
  function writeTracker(dir: string, t: Record<string, unknown>): void {
    writeFileSync(join(dir, 'tracker.json'), JSON.stringify(t));
  }

  it('counts unique submitted applications, not the stale stats counter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-drift-'));
    writeTracker(dir, {
      target: 2000,
      updatedAt: '2026-10-04T12:00:00Z',
      // stats is stranded 70 high, exactly like the live file.
      stats: { submitted: 1748, attempted_no_confirmation: 4 },
      applications: [
        { id: 'a', status: 'submitted' },
        { id: 'b', status: 'submitted' },
        { id: 'c', status: 'attempted' },
      ],
    });

    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir, maxEvents: 10 },
    );
    expect(snapshot.tracker.submitted).toBe(2);
  });

  it('counts a duplicated application id once, matching update_tracker dedupe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-dup-'));
    writeTracker(dir, {
      target: 2000,
      stats: { submitted: 2 },
      applications: [
        { id: 'nofluffjobs:java-software-engineer-aws-hl-tech-remote', status: 'submitted' },
        { id: 'nofluffjobs:java-software-engineer-aws-hl-tech-remote', status: 'submitted' },
      ],
    });

    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir, maxEvents: 10 },
    );
    expect(snapshot.tracker.submitted).toBe(1);
  });

  it('reports the legacy stats counter alongside the derived count so drift is visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-both-'));
    writeTracker(dir, {
      target: 2000,
      stats: { submitted: 1748 },
      applications: [
        { id: 'a', status: 'submitted' },
        { id: 'b', status: 'attempted' },
      ],
    });

    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir, maxEvents: 10 },
    );
    expect(snapshot.tracker.submitted).toBe(1);
    expect(snapshot.tracker.statsSubmitted).toBe(1748);
    expect(snapshot.tracker.drift).toBe(1747);
  });

  it('falls back to the legacy counter when applications is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-legacy-'));
    writeTracker(dir, { target: 2000, submittedCount: 100, stats: { submitted: 100 } });

    const { snapshot } = await observe(
      { eventsReadOffset: 0, lastTickAt: '' },
      { campaignDir: dir, maxEvents: 10 },
    );
    expect(snapshot.tracker.submitted).toBe(100);
    expect(snapshot.tracker.statsSubmitted).toBe(100);
    expect(snapshot.tracker.drift).toBe(0);
  });
});

// The live tracker has a submitted record with no `id` (a 1dea NoFluffJobs
// entry). update_tracker.py's derive_id falls back to `source:sourceJobId`, so
// the observation must use the same key or it counts differently from the agent.
describe('applicationKey mirrors update_tracker.derive_id', () => {
  it('uses id when present', () => {
    expect(countConfirmedSubmissions({ applications: [{ id: 'x', status: 'submitted' }] })).toBe(1);
  });

  it('falls back to source:sourceJobId when id is missing', () => {
    expect(
      countConfirmedSubmissions({
        applications: [
          { source: 'nofluffjobs', sourceJobId: '1dea-remote', status: 'submitted' },
        ],
      }),
    ).toBe(1);
  });

  it('dedupes an id-less record against one carrying the derived key', () => {
    // Same application recorded once with id and once without: python's
    // derive_id makes both `nofluffjobs:1dea-remote`, so they are one entry.
    expect(
      countConfirmedSubmissions({
        applications: [
          { id: 'nofluffjobs:1dea-remote', status: 'submitted' },
          { source: 'nofluffjobs', sourceJobId: '1dea-remote', status: 'submitted' },
        ],
      }),
    ).toBe(1);
  });

  it('still counts two different id-less records separately', () => {
    expect(
      countConfirmedSubmissions({
        applications: [
          { source: 'a', sourceJobId: 'one', status: 'submitted' },
          { source: 'a', sourceJobId: 'two', status: 'submitted' },
        ],
      }),
    ).toBe(2);
  });
});

// 2026-10-04 review BLOCKER: deriving `submitted` from the applications list made
// it ~74 LOWER than the python agent's own stats["submitted"]. Completion and
// staleness predicates that switched to the derived number alone entered a band
// where the agent has printed "CAMPAIGN COMPLETE" but the Director still thinks
// the campaign is running - respawning the worker each tick, rotating the VPN and
// flagging it stale forever. These pin the fix: EITHER count reaching target
// means complete, exactly as the agent decides.
describe('completion follows the agent, not just the derived count', () => {
  function dirWith(t: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'observe-complete-'));
    writeFileSync(join(dir, 'tracker.json'), JSON.stringify(t));
    return dir;
  }

  function manySubmitted(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({ id: `x${i}`, status: 'submitted' }));
  }

  it('is complete when the AGENT counter hit target even though derived has not', async () => {
    // The exact band: stats says done (update_tracker.py printed CAMPAIGN
    // COMPLETE), the applications list is still short of target.
    const dir = dirWith({
      target: 2000,
      stats: { submitted: 2000 },
      applications: manySubmitted(1926),
    });
    expect(await isCampaignComplete(dir)).toBe(true);
  });

  it('is complete when the DERIVED count hits target but the legacy counter lags', async () => {
    const dir = dirWith({
      target: 3,
      stats: { submitted: 1 },
      applications: manySubmitted(3),
    });
    expect(await isCampaignComplete(dir)).toBe(true);
  });

  it('is NOT complete when neither count reaches target', async () => {
    const dir = dirWith({ target: 2000, stats: { submitted: 1748 }, applications: manySubmitted(1674) });
    expect(await isCampaignComplete(dir)).toBe(false);
  });

  it('exposes complete on the snapshot so classify cannot re-derive it', async () => {
    const dir = dirWith({ target: 2000, stats: { submitted: 2000 }, applications: manySubmitted(1926) });
    const { snapshot } = await observe({ eventsReadOffset: 0, lastTickAt: '' }, { campaignDir: dir });
    expect(snapshot.tracker.complete).toBe(true);
    expect(snapshot.tracker.submitted).toBe(1926);
    expect(snapshot.tracker.drift).toBe(74);
  });

  it('counts attempted applications so unconfirmed submissions stay visible', async () => {
    const dir = dirWith({
      target: 2000,
      stats: { submitted: 5, attempted_no_confirmation: 4 },
      applications: [
        ...manySubmitted(5),
        { id: 'a1', status: 'attempted' },
        { id: 'a2', status: 'attempted' },
        { id: 'a3', status: 'attempted' },
      ],
    });
    const { snapshot } = await observe({ eventsReadOffset: 0, lastTickAt: '' }, { campaignDir: dir });
    expect(snapshot.tracker.attempted).toBe(3);
    expect(snapshot.tracker.submitted).toBe(5);
  });

  it('treats a target of 0 as not complete (fresh tracker is not a finished campaign)', async () => {
    const dir = dirWith({ target: 0, stats: { submitted: 0 }, applications: [] });
    expect(await isCampaignComplete(dir)).toBe(false);
  });
});

// update_tracker.derive_id does `if rec.get("id"): return str(rec["id"])` - any
// truthy non-object id is stringified. A numeric id must key the same way here,
// or the observation counts differently from the agent.
describe('applicationKey matches derive_id for non-string ids', () => {
  it('stringifies a numeric id instead of falling through', () => {
    expect(
      countConfirmedSubmissions({
        applications: [{ id: 12345, source: 'a', sourceJobId: 'x', status: 'submitted' }],
      }),
    ).toBe(1);
    // It must also dedupe against the string form of the same id.
    expect(
      countConfirmedSubmissions({
        applications: [
          { id: 12345, source: 'a', sourceJobId: 'x', status: 'submitted' },
          { id: '12345', source: 'b', sourceJobId: 'y', status: 'submitted' },
        ],
      }),
    ).toBe(1);
  });

  it('ignores an object id (python would stringify it; we cannot match that safely)', () => {
    // Falling through to source/sourceJobId is the safe choice: an object id has
    // no stable string form to compare against the agent's.
    expect(
      countConfirmedSubmissions({
        applications: [
          { id: { $oid: 1 }, source: 'a', sourceJobId: 'x', status: 'submitted' },
        ],
      }),
    ).toBe(1);
  });
});

// N4: the `submittedCount` fallback (trackers predating stats) was unreachable
// because the existing fixture also set stats.submitted, which wins.
describe('legacy tracker shapes', () => {
  it('falls back to submittedCount when stats is absent entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-nostats-'));
    writeFileSync(join(dir, 'tracker.json'), JSON.stringify({ targetApplications: 1200, submittedCount: 100 }));

    const { snapshot } = await observe({ eventsReadOffset: 0, lastTickAt: '' }, { campaignDir: dir });
    expect(snapshot.tracker.submitted).toBe(100);
    expect(snapshot.tracker.target).toBe(1200);
    expect(snapshot.tracker.statsSubmitted).toBe(100);
  });

  it('treats a falsy id as absent, matching derive_id truthiness', async () => {
    // python: `if rec.get("id")` - 0 / '' / false are falsy, so they fall through
    // to source:sourceJobId instead of keying as "0" / "" / "false".
    expect(
      countConfirmedSubmissions({
        applications: [{ id: 0, source: 'a', sourceJobId: 'x', status: 'submitted' }],
      }),
    ).toBe(1);
    expect(
      countConfirmedSubmissions({
        applications: [
          { id: 0, source: 'a', sourceJobId: 'x', status: 'submitted' },
          { source: 'a', sourceJobId: 'x', status: 'submitted' },
        ],
      }),
    ).toBe(1);
  });
});
