/**
 * Goal-met detection. Operates ONLY on the latest assistant message text (not
 * the concatenated transcript, which includes tool output that can casually
 * contain "done." / "finished." in build logs or git output and cause false
 * positives). A completion marker must be the dominant content of the latest
 * assistant turn, or the step cap forces a stop.
 */

import { env } from '../config/env.js';

export interface GoalCheckInput {
  goal: string;
  /** The LATEST assistant message text only (not tool output). */
  lastAssistantText: string;
  /** Steps taken so far. */
  steps: number;
}

export interface GoalCheckResult {
  met: boolean;
  reason: string;
}

// Markers that indicate the agent has finished. Matched as whole-word/phrase
// boundaries so "I'm not done yet" doesn't fire.
const COMPLETION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgoal (achieved|met|complete|completed)\b/i,
  /\btask (complete|completed|done)\b/i,
  /\bfinished\b/i,
  /\bdone\b/i,
];

export function isGoalMet(input: GoalCheckInput): GoalCheckResult {
  const { goal, lastAssistantText, steps } = input;
  if (!goal) {
    return { met: false, reason: 'no goal configured' };
  }
  const trimmed = (lastAssistantText ?? '').trim();
  // Require the assistant message to be short AND contain a marker, so a long
  // narration that happens to include "done" mid-sentence doesn't fire. A real
  // completion message is typically a brief sign-off.
  if (trimmed.length > 0 && trimmed.length <= 200) {
    if (COMPLETION_PATTERNS.some((re) => re.test(trimmed))) {
      return { met: true, reason: 'completion marker in final assistant message' };
    }
  }
  // Safety bound: never run forever regardless of markers.
  if (steps >= env().AGENT_MAX_STEPS) {
    return { met: true, reason: 'max steps reached (forced stop)' };
  }
  return { met: false, reason: 'goal not yet satisfied' };
}
