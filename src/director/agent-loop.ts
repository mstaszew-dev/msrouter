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

import { callTool, toolDefinitions } from './agent-tools.js';
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
      tools: toolDefinitions() as ChatRequestBody['tools'],
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

/** Parse patches JSON from agent output. Looks for last {"patches":[...]} block. */
export function parseAgentPatches(text: string): Patch[] {
  // Try to find a JSON block with patches
  const jsonMatch = text.match(/\{[\s\S]*?"patches"[\s\S]*?\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const patches = parsed['patches'];
    if (!Array.isArray(patches)) return [];
    return patches.map((p: Record<string, unknown>) => {
      const overrides = p['overrides'] as Record<string, string> | undefined;
      if (!overrides) return null;
      // Validate env-var-shaped keys
      for (const k of Object.keys(overrides)) {
        if (!KEY_RE.test(k)) return null;
      }
      return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        overrides,
        rationale: String(p['rationale'] ?? ''),
        risk: (p['risk'] as 'low' | 'medium' | 'high') ?? 'low',
        classifications: [],
      };
    }).filter(Boolean) as Patch[];
  } catch {
    return [];
  }
}
