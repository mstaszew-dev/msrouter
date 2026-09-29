/**
 * Client-facing model resolution + advertisement (moved out of handlers.ts
 * 2026-09-18 to respect the 250-line module budget). Shared by the REST
 * /v1/models handler and the GraphQL `models` query.
 */

import { config, env } from '../config/env.js';
import { extraDefaultModels } from '../providers/extras.js';
import { opencodePoolModels } from '../providers/instances.js';

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
    cfg.OPENCODE_MODEL,
    cfg.OPENCODEGO_MODEL,
    cfg.LOCAL_MODEL,
    cfg.LMSTUDIO_MODEL,
    cfg.LAPTOP_MODEL,
    // Live OpenCode pool slots must pass through verbatim, not alias-rewrite.
    ...opencodePoolModels(cfg),
    // Configured extra free-tier defaults (groq/..., sambanova Meta/...).
    ...extraDefaultModels().map((x) => x.model),
  ]);
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
  for (const x of extraDefaultModels()) {
    data.push({ id: x.model, object: 'model', owned_by: x.provider });
  }
  if (cfg.LOCAL_ENABLED) data.push({ id: cfg.LOCAL_MODEL, object: 'model', owned_by: 'local' });
  if (cfg.LMSTUDIO_ENABLED) data.push({ id: cfg.LMSTUDIO_MODEL, object: 'model', owned_by: 'lmstudio' });
  if (cfg.LAPTOP_ENABLED) data.push({ id: cfg.LAPTOP_MODEL, object: 'model', owned_by: 'laptop' });
  if (config().opencodeKeys.length > 0) {
    // Mirror the pool filter (instances.ts): an emptied OPENCODE_*_MODEL slot
    // is gone-for-gateway and must not be advertised as an empty id.
    const ocModels: ReadonlyArray<readonly [string, string]> = [
      [cfg.OPENCODE_MODEL, 'opencode-bigpickle'],
      [cfg.OPENCODE_NEMOTRON_MODEL, 'opencode-nemotron'],
      [cfg.OPENCODE_DEEPSEEK_FLASH_MODEL, 'opencode-deepseek-flash'],
      [cfg.OPENCODE_MIMO_MODEL, 'opencode-mimo'],
      [cfg.OPENCODE_LAGUNA_MODEL, 'opencode-muse-spark-1.3'],
      [cfg.OPENCODE_LING_MODEL, 'opencode-ling'],
      [cfg.OPENCODE_QWEN_MODEL, 'opencode-muse-spark'],
      [cfg.OPENCODE_MINIMAX_MODEL, 'opencode-nemotron-lightning'],
    ];
    for (const [id, owner] of ocModels) {
      if (id.trim()) data.push({ id, object: 'model', owned_by: owner });
    }
  }
  return data;
}
