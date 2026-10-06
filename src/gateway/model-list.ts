/**
 * Client-facing model resolution + advertisement (moved out of handlers.ts
 * 2026-09-18 to respect the 250-line module budget). Shared by the REST
 * /v1/models handler and the GraphQL `models` query.
 */

import { env } from '../config/env.js';
import { extraDefaultModels } from '../providers/extras.js';

/**
 * Resolve the requested model. A known model (a walk alias, a `direct:` prefix,
 * or one of the configured per-provider defaults) is passed through unchanged.
 * An UNKNOWN model is rewritten to the first walk alias (e.g. `mst/free`) so
 * the request flows through the full pool + fallback instead of failing or
 * sending a bogus id upstream. This makes the gateway forgiving for clients
 * that send a placeholder or generic model id.
 */
export function resolveModel(requested: string): string {
  const cfg = env();
  if (cfg.WALK_ALIAS.includes(requested)) return requested;
  if (requested.toLowerCase().startsWith('direct:')) return requested;
  const known = new Set([
    cfg.OPENROUTER_MODEL,
    cfg.OPENAI_MODEL,
    cfg.ZAI_MODEL,
    cfg.TOKENROUTER_MODEL,
    cfg.OPENCODEGO_MODEL,
    cfg.LOCAL_MODEL,
    cfg.LMSTUDIO_MODEL,
    cfg.LAPTOP_MODEL,
    // Configured extra free-tier defaults (groq/..., sambanova Meta/...).
    ...extraDefaultModels().map((x) => x.model),
  ]);
  // OpenCode Zen single-model slot (space-bunny-free). Guarded on non-empty so
  // an emptied (retired) slot still falls through to the alias walk.
  if (cfg.OPENCODE_MODEL) known.add(cfg.OPENCODE_MODEL);
  if (known.has(requested)) return requested;
  // Unknown: default to the alias walk.
  return cfg.WALK_ALIAS[0] ?? 'mst/free';
}

/** The gateway's virtual models (OpenAI/OpenRouter-compatible shape).
 *  Shared by GET /v1/models and the GraphQL `models` query. */
export function buildModelList(): Array<{ id: string; object: string; owned_by: string }> {
  const cfg = env();
  const data: Array<{ id: string; object: string; owned_by: string }> = [
    ...cfg.WALK_ALIAS.map((alias) => ({ id: alias, object: 'model', owned_by: 'msrouter' })),
    { id: cfg.OPENROUTER_MODEL, object: 'model', owned_by: 'openrouter' },
    ...cfg.OPENROUTER_MODELS.map((model) => ({ id: model, object: 'model', owned_by: 'openrouter' })),
  ];
  if (cfg.OPENAI_API_KEY) data.push({ id: cfg.OPENAI_MODEL, object: 'model', owned_by: 'openai' });
  if (cfg.ZAI_API_KEY) data.push({ id: cfg.ZAI_MODEL, object: 'model', owned_by: 'zai' });
  if (cfg.TOKENROUTER_API_KEY) {
    data.push({ id: cfg.TOKENROUTER_MODEL, object: 'model', owned_by: 'tokenrouter' });
  }
  if (cfg.OPENCODEGO_API_KEY) {
    data.push({ id: cfg.OPENCODEGO_MODEL, object: 'model', owned_by: 'opencodego' });
  }
  // OpenCode Zen (/zen/v1): one model only, and only when the key is present,
  // matching the empty-slot convention used by the extra free-tier providers.
  if (cfg.OPENCODE_API_KEY && cfg.OPENCODE_MODEL) {
    data.push({ id: cfg.OPENCODE_MODEL, object: 'model', owned_by: 'opencode' });
  }
  for (const x of extraDefaultModels()) {
    data.push({ id: x.model, object: 'model', owned_by: x.provider });
  }
  if (cfg.LOCAL_ENABLED) data.push({ id: cfg.LOCAL_MODEL, object: 'model', owned_by: 'local' });
  if (cfg.LMSTUDIO_ENABLED) data.push({ id: cfg.LMSTUDIO_MODEL, object: 'model', owned_by: 'lmstudio' });
  if (cfg.LAPTOP_ENABLED) data.push({ id: cfg.LAPTOP_MODEL, object: 'model', owned_by: 'laptop' });
  return data;
}
