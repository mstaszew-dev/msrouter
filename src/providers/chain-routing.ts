/**
 * Routing-entry construction + direct: short-circuit parsing for the provider
 * chain. Extracted from chain.ts so chain.ts stays under the 250-line module
 * budget and so the routing-entry-building policy is testable in isolation.
 *
 * A RoutingEntry is one entry in the flat adaptive-rotation queue: which
 * provider, which model, which key slot. The order here is the env-declared
 * initial order (OpenRouter keys, then OpenAI, then ZAI, then OpenCode
 * triples). The chain wraps the result in a RotationQueue which reorders on
 * KEY_FAILURE.
 */

import { env } from '../config/env.js';

import type { Providers } from './instances.js';
import { withFree } from './openrouter.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';

/** A single flat routing entry: which provider, which model, which key slot. */
export interface RoutingEntry {
  /** Lookup key into `Providers`. */
  provider:
    | 'openrouter'
    | 'openai'
    | 'zai'
    | 'tokenrouter'
    | 'opencode'
    | 'opencodego'
    | 'local'
    | 'lmstudio'
    | 'laptop';
  /** Display label for servedBy / logs. */
  label: string;
  /** Model id to send upstream (alias substitution applied at handle time). */
  model: string;
  /** OpenRouter: logical key index. OpenCode: triple index. Single-key: 0. */
  attemptIndex: number;
}

/** Local-tail providers: the always-available fallbacks at the walk's end. */
export const LOCAL_TAIL: ReadonlySet<RoutingEntry['provider']> = new Set([
  'local',
  'lmstudio',
  'laptop',
]);

/**
 * True when the walk has exceeded its WALK_DEADLINE_MS budget and the entry
 * must not be attempted (or retried) further. Remote entries are skipped at
 * any attempt once the deadline passes. The local tail keeps its FIRST
 * attempt (the always-available fallback stays reachable), but `attempt > 0`
 * stops: a hanging local (3 x LOCAL*_TIMEOUT_MS) must not blow the caller's
 * budget either. Callers in pass()-style loops use the default attempt 0,
 * which for locals is always allowed (deadline exemption).
 */
export function isOverWalkDeadline(
  entry: RoutingEntry,
  startedAt: number,
  deadlineMs: number,
  attempt = 0,
): boolean {
  if (deadlineMs <= 0) return false;
  if (Date.now() - startedAt < deadlineMs) return false;
  if (LOCAL_TAIL.has(entry.provider)) return attempt > 0;
  return true;
}

/** Dispatch one attempt to the right provider with the right opts shape
 *  (openrouter: keyIndex; opencode: tripleIndex; others: model only). */
export async function dispatchProvider(
  providers: Providers,
  entry: RoutingEntry,
  model: string,
  body: ChatRequestBody,
  signal: AbortSignal,
): Promise<ProviderCallResult> {
  const p = providers[entry.provider];
  if (entry.provider === 'openrouter') {
    return p.attempt(body, signal, { model, keyIndex: entry.attemptIndex });
  }
  if (entry.provider === 'opencode') {
    return p.attempt(body, signal, { model, tripleIndex: entry.attemptIndex });
  }
  return p.attempt(body, signal, { model });
}

/** Count OpenCode triples whose model matches (for direct:opencode/<model>). */
export function dispatchProviderCount(providers: Providers, model: string): number {
  return providers.opencode.queueSnapshot().filter((t) => t.model === model).length;
}

/** Provider id union used by shortCircuit + runSingle. */
export type ChainProvider = RoutingEntry['provider'];

/**
 * Build the initial flat routing-entry list from env-declared order:
 *   OpenRouter keys -> OpenAI -> ZAI -> OpenCode triples (model-major,
 *   key-minor) -> local (when LOCAL_ENABLED) -> lmstudio (when LMSTUDIO_ENABLED).
 * Unavailable providers are skipped.
 *
 * Local providers (llama-server, LM Studio) come LAST on purpose: remote free
 * tiers are faster for the campaign's large contexts, so they serve when
 * healthy. Local remains the always-available fallback when every remote free
 * tier is flapping (the campaign agent's recurring outage). Demote-on-failure
 * still applies like any other entry.
 */
export function buildRoutingEntries(providers: Providers): RoutingEntry[] {
  const e = env();
  const list: RoutingEntry[] = [];
  const or = providers.openrouter;
  if (or.available) {
    // Build list of all OpenRouter models: primary + additional
    const orModels = [e.OPENROUTER_MODEL, ...e.OPENROUTER_MODELS];
    for (const model of orModels) {
      const orModel = withFree(model, e.FORCE_FREE);
      for (let i = 0; i < or.keyCount; i++) {
        list.push({
          provider: 'openrouter',
          label: `openrouter[key${i + 1}/${orModel}]`,
          model: orModel,
          attemptIndex: i,
        });
      }
    }
  }
  if (providers.openai.available) {
    list.push({ provider: 'openai', label: 'openai', model: e.OPENAI_MODEL, attemptIndex: 0 });
  }
  if (providers.zai.available) {
    list.push({ provider: 'zai', label: 'zai', model: e.ZAI_MODEL, attemptIndex: 0 });
  }
  if (providers.tokenrouter.available) {
    list.push({
      provider: 'tokenrouter',
      label: 'tokenrouter',
      model: e.TOKENROUTER_MODEL,
      attemptIndex: 0,
    });
  }
  const oc = providers.opencode;
  if (oc.available) {
    const snapshot = oc.queueSnapshot();
    for (let t = 0; t < snapshot.length; t++) {
      const triple = snapshot[t]!;
      // Include model in label for uniqueness (multiple models per key)
      list.push({
        provider: 'opencode',
        label: `opencode[key${triple.keyIdx + 1}/${triple.model}]`,
        model: triple.model,
        attemptIndex: t,
      });
    }
  }
  // OpenCode Go: single-key sibling of the OPENCODE pool (same vendor
  // family), routed after the OPENCODE triples.
  if (providers.opencodego.available) {
    list.push({
      provider: 'opencodego',
      label: 'opencodego',
      model: e.OPENCODEGO_MODEL,
      attemptIndex: 0,
    });
  }
  if (e.LOCAL_ENABLED) {
    list.push({ provider: 'local', label: 'local', model: e.LOCAL_MODEL, attemptIndex: 0 });
  }
  if (e.LMSTUDIO_ENABLED) {
    list.push({ provider: 'lmstudio', label: 'lmstudio', model: e.LMSTUDIO_MODEL, attemptIndex: 0 });
  }
  // Laptop (tailnet) qwen goes ABSOLUTE LAST: the 0.8B model is the weakest
  // in the chain, so it only serves when everything else is exhausted.
  if (e.LAPTOP_ENABLED) {
    list.push({ provider: 'laptop', label: 'laptop', model: e.LAPTOP_MODEL, attemptIndex: 0 });
  }
  return list;
}

/**
 * True when the model id is a configured per-provider default (e.g. the
 * TokenRouter z-ai/glm-5.3-free, ZAI glm-4.6). Such ids are advertised verbatim in
 * /v1/models and accepted by resolveModel, so the explicit-model path must not
 * FORCE_FREE-rewrite them into an id no upstream accepts ('z-ai/glm-5.3-free:free').
 */
export function isProviderDefaultModel(model: string): boolean {
  const e = env();
  return (
    model === e.OPENAI_MODEL ||
    model === e.ZAI_MODEL ||
    model === e.TOKENROUTER_MODEL ||
    model === e.OPENCODE_MODEL ||
    model === e.OPENCODEGO_MODEL ||
    model === e.LOCAL_MODEL ||
    model === e.LMSTUDIO_MODEL ||
    model === e.LAPTOP_MODEL
  );
}

/** Detect direct:<provider>/<model> prefix to pin a single provider. */
export function shortCircuit(model: string): { provider: ChainProvider; model: string } | null {
  const m = model.toLowerCase();
  if (!m.startsWith('direct:')) return null;
  const rest = model.slice('direct:'.length);
  const restLower = rest.toLowerCase();
  if (restLower.startsWith('openai/')) {
    return { provider: 'openai', model: rest.slice('openai/'.length) };
  }
  if (restLower.startsWith('opencode/')) {
    return { provider: 'opencode', model: rest.slice('opencode/'.length).toLowerCase() };
  }
  if (restLower.startsWith('opencodego/')) {
    return { provider: 'opencodego', model: rest.slice('opencodego/'.length).toLowerCase() };
  }
  if (restLower.startsWith('zai/')) {
    // Strip the prefix: the upstream must receive the bare model id
    // ("glm-5.3-flash"), not "zai/glm-5.3-flash" (Z.ai 400s on it).
    return { provider: 'zai', model: rest.slice('zai/'.length) };
  }
  if (restLower.startsWith('glm-')) {
    return { provider: 'zai', model: rest };
  }
  if (restLower.startsWith('tokenrouter/')) {
    return { provider: 'tokenrouter', model: rest.slice('tokenrouter/'.length) };
  }
  if (restLower.startsWith('openrouter/')) {
    const model = rest.slice('openrouter/'.length);
    return { provider: 'openrouter', model: withFree(model, env().FORCE_FREE) };
  }
  if (restLower.startsWith('local/')) {
    return { provider: 'local', model: rest.slice('local/'.length) };
  }
  if (restLower.startsWith('lmstudio/')) {
    return { provider: 'lmstudio', model: rest.slice('lmstudio/'.length) };
  }
  if (restLower.startsWith('laptop/')) {
    return { provider: 'laptop', model: rest.slice('laptop/'.length) };
  }
  return null;
}
