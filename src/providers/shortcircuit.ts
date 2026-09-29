/**
 * direct:<provider>/<model> short-circuit parsing (moved out of
 * chain-routing.ts 2026-09-18 to respect the 250-line module budget).
 * Case rules: provider prefix is matched case-insensitively; the model id
 * keeps the caller's case (SambaNova ships mixed-case 'Meta/Llama-...'),
 * except opencodego which is lowercased upstream by contract.
 */

import { env } from '../config/env.js';

import type { ChainProvider } from './chain-routing.js';
import { EXTRA_PROVIDER_ORDER } from './extras.js';
import { withFree } from './openrouter.js';

/** Detect direct:<provider>/<model> prefix to pin a single provider. */
export function shortCircuit(model: string): { provider: ChainProvider; model: string } | null {
  const m = model.toLowerCase();
  if (!m.startsWith('direct:')) return null;
  const rest = model.slice('direct:'.length);
  const restLower = rest.toLowerCase();
  if (restLower.startsWith('openai/')) {
    return { provider: 'openai', model: rest.slice('openai/'.length) };
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
  // Extras (unorouter/groq/sambanova/mistral/cloudflare): case-sensitive
  // model ids preserved (SambaNova ships mixed-case 'Meta/Llama-...').
  for (const id of EXTRA_PROVIDER_ORDER) {
    if (restLower.startsWith(`${id}/`)) {
      return { provider: id, model: rest.slice(id.length + 1) };
    }
  }
  return null;
}
