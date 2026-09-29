/**
 * Validated environment configuration. Every variable is parsed through a zod
 * schema so the process fails fast at boot on a missing/malformed value, and
 * downstream code gets typed, narrowed values instead of `process.env.FOO as
 * string` everywhere.
 *
 * The OpenRouter key pool is collected by scanning process.env for
 * `OPENROUTER_KEY\d+`, so adding keys is just adding env vars - no code change.
 */
import { z } from 'zod';

import { collectNumberedKeys } from './keys.js';
import { singleKeyEnvFields } from './single-key-env.js';

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

/** Boolean env flag: true when 'true' or '1' (case matters), else the default. */
const flag = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => s === 'true' || s === '1');

/**
 * Python campaign launcher: the Director's default spawn target (since
 * 2026-09-08, when hermes_agent/ was archived). Single source of truth for
 * the zod default and the loop.ts fallback.
 */
export const PYTHON_RUNNER = '/Users/mst/bin/job-search-agent';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  GATEWAY_TOKEN: z.string().default(''),

  // Single-key OpenAI-compatible providers (OPENAI/ZAI/TOKENROUTER/
  // OPENCODEGO + the 2026-09-18 extras: UNOROUTER/GROQ/SAMBANOVA/MISTRAL/
  // CLOUDFLARE) live in single-key-env.ts to respect the module budget.
  ...singleKeyEnvFields,

  // Local llama-server: OpenAI /v1/chat/completions. NOT deployed on this
  // machine (LOCAL_ENABLED never set; the laptop tailnet Ollama is the
  // active local tail) - kept as a pluggable slot.
  LOCAL_ENABLED: flag('false'),
  LOCAL_BASE_URL: z.string().url().default('http://127.0.0.1:11434/v1'),
  LOCAL_MODEL: z.string().default('qwen3.5:2b'),
  // Local prefills are slow (~220-370 tok/s), so local gets its own timeout
  // instead of UPSTREAM_TIMEOUT_MS (the agent's ceiling is TIMEOUT_SECONDS=2400).
  LOCAL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // LM Studio (Bionic) local: OpenAI /v1, no key. LMSTUDIO_MODEL is an
  // ALIAS: the provider discovers loaded models (GET {base}/models).
  // Parked since 2026-09-18 (LMSTUDIO_ENABLED=false in live env).
  LMSTUDIO_ENABLED: flag('false'),
  LMSTUDIO_BASE_URL: z.string().url().default('http://127.0.0.1:1235/v1'),
  LMSTUDIO_MODEL: z.string().default('qwen3.5-4b'),
  // Local prefills are slow (a 20k-token prompt takes minutes on the shared
  // single-slot llama-server), so LM Studio gets its own timeout (cf. LOCAL_TIMEOUT_MS).
  LMSTUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Laptop slot (tailnet travelmate Ollama, routed ABSOLUTE LAST): the model
  // id must be EXACTLY qwen35-2b-64k (MAX_LOADED_MODELS=1 server-side).
  LAPTOP_ENABLED: flag('false'),
  LAPTOP_BASE_URL: z
    .string()
    .url()
    .default('https://mstro-travelmate-p215-52.taila0a683.ts.net/v1'),
  LAPTOP_MODEL: z.string().default('qwen35-2b-64k'),
  LAPTOP_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

  // Slack (Director surface)
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL: z.string().optional(),
  SLACK_WEBHOOK: z.string().optional(),

  // OpenRouter default model when the client sends an alias (e.g. mst/free).
  // `openrouter/free` is OpenRouter's auto-router over free models.
  OPENROUTER_MODEL: z.string().default('openrouter/free'),
  // Additional OpenRouter models (comma-separated). Each model × each key
  // creates a routing entry, so the chain tries all combinations.
  // Empty default: retired one-off free models are never re-added by default.
  OPENROUTER_MODELS: csv.default(''),
  // The alias(es) that mean "walk every provider with its own default model".
  // Comma-separated; canonical ones are "mst/free" and "free".
  WALK_ALIAS: csv.default('mst/free,free'),
  FORCE_FREE: flag('true'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_TRANSIENT_RETRIES: z.coerce.number().int().min(0).default(2),
  TRANSIENT_BACKOFF_MS: z.coerce.number().int().positive().default(1_000),
  // 429 cooldown: a rate-limited entry is parked (skipped by walks) this long.
  RATE_LIMIT_COOLDOWN_MS: z.coerce.number().int().min(0).default(60_000),
  // Wall-clock budget for ONE alias walk (mst/free): once spent, remaining
  // remote entries (mid-entry retries too) are skipped so the walk fails
  // over to the local tail (slow-hanging remotes, 2026-09-13). 0 disables.
  // Client ceiling: 300 + 300 + laptop 1800 = 2400s (agent TIMEOUT_SECONDS).
  WALK_DEADLINE_MS: z.coerce.number().int().min(0).default(300_000),
  // Demote after N consecutive successes (local tail must not monopolize).
  SUCCESS_DEMOTE_LIMIT: z.coerce.number().int().positive().default(5),

  // Director agent (observe-only supervisor)
  // Minutes between Director observation cycles. -1 disables.
  DIRECTOR_INTERVAL_MINUTES: z.coerce.number().int().default(1),
  // Model the Director uses for proposal drafting. Empty -> WALK_ALIAS[0] at runtime.
  DIRECTOR_MODEL: z.string().default(''),
  // Campaign state the Director observes.
  DIRECTOR_CAMPAIGN_DIR: z.string().default('/Users/mst/Downloads/job-search/job-apply'),
  // Campaign agent workspace (where the launcher + campaign_agent/ live).
  DIRECTOR_OPENCLAW_WORKSPACE: z.string().default('/Users/mst/ZCodeProject/openclaw-job-search'),
  // Launcher wrapper the Director invokes to restart the worker: the python
  // campaign agent (hermes_agent/ was archived 2026-09-08).
  DIRECTOR_RUNNER: z.string().default(PYTHON_RUNNER),
  // stale-campaign fires after this many minutes without new tracker events
  // (raise when providers are slow: legit mid-tick workers must not die).
  STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(60),
  // When false the Director never spawns/kills/restarts the campaign worker
  // (observe-only; user starts the agent manually). Observation, Slack and
  // VPN rotation stay active. Defaults OFF since 2026-09-18 per the standing
  // campaign policy; spawning is opt-in.
  DIRECTOR_AUTOSTART: flag('false'),
  // The single patch target the Director edits on approval.
  DIRECTOR_OVERRIDES: z.string().default('~/.campaign-agent/director-overrides.env'),
  // Append-only ledger of every proposal + decision.
  DIRECTOR_LEDGER: z.string().default(''),
  // CDP health URL the Director polls after a restart.
  DIRECTOR_CDP_URL: z.string().url().default('http://127.0.0.1:9222'),
  // Director-owned SQLite RAG db (separate from OpenClaw's rag/index.db).
  DIRECTOR_RAG_DB: z.string().default(''),
  // Minutes between Proton VPN IP rotations. 0 or negative disables. Default 30.
  VPN_ROTATION_INTERVAL_MINUTES: z.coerce.number().int().default(30),

  // Kafka (Director event streaming). Disabled by default (observation
  // shows nothing consumes the topic; scripts/kafka.sh is dormant).
  KAFKA_ENABLED: flag('false'),
  KAFKA_HOME: z.string().default('~/kafka/kafka_2.13-3.7.0'),
  KAFKA_BOOTSTRAP: z.string().default('localhost:19092'),
  KAFKA_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  // Default allowlist EXCLUDES code-execution primitives (node, npm, find,
  // git) which an LLM-driven agent could turn into arbitrary execution
  // (node -e, npm install, find -exec, git clone hooks). Opt in only if you
  // trust the agent.
  TERMINAL_ALLOWLIST: csv.default('ls,cat,echo,pwd,head,tail,grep'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_REDACT: csv.default(''),
});

export type Env = z.infer<typeof schema>;

/** Resolved provider/pool config derived from the parsed env. */
export interface ResolvedConfig {
  env: Env;
  /** OpenRouter keys in stable numeric order (deduped, trimmed). */
  openrouterKeys: string[];
}

let cached: ResolvedConfig | undefined;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  const openrouterKeys = collectNumberedKeys(raw, 'OPENROUTER');

  // Production safety: at least one provider must be configured, or the
  // gateway has nothing to route to.
  const hasOpenRouter = openrouterKeys.length > 0;
  const hasOpenCodeGo = !!parsed.data.OPENCODEGO_API_KEY;
  // Extra free-tier providers count when key AND model are set (mirrors
  // extraRoutingEntries gating; unorouter ships an empty default model).
  const d = parsed.data;
  const hasExtra =
    (!!d.UNOROUTER_API_KEY && !!d.UNOROUTER_MODEL) ||
    (!!d.GROQ_API_KEY && !!d.GROQ_MODEL) ||
    (!!d.SAMBANOVA_API_KEY && !!d.SAMBANOVA_MODEL) ||
    (!!d.MISTRAL_API_KEY && !!d.MISTRAL_MODEL) ||
    (!!d.CLOUDFLARE_API_KEY && !!d.CLOUDFLARE_ACCOUNT_ID && !!d.CLOUDFLARE_MODEL);
  const hasAnyFallback =
    !!parsed.data.OPENAI_API_KEY ||
    !!parsed.data.ZAI_API_KEY ||
    !!parsed.data.TOKENROUTER_API_KEY ||
    hasOpenCodeGo ||
    hasExtra;
  if (parsed.data.NODE_ENV === 'production' && !hasOpenRouter && !hasAnyFallback) {
    throw new Error(
      'No provider configured: set at least one OPENROUTER_KEY* or OPENAI/ZAI/TOKENROUTER/OPENCODEGO key, or an extra provider key+model (UNOROUTER/GROQ/SAMBANOVA/MISTRAL/CLOUDFLARE)',
    );
  }
  cached = { env: parsed.data, openrouterKeys };
  return cached;
}

export function env(): Env {
  if (!cached) throw new Error('env() called before loadEnv()');
  return cached.env;
}

export function config(): ResolvedConfig {
  if (!cached) throw new Error('config() called before loadEnv()');
  return cached;
}

/** Idempotent: return cached config or parse process.env now (for tests/setup). */
export function initEnv(): ResolvedConfig {
  if (cached) return cached;
  return loadEnv();
}
