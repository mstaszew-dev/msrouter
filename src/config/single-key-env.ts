/**
 * Zod fields for every single-key OpenAI-compatible provider (moved out of
 * env.ts to respect the 250-line module budget). env.ts spreads these into
 * the root schema, so the parsed shape is unchanged.
 *
 * 2026-09-18 additions (free-tier providers, no payment method on any):
 *   UNOROUTER   - unorouter.com router, free tier 220+ models (rate-limited)
 *   GROQ        - console.groq.com, fast inference free tier
 *   SAMBANOVA   - cloud.sambanova.ai, retired: payment-walled (402)
 *   MISTRAL     - console.mistral.ai, La Plateforme experimental free tier
 *   CLOUDFLARE  - Workers AI: 10k free neurons/day; the OpenAI-compatible
 *                 base URL embeds the account id, hence CLOUDFLARE_ACCOUNT_ID.
 */
import { z } from 'zod';

/** Comma-separated model list: split, trimmed, empties dropped. */
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

// Concrete inferred type (NOT annotated as ZodRawShape, which would erase the
// specific keys when env.ts spreads this into the root schema).
export const singleKeyEnvFields = {
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ZAI_API_KEY: z.string().optional(),
  ZAI_BASE_URL: z.string().url().default('https://api.z.ai/api/coding/paas/v4'),
  // Coding-plan default (verified 200 on /api/coding/paas/v4, 2026-09-18).
  ZAI_MODEL: z.string().default('glm-5.3-flash'),
  // TokenRouter (tokenrouter.com): OpenAI-compatible aggregator. Single key,
  // free GLM tier. Key verified against api.tokenrouter.com 2026-08-30.
  TOKENROUTER_API_KEY: z.string().optional(),
  TOKENROUTER_BASE_URL: z.string().url().default('https://api.tokenrouter.com/v1'),
  TOKENROUTER_MODEL: z.string().default('z-ai/glm-5.3-free'),
  // OpenCode Go: single-key glm-5.3-flash provider on /zen/go/v1 (works
  // from any client, unlike the removed /zen/v1 pool; SESSION_ID feeds the
  // x-opencode-session header).
  OPENCODEGO_API_KEY: z.string().optional(),
  OPENCODEGO_BASE_URL: z.string().url().default('https://opencode.ai/zen/go/v1'),
  OPENCODEGO_MODEL: z.string().default('glm-5.3-flash'),
  OPENCODEGO_SESSION_ID: z.string().optional(),
  // OpenCode Zen (/zen/v1). Re-admitted 2026-10-06 for space-bunny-free ONLY:
  // the other 10 `-free` models still answer FreeTierError for non-OpenCode
  // clients (re-audited; the 2026-09-18 removal reason otherwise stands).
  OPENCODE_API_KEY: z.string().optional(),
  OPENCODE_BASE_URL: z.string().url().default('https://opencode.ai/zen/v1'),
  OPENCODE_MODEL: z.string().default('space-bunny-free'),
  OPENCODE_SESSION_ID: z.string().optional(),

  // --- Extra free-tier providers (2026-09-18). Model vars follow the
  // empty-slot convention: an EMPTY model var drops the provider's walk
  // entry even when its key is configured. ---
  UNOROUTER_API_KEY: z.string().optional(),
  UNOROUTER_BASE_URL: z.string().url().default('https://api.unorouter.com/v1'),
  // Verified free-tier id 2026-09-18 (no auto-router alias exists upstream).
  UNOROUTER_MODEL: z.string().default('glm-5.3-flash:free'),
  UNOROUTER_MODELS: csv.default(''),
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_MODELS: csv.default(''),
  SAMBANOVA_API_KEY: z.string().optional(),
  SAMBANOVA_BASE_URL: z.string().url().default('https://api.sambanova.ai/v1'),
  // 2026-09-18 audit: account-wide PAYMENT_METHOD_REQUIRED (balance_units 0)
  // on every model - the no-card free tier is gone. Default empty (retired).
  SAMBANOVA_MODEL: z.string().default(''),
  SAMBANOVA_MODELS: csv.default(''),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_BASE_URL: z.string().url().default('https://api.mistral.ai/v1'),
  MISTRAL_MODEL: z.string().default('mistral-small-latest'),
  MISTRAL_MODELS: csv.default(''),
  CLOUDFLARE_API_KEY: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_MODEL: z.string().default('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  CLOUDFLARE_MODELS: csv.default(''),

  // --- Cline (2026-10-08): api.cline.bot single-key aggregator. NOT an
  // OpenAI-path upstream: chat completions live at /api/v1/chat/completions,
  // so CLINE_BASE_URL ends in /api/v1 and the success envelope is unwrapped
  // (unwrapData). ONLY ":free"-suffixed model ids are usable without credits;
  // any other id fails insufficient_credits (verified live against a $-0.01
  // balance, including the requested xiaomi/mimo-v2.6-flash). ---
  CLINE_API_KEY: z.string().optional(),
  CLINE_BASE_URL: z.string().url().default('https://api.cline.bot/api/v1'),
  // Verified free-tier id 2026-10-08 (2/2 probes, no reasoning-field quirks).
  CLINE_MODEL: z.string().default('poolside/laguna-s-2.1:free'),
  CLINE_MODELS: csv.default(''),
} satisfies z.ZodRawShape;
