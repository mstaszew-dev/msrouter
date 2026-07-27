import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env.js';

import { isGoalMet } from './goal.js';

// env() is cached from setup.ts; override AGENT_MAX_STEPS for these tests.
loadEnv({
  NODE_ENV: 'test',
  PORT: '8788',
  AGENT_MAX_STEPS: '5',
  AGENT_GOAL: 'do thing',
});

describe('isGoalMet', () => {
  it('detects a completion marker', () => {
    const r = isGoalMet({ goal: 'do thing', lastAssistantText: 'all done. shipped it', steps: 1 });
    expect(r.met).toBe(true);
    expect(r.reason).toMatch(/completion marker/);
  });

  it('forces stop at max steps even without a marker', () => {
    const r = isGoalMet({ goal: 'do thing', lastAssistantText: 'still working', steps: 5 });
    expect(r.met).toBe(true);
    expect(r.reason).toMatch(/max steps/);
  });

  it('returns not-met when under the limit and no marker', () => {
    const r = isGoalMet({ goal: 'do thing', lastAssistantText: 'wip', steps: 2 });
    expect(r.met).toBe(false);
  });

  it('returns not-met when no goal is configured', () => {
    const r = isGoalMet({ goal: '', lastAssistantText: 'anything', steps: 1 });
    expect(r.met).toBe(false);
    expect(r.reason).toMatch(/no goal/);
  });
});
