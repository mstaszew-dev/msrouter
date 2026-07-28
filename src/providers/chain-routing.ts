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

/** A single flat routing entry: which provider, which model, which key slot. */
export interface RoutingEntry {
  /** Lookup key into `Providers`. */
  provider: 'openrouter' | 'openai' | 'zai' | 'opencode';
  /** Display label for servedBy / logs. */
  label: string;
  /** Model id to send upstream (alias substitution applied at handle time). */
  model: string;
  /** OpenRouter: logical key index. OpenCode: triple index. Single-key: 0. */
  attemptIndex: number;
}

/** Provider id union used by shortCircuit + runSingle. */
export type ChainProvider = RoutingEntry['provider'];

/**
 * Build the initial flat routing-entry list from env-declared order:
 *   OpenRouter keys -> OpenAI -> ZAI -> OpenCode triples (model-major, key-minor).
 * Unavailable providers are skipped.
 */
export function buildRoutingEntries(providers: Providers): RoutingEntry[] {
  const e = env();
  const list: RoutingEntry[] = [];
  const or = providers.openrouter;
  if (or.available) {
    const orModel = withFree(e.OPENROUTER_MODEL, e.FORCE_FREE);
    for (let i = 0; i < or.keyCount; i++) {
      list.push({
        provider: 'openrouter',
        label: `openrouter[key${i + 1}/${orModel}]`,
        model: orModel,
        attemptIndex: i,
      });
    }
  }
  if (providers.openai.available) {
    list.push({ provider: 'openai', label: 'openai', model: e.OPENAI_MODEL, attemptIndex: 0 });
  }
  if (providers.zai.available) {
    list.push({ provider: 'zai', label: 'zai', model: e.ZAI_MODEL, attemptIndex: 0 });
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
  return list;
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
  if (restLower.startsWith('zai/') || restLower.startsWith('glm-')) {
    return { provider: 'zai', model: rest };
  }
  if (restLower.startsWith('openrouter/')) {
    return { provider: 'openrouter', model: rest.slice('openrouter/'.length) };
  }
  return null;
}
