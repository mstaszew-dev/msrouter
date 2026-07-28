/**
 * agent-tools.ts: Wraps the Director's tools (terminal, web_search, write_prompt_override)
 * in the format the AgentLoop expects. This lets the Director's LLM call tools
 * autonomously (terminal, web_search) while gating write_prompt_override through the
 * normal Slack approval flow.
 *
 * Tool calls are FREE — no Slack approval needed.
 * Writing overrides or restarting the campaign requires Slack approval
 * (handled by loop.ts after the agent loop returns).
 */

import { callTool as directorCallTool, toolDefinitions as directorToolDefs } from './tools.js';

/** Tool definitions the Director's LLM can call. */
export function toolDefinitions(): ReturnType<typeof directorToolDefs> {
  return directorToolDefs();
}

/** Dispatch a tool call by name. Falls through to the Director's tools. */
export async function callTool(
  name: string,
  args: unknown,
  log: unknown,
): Promise<{ content: string; isError?: boolean }> {
  return directorCallTool(name, args, log);
}
