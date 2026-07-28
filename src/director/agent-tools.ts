/**
 * agent-tools.ts: Wraps the Director's tools for the agent loop.
 *
 * Two modes:
 *   - 'read'  (proposal phase): terminal + web_search only. No write access.
 *   - 'write' (execution phase): terminal + web_search + write_prompt_override.
 *
 * Tool calls are FREE — no Slack approval needed for either mode.
 * Only the final apply to director-overrides.env requires Slack approval,
 * which is handled by loop.ts after the agent loop returns.
 */

import { callTool as directorCallTool, toolDefinitions as directorToolDefs } from './tools.js';

export type AgentMode = 'read' | 'write';

/** Tool definitions scoped to the agent mode. */
export function toolDefinitions(mode: AgentMode = 'read'): ReturnType<typeof directorToolDefs> {
  const all = directorToolDefs();
  if (mode === 'write') return all;
  // Read-only: exclude write_prompt_override
  return all.filter((t) => t.function.name !== 'write_prompt_override');
}

/** Dispatch a tool call. Falls through to the Director's tools. */
export async function callTool(
  name: string,
  args: unknown,
  log: unknown,
): Promise<{ content: string; isError?: boolean }> {
  return directorCallTool(name, args, log);
}
