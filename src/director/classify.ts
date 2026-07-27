/**
 * classify.ts: deterministic decision-quality classification. No LLM in P2.
 * Each rule inspects the recentEvents in the snapshot and emits zero or more
 * DecisionClassifications. The propose() step later turns these into patches.
 *
 * Rules mirror the campaign's existing policy (score_candidate.py hard-negative
 * titles, the 60-day dedupe contract, and observed portal-error patterns).
 */

import type { CampaignSnapshot, DecisionClassification } from './types.js';

const EXCLUDED_TITLE =
  /team\s*lead|tech\s*lead|technical\s*lead|principal|staff|architect|manager|director|\bhead\b|\bvp\b/i;
const PORTAL_ERROR = /login|captcha|timeout|5\d\d|429/i;
const CORE_STACK = /java|kotlin|spring|php|laravel|node|react/i;

/** Coerce an unknown record value to a string for regex matching. Objects and
 *  arrays become '' so they never spuriously match the policy regexes. */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function classify(snapshot: CampaignSnapshot): DecisionClassification[] {
  const out: DecisionClassification[] = [];
  const submittedByCompany = new Map<string, number>();

  for (const e of snapshot.recentEvents) {
    if (e.action === 'submitted') {
      const rec = e.record;
      const companyKey = str(rec['companyKey']);
      const roleTitle = str(rec['roleTitle']);
      const id = str(rec['id']);
      const prev = submittedByCompany.get(companyKey) ?? 0;
      submittedByCompany.set(companyKey, prev + 1);

      if (EXCLUDED_TITLE.test(roleTitle)) {
        out.push({
          eventId: id,
          kind: 'risky-apply',
          severity: 'critical',
          reason: `Submitted an excluded seniority/title: "${roleTitle}"`,
          evidence: roleTitle,
        });
      } else if (prev > 0 && companyKey) {
        out.push({
          eventId: id,
          kind: 'duplicate-risk',
          severity: 'critical',
          reason: `Company "${companyKey}" submitted ${prev + 1} times in this window`,
          evidence: companyKey,
        });
      } else {
        out.push({
          eventId: id,
          kind: 'good-apply',
          severity: 'info',
          reason: `Clean submission: ${roleTitle || '(no title)'}`,
        });
      }
    } else if (e.action === 'skippedFilter') {
      const rec = e.record;
      const detail = str(rec['detail']);
      const roleTitle = str(rec['roleTitle']);
      const id = str(rec['id']);
      if (PORTAL_ERROR.test(detail)) {
        out.push({
          eventId: id,
          kind: 'portal-error',
          severity: 'warn',
          reason: `Portal error pattern: "${detail}"`,
          evidence: detail,
        });
      } else if (roleTitle && !EXCLUDED_TITLE.test(roleTitle) && CORE_STACK.test(roleTitle)) {
        out.push({
          eventId: id,
          kind: 'bad-skip',
          severity: 'warn',
          reason: `Manually skipped a core-stack role: "${roleTitle}"`,
          evidence: roleTitle,
        });
      }
    }
  }
  return out;
}
