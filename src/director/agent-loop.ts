/**
 * agent-loop.ts: Self-contained agent loop for the Director. Separate from the
 * router's AgentLoop (src/agent/loop.ts) so changes to one don't affect the other.
 *
 * Drives the model with the Director's tools (terminal, web_search, write_prompt_override).
 * The model calls tools freely. Patches are extracted from the final response.
 * Slack approval gates only the APPLY step (writing to overrides.env / restarting).
 */

import type { Logger } from 'pino';

import { errorMessage } from '../common/errors.js';
import { sleep } from '../common/retry.js';
import type { ProviderChain } from '../providers/chain.js';
import type { ChatRequestBody } from '../providers/types.js';

import { callTool, toolDefinitions, type AgentMode } from './agent-tools.js';
import type { Patch } from './types.js';

interface AgentMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface DirectorAgentResult {
  steps: number;
  patches: Patch[];
  transcript: string;
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Run the Director agent loop. The model has access to terminal, web_search,
 * and write_prompt_override tools. It investigates and proposes patches.
 * Patches are returned for Slack approval (loop.ts handles the gate).
 */
export async function runDirectorAgent(
  chain: ProviderChain,
  systemPrompt: string,
  goal: string,
  model: string,
  log: Logger,
  signal: AbortSignal,
  mode: AgentMode = 'read',
): Promise<DirectorAgentResult> {
  const maxSteps = 10;

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(goal ? [{ role: 'system' as const, content: `Goal: ${goal}` }] : []),
  ];

  let steps = 0;
  let transcript = '';

  while (steps < maxSteps) {
    if (signal.aborted) {
      return { steps, patches: [], transcript };
    }
    steps++;
    const body: ChatRequestBody = {
      model,
      messages,
      tools: toolDefinitions(mode),
      stream: false,
    };

    let assistant: AgentMessage | undefined;
    try {
      const { response } = await chain.handle(body, signal);
      const json = (await response.json()) as {
        choices?: Array<{ message?: AgentMessage }>;
      };
      assistant = json.choices?.[0]?.message;
    } catch (e) {
      log.error({ err: errorMessage(e), step: steps }, 'director agent call failed');
      await sleep(2_000 * Math.min(steps, 5));
      continue;
    }

    if (!assistant) {
      log.warn({ step: steps }, 'director agent: no message returned');
      break;
    }
    messages.push(assistant);
    const text = typeof assistant.content === 'string' ? assistant.content : '';
    transcript += text + '\n';
    log.info({ step: steps, preview: text.slice(0, 160) }, 'director agent turn');

    // Execute tool calls
    if (assistant.tool_calls?.length) {
      for (const tc of assistant.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          if (tc.function.arguments) {
            const parsed: unknown = JSON.parse(tc.function.arguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            } else {
              args = { _value: parsed };
            }
          }
        } catch {
          args = { _raw: tc.function.arguments };
        }
        const result = await callTool(tc.function.name, args, log);
        log.info({ tool: tc.function.name, isError: result.isError }, 'tool result');
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result.content,
        });
        transcript += `[tool ${tc.function.name}]: ${result.content}\n`;
      }
      continue;
    }

    // No tool calls — check if the response contains patches
    const patches = parseAgentPatches(text);
    if (patches.length > 0) {
      return { steps, patches, transcript };
    }

    // No patches, no tools — continue unless we've been going too long
    if (steps >= maxSteps) break;
  }

  return { steps, patches: [], transcript };
}

/** Parse patches JSON from agent output. Finds the outermost {...} containing "patches". */
export function parseAgentPatches(text: string): Patch[] {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return [];

  let depth = 0;
  let jsonStr = '';
  let started = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; }
    if (started) jsonStr += ch;
    if (started && depth === 0) break;
  }
  if (!jsonStr.includes('"patches"')) return [];

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const patches = parsed['patches'];
    if (!Array.isArray(patches)) return [];
    const results: Patch[] = [];
    for (const item of patches) {
      if (!item || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;
      const overrides = p['overrides'];
      if (!overrides || typeof overrides !== 'object') continue;
      const clean: Record<string, string> = {};
      const entries = Object.entries(overrides as Record<string, unknown>);
      let valid = true;
      for (const [k, v] of entries) {
        if (!KEY_RE.test(k) || typeof v !== 'string') {
          valid = false;
          break;
        }
        clean[k] = v;
      }
      if (!valid || Object.keys(clean).length === 0) continue;
      results.push({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        overrides: clean,
        rationale: typeof p['rationale'] === 'string' ? p['rationale'] : '',
        risk: p['risk'] === 'medium' || p['risk'] === 'high' ? p['risk'] : 'low',
        classifications: [],
      });
    }
    return results;
  } catch {
    return [];
  }
}
