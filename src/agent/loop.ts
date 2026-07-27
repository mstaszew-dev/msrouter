/**
 * The scheduled agent loop. One run = drive the model with the configured
 * prompt + tools until the goal is met (or AGENT_MAX_STEPS). Uses the SAME
 * provider chain as the gateway, so it benefits from OpenRouter key pooling and
 * OpenAI/ZAI/OpenCode fallback. Non-streaming (the agent consumes full
 * responses to inspect tool_calls).
 *
 * Bounded: max steps, per-turn abort, transient retry via the chain. Adapted
 * from joblooper's runTurnWithRetry pattern.
 */

import type { Logger } from 'pino';

import { errorMessage } from '../common/errors.js';
import { sleep } from '../common/retry.js';
import { env } from '../config/env.js';
import { type ProviderChain } from '../providers/chain.js';
import type { ChatRequestBody } from '../providers/types.js';

import { isGoalMet } from './goal.js';
import { callTool, toolDefinitions } from './tools.js';

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

export interface AgentRunResult {
  steps: number;
  goalMet: boolean;
  reason: string;
  transcript: string;
}

export class AgentLoop {
  constructor(
    private readonly chain: ProviderChain,
    private readonly log: Logger,
  ) {}

  async runOnce(signal: AbortSignal): Promise<AgentRunResult> {
    const cfg = env();
    const model = cfg.AGENT_MODEL || cfg.WALK_ALIAS[0] || 'mst/free';
    const system = cfg.AGENT_PROMPT || 'You are a helpful autonomous agent. Use tools when useful.';
    const goal = cfg.AGENT_GOAL;
    const maxSteps = cfg.AGENT_MAX_STEPS;

    const messages: AgentMessage[] = [
      { role: 'system', content: system },
      ...(goal ? [{ role: 'system' as const, content: `Goal: ${goal}` }] : []),
    ];

    let steps = 0;
    let transcript = '';

    while (steps < maxSteps) {
      if (signal.aborted) {
        return { steps, goalMet: false, reason: 'aborted', transcript };
      }
      steps++;
      const body: ChatRequestBody = {
        model,
        messages,
        tools: toolDefinitions(),
        stream: false,
      };

      let assistant: AgentMessage | undefined;
      try {
        const { response } = await this.chain.handle(body, signal);
        const json = (await response.json()) as {
          choices?: Array<{ message?: AgentMessage }>;
        };
        assistant = json.choices?.[0]?.message;
      } catch (e) {
        this.log.error({ err: errorMessage(e), step: steps }, 'agent model call failed');
        // Transient-ish: back off and retry the same step a few times.
        await sleep(2_000 * Math.min(steps, 5));
        continue;
      }

      if (!assistant) {
        this.log.warn({ step: steps }, 'agent: no message returned');
        break;
      }
      messages.push(assistant);
      const text = typeof assistant.content === 'string' ? assistant.content : '';
      transcript += text + '\n';
      this.log.info({ step: steps, preview: text.slice(0, 160) }, 'agent turn');

      // Execute any tool calls and append their results.
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
          const result = await callTool(tc.function.name, args, this.log);
          this.log.info({ tool: tc.function.name, isError: result.isError }, 'tool result');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: result.content,
          });
          transcript += `[tool ${tc.function.name}]: ${result.content}\n`;
        }
        continue; // let the model react to the tool results
      }

      // No tool calls: check the goal against ONLY this assistant message
      // (not the tool-output-laden transcript) to avoid false positives.
      const check = isGoalMet({ goal, lastAssistantText: text, steps });
      if (check.met) {
        return { steps, goalMet: true, reason: check.reason, transcript };
      }
    }

    const final = isGoalMet({ goal, lastAssistantText: '', steps });
    return { steps, goalMet: final.met, reason: final.reason, transcript };
  }
}
