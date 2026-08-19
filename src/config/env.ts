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

const csv = z
  .string()
  .default('')
  .transform((s) =>
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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  GATEWAY_TOKEN: z.string().default(''),

  // Fallback providers
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ZAI_API_KEY: z.string().optional(),
  ZAI_BASE_URL: z.string().url().default('https://api.z.ai/api/paas/v4'),
  ZAI_MODEL: z.string().default('glm-4.6'),

  // Local llama-server: OpenAI /v1/chat/completions on a patched 128K GGUF.
  LOCAL_ENABLED: flag('false'),
  LOCAL_BASE_URL: z.string().url().default('http://127.0.0.1:11434/v1'),
  LOCAL_MODEL: z.string().default('qwen3.5:2b'),
  // Local prefills are slow (~220-370 tok/s), so local gets its own timeout
  // instead of UPSTREAM_TIMEOUT_MS (matches the campaign agent's 300s cap).
  LOCAL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // LM Studio (Bionic) local: OpenAI /v1/chat/completions, no API key.
  // LMSTUDIO_MODEL is a preferred ALIAS: the provider discovers the models
  // actually loaded (GET {base}/models) and falls back to whatever is up.
  LMSTUDIO_ENABLED: flag('false'),
  LMSTUDIO_BASE_URL: z.string().url().default('http://127.0.0.1:1234/v1'),
  LMSTUDIO_MODEL: z.string().default('qwen3.5-4b'),
  // Local prefills are slow (a 20k-token prompt takes minutes on the shared
  // single-slot llama-server), so LM Studio gets its own timeout (cf. LOCAL_TIMEOUT_MS).
  LMSTUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  OPENCODE_API_KEY: z.string().optional(),
  OPENCODE_BASE_URL: z.string().url().default('https://opencode.ai/zen/v1'),
  OPENCODE_MODEL: z.string().default('big-pickle'),
  // OpenCode Zen free models (all share OPENCODE_API_KEY / OPENCODE_BASE_URL)
  OPENCODE_NEMOTRON_MODEL: z.string().default('nemotron-3-ultra-free'),
  OPENCODE_DEEPSEEK_FLASH_MODEL: z.string().default('deepseek-v4-flash-free'),
  OPENCODE_MIMO_MODEL: z.string().default('mimo-v2.5-free'),
  OPENCODE_NORTH_MINI_CODE_MODEL: z.string().default('north-mini-code-free'),
  OPENCODE_LAGUNA_MODEL: z.string().default('laguna-s-2.1-free'),
  OPENCODE_LING_MODEL: z.string().default('ling-3.0-flash-free'),
  // Exact model IDs verified against the OpenCode Zen catalog
  // (GET /zen/v1/models): qwen3.6-plus and minimax-m3 have NO "-free" variant
  // (only some models do). The old "-free" suffixes returned 401 on every key.
  OPENCODE_QWEN_MODEL: z.string().default('qwen3.6-plus'),
  OPENCODE_MINIMAX_MODEL: z.string().default('minimax-m3'),

  // Slack (Director surface)
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL: z.string().optional(),
  SLACK_WEBHOOK: z.string().optional(),

  // OpenRouter default model when the client sends an alias (e.g. mst/free).
  // `openrouter/free` is OpenRouter's auto-router over free models.
  OPENROUTER_MODEL: z.string().default('openrouter/free'),
  // The alias(es) that mean "walk every provider with its own default model".
  // Comma-separated; canonical ones are "mst/free" and "free".
  WALK_ALIAS: csv.default('mst/free,free'),

  FORCE_FREE: flag('true'),

  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_TRANSIENT_RETRIES: z.coerce.number().int().min(0).default(2),
  TRANSIENT_BACKOFF_MS: z.coerce.number().int().positive().default(1_000),

  // Agent / scheduler
  SCHEDULE_INTERVAL_MINUTES: z.coerce.number().int().default(-1),
  AGENT_MODEL: z.string().optional(),
  AGENT_PROMPT: z.string().default(''),
  AGENT_GOAL: z.string().default(''),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(20),
  AGENT_LLM_JUDGE: flag('false'),

  // Director agent (separate worker: `npm run director-worker`)
  // Minutes between Director observation cycles. -1 disables.
  DIRECTOR_INTERVAL_MINUTES: z.coerce.number().int().default(1),
  // Model the Director uses for proposal drafting. Empty -> WALK_ALIAS[0] at runtime.
  DIRECTOR_MODEL: z.string().default(''),
  // Campaign state the Director observes.
  DIRECTOR_CAMPAIGN_DIR: z.string().default('/Users/mst/Downloads/job-search/job-apply'),
  // Campaign agent workspace (where the launcher + campaign_agent/ live).
  DIRECTOR_OPENCLAW_WORKSPACE: z.string().default('/Users/mst/ZCodeProject/openclaw-job-search'),
  // Launcher wrapper the Director invokes to restart the worker.
  DIRECTOR_RUNNER: z.string().default('job-search-agent'),
  // Pidfile the launcher writes; Director reads/kills via this.
  DIRECTOR_PIDFILE: z.string().default('~/.campaign-agent/job-search-agent.pid'),
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

  // Kafka (Director event streaming). Disabled by default.
  KAFKA_ENABLED: flag('true'),
  KAFKA_HOME: z.string().default('~/kafka/kafka_2.13-3.7.0'),
  KAFKA_BOOTSTRAP: z.string().default('localhost:19092'),
  KAFKA_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  CDP_URL: z.string().url().default('http://127.0.0.1:9222'),
  // Default allowlist EXCLUDES code-execution primitives (node, npm, find, git)
  // which an LLM-driven agent could turn into arbitrary code execution
  // (node -e, npm install, find -exec, git clone hooks). Add them only if you
  // explicitly opt in and trust the agent.
  TERMINAL_ALLOWLIST: csv.default('ls,cat,echo,pwd,head,tail,grep'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_REDACT: csv,
});

export type Env = z.infer<typeof schema>;

/** Resolved provider/pool config derived from the parsed env. */
export interface ResolvedConfig {
  env: Env;
  /** OpenRouter keys in stable numeric order (deduped, trimmed). */
  openrouterKeys: string[];
  /** OpenCode Zen keys in stable numeric order (deduped, trimmed). */
  opencodeKeys: string[];
}

let cached: ResolvedConfig | undefined;

/**
 * Collect numbered OPENROUTER_KEY1..N from the raw env. Stable ascending order
 * by the numeric suffix; duplicates dropped. Also accepts a single
 * OPENROUTER_API_KEY appended last (parity with the OpenRouter SDK).
 */
function collectOpenRouterKeys(raw: Record<string, string | undefined>): string[] {
  const numbered: Array<{ n: number; key: string }> = [];
  for (const [k, v] of Object.entries(raw)) {
    const m = /^OPENROUTER_KEY(\d+)$/i.exec(k);
    if (m && v && v.trim()) {
      numbered.push({ n: Number(m[1]), key: v.trim() });
    }
  }
  numbered.sort((a, b) => a.n - b.n);
  // Dedupe while preserving first-seen order (so identical keys collapse).
  const keys: string[] = [];
  for (const x of numbered) {
    if (!keys.includes(x.key)) keys.push(x.key);
  }
  const single = raw['OPENROUTER_API_KEY'];
  if (single && single.trim() && !keys.includes(single.trim())) {
    keys.push(single.trim());
  }
  return keys;
}

/**
 * Collect numbered OPENCODE_KEY1..N from the raw env. Stable ascending order by
 * the numeric suffix; duplicates dropped. Also accepts a single
 * OPENCODE_API_KEY appended last (legacy form, parity with
 * collectOpenRouterKeys). Blank/whitespace values are ignored.
 */
function collectOpenCodeKeys(raw: Record<string, string | undefined>): string[] {
  const numbered: Array<{ n: number; key: string }> = [];
  for (const [k, v] of Object.entries(raw)) {
    const m = /^OPENCODE_KEY(\d+)$/i.exec(k);
    if (m && v && v.trim()) {
      numbered.push({ n: Number(m[1]), key: v.trim() });
    }
  }
  numbered.sort((a, b) => a.n - b.n);
  const keys: string[] = [];
  for (const x of numbered) {
    if (!keys.includes(x.key)) keys.push(x.key);
  }
  const single = raw['OPENCODE_API_KEY'];
  if (single && single.trim() && !keys.includes(single.trim())) {
    keys.push(single.trim());
  }
  return keys;
}

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
  const openrouterKeys = collectOpenRouterKeys(raw);
  const opencodeKeys = collectOpenCodeKeys(raw);

  // Production safety: at least one provider must be configured, or the
  // gateway has nothing to route to.
  const hasOpenRouter = openrouterKeys.length > 0;
  const hasOpenCode = opencodeKeys.length > 0;
  const hasAnyFallback = !!parsed.data.OPENAI_API_KEY || !!parsed.data.ZAI_API_KEY || hasOpenCode;
  if (parsed.data.NODE_ENV === 'production' && !hasOpenRouter && !hasAnyFallback) {
    throw new Error(
      'No provider configured: set at least one OPENROUTER_KEY* or OPENAI/ZAI/OPENCODE API key',
    );
  }

  cached = { env: parsed.data, openrouterKeys, opencodeKeys };
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
