/**
 * LM Studio (Bionic) local provider.
 *
 * LM Studio exposes an OpenAI-compatible /v1/chat/completions endpoint (default
 * http://127.0.0.1:1234/v1) with NO API key requirement - it accepts and
 * ignores any key. This is a thin specialization of SingleKeyProvider: we pass
 * a placeholder key so `available` and the shared postChatCompletion path work
 * unchanged; the server never validates it.
 *
 * Model discovery: LM Studio identifies loaded GGUFs by their FULL local path
 * (e.g. /Users/.../Qwen3.5-9B-Q4_K_M.gguf), and the operator can swap which
 * model is loaded (9B <-> 4B) at any time. A single env-pinned model id would
 * 404 on every swap, so attempt() queries GET {base}/models (cached with a
 * short TTL) and resolves the requested model against whatever is actually
 * loaded. If discovery fails (server down/restarting) the requested model is
 * sent as-is and the normal fetch error path classifies the outcome.
 */

import type { Logger } from 'pino';

import { postChatCompletion } from './fetch.js';
import { SingleKeyProvider } from './single-key.js';
import type { AttemptOptions, ChatRequestBody, ProviderCallResult } from './types.js';

export interface LmStudioConfig {
  baseUrl: string;
  defaultModel: string;
}

/** LM Studio accepts any bearer token; use a fixed placeholder. */
const PLACEHOLDER_KEY = 'lm-studio';

/** Discovery requests are cheap and local; fail fast rather than stall a chat. */
const DISCOVERY_TIMEOUT_MS = 2_000;
/** Cache the loaded-model list briefly so each attempt doesn't re-GET /models. */
const DISCOVERY_TTL_MS = 30_000;

/**
 * Normalize a model id or path to a comparable token: lowercase basename with
 * the .gguf extension and quantization suffix (q4_k_m, q8_0, bf16, ...)
 * stripped, non-alphanumerics removed. "qwen3.5-9b" and
 * "/path/Qwen3.5-9B-Q4_K_M.gguf" both normalize to "qwen359b".
 */
export function normalizeModelToken(id: string): string {
  const base = id.split('/').pop() ?? id;
  const noExt = base.replace(/\.gguf$/i, '');
  const noQuant = noExt.replace(/[-_](q\d\w*|iq\d\w*|bf16|fp16|f16|f32)$/i, '');
  return noQuant.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Pick the outbound model id from the models LM Studio reports as loaded.
 * - exact id match wins (direct:<full path> requests);
 * - else the loaded model whose normalized basename starts with the normalized
 *   request (short alias "qwen3.5-9b" -> ".../Qwen3.5-9B-Q4_K_M.gguf");
 * - else the first loaded model, so a stale alias after a model swap still
 *   routes to whatever local model IS available;
 * - undefined when nothing is loaded (caller decides how to fail).
 */
export function resolveLmStudioModel(
  loadedIds: readonly string[],
  requested: string | undefined,
): string | undefined {
  if (loadedIds.length === 0) return undefined;
  if (requested && loadedIds.includes(requested)) return requested;
  if (requested) {
    const tok = normalizeModelToken(requested);
    if (tok.length > 0) {
      const fuzzy = loadedIds.find((id) => {
        const loadedTok = normalizeModelToken(id);
        return loadedTok.length > 0 && loadedTok.startsWith(tok);
      });
      if (fuzzy) return fuzzy;
    }
  }
  return loadedIds[0];
}

/** Extract ids from the { object: "list", data: [{ id }] } shape of /v1/models. */
function extractModelIds(json: unknown): string[] | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  return data
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

export class LmStudioProvider extends SingleKeyProvider {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  #discovery?: { ids: string[]; at: number };

  constructor(cfg: LmStudioConfig, timeoutMs: number, log: Logger) {
    super(
      {
        id: 'lmstudio',
        baseUrl: cfg.baseUrl,
        apiKey: PLACEHOLDER_KEY,
        defaultModel: cfg.defaultModel,
      },
      timeoutMs,
      log,
    );
    this.#baseUrl = cfg.baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Discover which models LM Studio currently has loaded. Returns the id list,
   * or undefined when the server can't be reached / answers unexpectedly
   * (caller falls back to the requested model). Failures are not cached so the
   * next attempt retries discovery immediately after a server restart.
   */
  async listLoadedModels(): Promise<string[] | undefined> {
    const now = Date.now();
    if (this.#discovery && now - this.#discovery.at < DISCOVERY_TTL_MS) {
      return this.#discovery.ids;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      const url = `${this.#baseUrl.replace(/\/+$/, '')}/models`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${PLACEHOLDER_KEY}` },
        signal: ac.signal,
      });
      if (!res.ok) return undefined;
      const ids = extractModelIds(await res.json().catch(() => undefined));
      if (!ids) return undefined;
      this.#discovery = { ids, at: now };
      return ids;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  override async attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: AttemptOptions,
  ): Promise<ProviderCallResult> {
    const loaded = await this.listLoadedModels();
    if (loaded !== undefined && loaded.length === 0) {
      return {
        kind: 'KEY_FAILURE',
        status: 0,
        message: 'lmstudio: server up but no models loaded',
      };
    }
    const resolved = loaded ? (resolveLmStudioModel(loaded, opts.model) ?? opts.model) : opts.model;
    return postChatCompletion(
      { ...body, model: resolved },
      {
        baseUrl: this.#baseUrl,
        authorization: `Bearer ${PLACEHOLDER_KEY}`,
        signal,
        timeoutMs: this.#timeoutMs,
        keyTag: 'lmstudio',
      },
    );
  }
}
