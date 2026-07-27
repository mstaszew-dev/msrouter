import { describe, expect, it } from 'vitest';

import { classify } from './classify.js';
import type { CampaignEvent, CampaignSnapshot } from './types.js';

function snap(events: CampaignEvent[]): CampaignSnapshot {
  return {
    fetchedAt: '2026-07-27T12:00:00Z',
    tracker: { submitted: 0, target: 1200, queueLength: 0, updatedAt: '2026-07-27T12:00:00Z' },
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
  it('flags a portal-error skip', () => {
    const out = classify(snap([skipped('login_or_captcha_required')]));
    expect(out).toContainEqual(expect.objectContaining({ kind: 'portal-error', severity: 'warn' }));
  });

  it('flags a duplicate-risk when the same companyKey is submitted twice', () => {
    const out = classify(
      snap([submitted({ companyKey: 'acme' }), submitted({ companyKey: 'acme' })]),
    );
    // First occurrence is a legitimate good-apply; only the second is a duplicate.
    expect(out.filter((c) => c.kind === 'duplicate-risk')).toHaveLength(1);
    expect(out.filter((c) => c.kind === 'good-apply')).toHaveLength(1);
  });

  it('flags a risky-apply on an excluded title', () => {
    const out = classify(snap([submitted({ roleTitle: 'Tech Lead' })]));
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'risky-apply', severity: 'critical' }),
    );
  });

  it('flags a bad-skip on a manual skip of a core-stack role', () => {
    const out = classify(snap([skipped('manual', { roleTitle: 'Senior Java Developer' })]));
    expect(out).toContainEqual(expect.objectContaining({ kind: 'bad-skip', severity: 'warn' }));
  });

  it('tags a clean submit as good-apply', () => {
    const out = classify(snap([submitted()]));
    expect(out).toContainEqual(expect.objectContaining({ kind: 'good-apply', severity: 'info' }));
  });

  it('returns no bad-skip when the skipped role is genuinely excluded', () => {
    const out = classify(snap([skipped('manual', { roleTitle: 'Team Leader' })]));
    expect(out.find((c) => c.kind === 'bad-skip')).toBeUndefined();
  });
});
