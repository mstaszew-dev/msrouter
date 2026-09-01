import { describe, expect, it } from 'vitest';

import { classify } from './classify.js';
import type { CampaignEvent, CampaignSnapshot } from './types.js';

function snap(events: CampaignEvent[]): CampaignSnapshot {
  return {
    fetchedAt: '2026-07-27T12:00:00Z',
    tracker: { submitted: 0, target: 1200, updatedAt: '2026-07-27T12:00:00Z' },
    recentEvents: events,
    tickStatus: '',
  };
}

function submitted(over: Record<string, unknown> = {}): CampaignEvent {
  return {
    at: '2026-07-27T10:00:00Z',
    action: 'submitted',
    record: {
      id: 'x',
      company: 'Acme',
      companyKey: 'acme',
      roleTitle: 'Backend Developer',
      status: 'submitted',
      ...over,
    },
  };
}

function skipped(detail: string, over: Record<string, unknown> = {}): CampaignEvent {
  return {
    at: '2026-07-27T10:00:00Z',
    action: 'skippedFilter',
    record: { reason: 'manual', detail, ...over },
  };
}

describe('classify', () => {
  const now = '2026-07-27T12:00:00Z';

  it('flags a portal-error skip', () => {
    const out = classify(snap([skipped('login_or_captcha_required')]), now, now);
    expect(out).toContainEqual(expect.objectContaining({ kind: 'portal-error', severity: 'warn' }));
  });

  it('flags a duplicate-risk when the same companyKey is submitted twice', () => {
    const out = classify(
      snap([submitted({ companyKey: 'acme' }), submitted({ companyKey: 'acme' })]),
      now,
      now,
    );
    // First occurrence is a legitimate good-apply; only the second is a duplicate.
    expect(out.filter((c) => c.kind === 'duplicate-risk')).toHaveLength(1);
    expect(out.filter((c) => c.kind === 'good-apply')).toHaveLength(1);
  });

  it('flags a risky-apply on an excluded title', () => {
    const out = classify(snap([submitted({ roleTitle: 'Tech Lead' })]), now, now);
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'risky-apply', severity: 'critical' }),
    );
  });

  it('flags a bad-skip on a manual skip of a core-stack role', () => {
    const out = classify(snap([skipped('manual', { roleTitle: 'Senior Java Developer' })]), now, now);
    expect(out).toContainEqual(expect.objectContaining({ kind: 'bad-skip', severity: 'warn' }));
  });

  it('tags a clean submit as good-apply', () => {
    const out = classify(snap([submitted()]), now, now);
    expect(out).toContainEqual(expect.objectContaining({ kind: 'good-apply', severity: 'info' }));
  });

  it('returns no bad-skip when the skipped role is genuinely excluded', () => {
    const out = classify(snap([skipped('manual', { roleTitle: 'Team Leader' })]), now, now);
    expect(out.find((c) => c.kind === 'bad-skip')).toBeUndefined();
  });

  it('flags stale-campaign when no events for more than 60 minutes', () => {
    const oldEventAt = '2026-07-27T10:00:00Z'; // 2 hours before now
    const out = classify(snap([]), now, oldEventAt);
    expect(out).toContainEqual(expect.objectContaining({ kind: 'stale-campaign', severity: 'warn' }));
  });

  it('does not flag stale-campaign when events exist', () => {
    const out = classify(snap([submitted()]), now, now);
    expect(out.find((c) => c.kind === 'stale-campaign')).toBeUndefined();
  });

  it('does not flag stale-campaign when the campaign target is already met', () => {
    // A completed campaign is done, not stuck: the agent exits on purpose.
    // Flagging it stale would trigger VPN rotation + worker restarts forever
    // (2026-09-01: the tracker.updatedAt fallback made completed campaigns
    // look permanently idle).
    const done = snap([]);
    done.tracker = { submitted: 1215, target: 1200, updatedAt: '2026-07-27T12:00:00Z' };
    const out = classify(done, now, '2026-07-27T10:00:00Z'); // 2h idle
    expect(out.find((c) => c.kind === 'stale-campaign')).toBeUndefined();
  });

  it('does not flag stale-campaign when idle time is under 60 minutes', () => {
    const recentEventAt = '2026-07-27T11:30:00Z'; // 30 min before now
    const out = classify(snap([]), now, recentEventAt);
    expect(out.find((c) => c.kind === 'stale-campaign')).toBeUndefined();
  });

  it('treats object/array record values as empty strings (never regex-matched)', () => {
    // A malformed record whose roleTitle/companyKey are objects must fall
    // through to good-apply, not throw or spuriously match policy regexes.
    const out = classify(
      snap([submitted({ roleTitle: { nested: 'Team Lead' }, companyKey: ['acme'] })]),
      now,
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(
      expect.objectContaining({ kind: 'good-apply', severity: 'info', reason: 'Clean submission: (no title)' }),
    );
  });
});
