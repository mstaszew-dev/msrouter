/**
 * Extra free-tier single-key providers (2026-09-18): UnoRouter, Groq,
 * SambaNova, Mistral, Cloudflare Workers AI; Cline joined 2026-10-08.
 * All speak OpenAI-compatible chat completions, so each is a
 * SingleKeyProvider specialization. GitHub Models was evaluated and dropped:
 * its inference endpoint was retired 2026-07-30 (every path now serves a
 * plain-text stub).
 *
 * Gating: a provider joins the walk only when its key is set AND its model
 * env var is non-empty AND (cloudflare) CLOUDFLARE_ACCOUNT_ID is present.
 */

import type { Logger } from 'pino';

import { env } from '../config/env.js';

import type { RoutingEntry } from './chain-routing.js';
import { SingleKeyProvider } from './single-key.js';

/** Walk order: router-style first, then direct free tiers, cloudflare last. */
export const EXTRA_PROVIDER_ORDER = [
  'unorouter',
  'groq',
  'sambanova',
  'mistral',
  'cline',
  'cloudflare',
] as const;

export type ExtraProviderId = (typeof EXTRA_PROVIDER_ORDER)[number];

export type Extras = Record<ExtraProviderId, SingleKeyProvider>;

const CLOUDFLARE_BASE = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;

export function isExtraProvider(id: string): id is ExtraProviderId {
  return (EXTRA_PROVIDER_ORDER as readonly string[]).includes(id);
}

/** Build all six; each is `available` iff its key is set. */
export function buildExtras(log: Logger): Extras {
  const e = env();
  const t = e.UPSTREAM_TIMEOUT_MS;
  return {
    unorouter: new SingleKeyProvider(
      {
        id: 'unorouter',
        baseUrl: e.UNOROUTER_BASE_URL,
        apiKey: e.UNOROUTER_API_KEY,
        defaultModel: e.UNOROUTER_MODEL,
      },
      t,
      log,
    ),
    groq: new SingleKeyProvider(
      { id: 'groq', baseUrl: e.GROQ_BASE_URL, apiKey: e.GROQ_API_KEY, defaultModel: e.GROQ_MODEL },
      t,
      log,
    ),
    sambanova: new SingleKeyProvider(
      {
        id: 'sambanova',
        baseUrl: e.SAMBANOVA_BASE_URL,
        apiKey: e.SAMBANOVA_API_KEY,
        defaultModel: e.SAMBANOVA_MODEL,
      },
      t,
      log,
    ),
    mistral: new SingleKeyProvider(
      {
        id: 'mistral',
        baseUrl: e.MISTRAL_BASE_URL,
        apiKey: e.MISTRAL_API_KEY,
        defaultModel: e.MISTRAL_MODEL,
      },
      t,
      log,
    ),
    cline: new SingleKeyProvider(
      {
        id: 'cline',
        baseUrl: e.CLINE_BASE_URL,
        apiKey: e.CLINE_API_KEY,
        defaultModel: e.CLINE_MODEL,
        // api.cline.bot/api/v1 wraps non-streaming successes in {"data": ...};
        // without the unwrap clients would receive the envelope verbatim.
        unwrapData: true,
      },
      t,
      log,
    ),
    cloudflare: new SingleKeyProvider(
      {
        id: 'cloudflare',
        // Placeholder when CLOUDFLARE_ACCOUNT_ID is unset: direct:cloudflare/
        // pins then surface an upstream 404 (the entry gate keeps walks safe).
        baseUrl: e.CLOUDFLARE_ACCOUNT_ID
          ? CLOUDFLARE_BASE(e.CLOUDFLARE_ACCOUNT_ID)
          : 'https://api.cloudflare.com/invalid',
        apiKey: e.CLOUDFLARE_API_KEY,
        defaultModel: e.CLOUDFLARE_MODEL,
      },
      t,
      log,
    ),
  };
}

/** Configured extras' walk entries, in EXTRA_PROVIDER_ORDER (env-only).
 *  Each provider contributes its primary model plus every <PROVIDER>_MODELS
 *  CSV entry (deduped against the primary); an empty primary retires the
 *  whole provider, CSV included. */
export function extraRoutingEntries(): RoutingEntry[] {
  const e = env();
  const list: RoutingEntry[] = [];
  const set = (v?: string): string => (v ?? '').trim();
  // The PRIMARY entry keeps the bare provider label (servedBy.provider is
  // populated from it); CSV additions carry the model for uniqueness.
  const add = (provider: ExtraProviderId, primary: string, more: string[]): void => {
    const uniq = [...new Set(more)].filter((m) => m !== primary);
    const models = [primary, ...uniq];
    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      list.push({
        provider,
        label: i === 0 ? provider : `${provider}/${model}`,
        model,
        attemptIndex: 0,
      });
    }
  };
  if (e.UNOROUTER_API_KEY && set(e.UNOROUTER_MODEL)) {
    add('unorouter', set(e.UNOROUTER_MODEL), e.UNOROUTER_MODELS);
  }
  if (e.GROQ_API_KEY && set(e.GROQ_MODEL)) add('groq', set(e.GROQ_MODEL), e.GROQ_MODELS);
  if (e.SAMBANOVA_API_KEY && set(e.SAMBANOVA_MODEL)) {
    add('sambanova', set(e.SAMBANOVA_MODEL), e.SAMBANOVA_MODELS);
  }
  if (e.MISTRAL_API_KEY && set(e.MISTRAL_MODEL)) {
    add('mistral', set(e.MISTRAL_MODEL), e.MISTRAL_MODELS);
  }
  if (e.CLINE_API_KEY && set(e.CLINE_MODEL)) {
    add('cline', set(e.CLINE_MODEL), e.CLINE_MODELS);
  }
  if (e.CLOUDFLARE_API_KEY && e.CLOUDFLARE_ACCOUNT_ID && set(e.CLOUDFLARE_MODEL)) {
    add('cloudflare', set(e.CLOUDFLARE_MODEL), e.CLOUDFLARE_MODELS);
  }
  return list;
}

/** Configured extras' (provider, default model) pairs: /v1/models + known set. */
export function extraDefaultModels(): Array<{ provider: ExtraProviderId; model: string }> {
  return extraRoutingEntries().map((entry) => ({
    provider: entry.provider as ExtraProviderId,
    model: entry.model,
  }));
}
