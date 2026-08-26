/**
 * propose.ts: draft behavioral patches via the chain. Builds a prompt from the
 * snapshot + classifications + current overrides, calls the model, parses the
 * strict JSON response into Patch objects. Failures (network, malformed JSON,
 * bad key shapes) yield an empty array - the Director never blocks on LLM I/O.
 *
 * Patches are PROPOSALS only. They are not applied here; the surface owns that.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';

import type { ProviderChain } from '../providers/chain.js';
import type { ChatRequestBody } from '../providers/types.js';

import { readOverrides } from './apply.js';
import type { CampaignSnapshot, DecisionClassification, Patch } from './types.js';

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'prompt.md');
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface ProposeContext {
  chain: ProviderChain;
  overridesPath: string;
  model: string;
  log: Logger;
  signal: AbortSignal;
}

/** Parse the model's JSON response into validated Patches. Exported for tests. */
export function parseProposeResponse(raw: string): Patch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const patches = (parsed as { patches?: unknown }).patches;
  if (!Array.isArray(patches)) return [];
  const out: Patch[] = [];
  for (const p of patches) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as Record<string, unknown>;
    const overrides = obj['overrides'];
    if (!overrides || typeof overrides !== 'object') continue;
    const entries = Object.entries(overrides as Record<string, unknown>);
    const clean: Record<string, string> = {};
    let ok = true;
    for (const [k, v] of entries) {
      if (!KEY_RE.test(k) || typeof v !== 'string') {
        ok = false;
        break;
      }
      clean[k] = v;
    }
    if (!ok || Object.keys(clean).length === 0) continue;
    out.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      overrides: clean,
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
      risk: obj['risk'] === 'medium' || obj['risk'] === 'high' ? obj['risk'] : 'low',
      classifications: [],
    });
  }
  return out;
}

export async function propose(
  snapshot: CampaignSnapshot,
  classifications: DecisionClassification[],
  ctx: ProposeContext,
): Promise<Patch[]> {
  const systemPrompt = readPrompt();
  const current = await readOverrides(ctx.overridesPath).catch(() => ({}));
  const userContent = buildUserMessage(snapshot, classifications, current);

  const body: ChatRequestBody = {
    model: ctx.model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  let raw = '';
  try {
    const { response } = await ctx.chain.handle(body, ctx.signal);
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    raw = json.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    ctx.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'propose: chain call failed');
    return [];
  }
  // The model may wrap JSON in ``` fences; strip them defensively.
  const fenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return parseProposeResponse(fenced);
}

function readPrompt(): string {
  try {
    return readFileSync(PROMPT_PATH, 'utf8');
  } catch {
    return 'You are the Campaign Director. Respond with {"patches":[]} when unsure.';
  }
}

function buildUserMessage(
  snapshot: CampaignSnapshot,
  classifications: DecisionClassification[],
  currentOverrides: Record<string, string>,
): string {
  const cls =
    classifications.map((c) => `- [${c.severity}] ${c.kind}: ${c.reason}`).join('\n') || '(none)';
  const ov = Object.keys(currentOverrides).length
    ? Object.entries(currentOverrides)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '(empty)';
  return [
    'Current overrides:',
    ov,
    '',
    'Recent classifications:',
    cls,
    '',
    `Tracker: submitted=${snapshot.tracker.submitted}/${snapshot.tracker.target}`,
    'Last tick status:',
    snapshot.tickStatus || '(unavailable)',
    '',
    'Propose zero or more patches as {"patches":[...]}.',
  ].join('\n');
}
