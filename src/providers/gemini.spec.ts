/**
 * Google Gemini free-tier slot (added 2026-10-11).
 *
 * Gemini exposes an OpenAI-compatible surface at
 * https://generativelanguage.googleapis.com/v1beta/openai/ with plain
 * `Authorization: Bearer`, so it is a bare SingleKeyProvider - no envelope
 * unwrapping (unlike cline) and no base-URL rewriting.
 *
 * Verified live on the Free tier (project gen-lang-client-0862651064, no
 * payment method on file, so spend is structurally impossible):
 *   gemini-3.8-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-2.5-flash,
 *   gemini-2.5-flash-lite, gemini-3.5-flash-lite  -> 200 with real content
 *   gemini-3.7-flash, gemini-3.1-flash-lite      -> 503 UNAVAILABLE (demand)
 *
 * Default is gemini-2.5-flash-lite because the thinking models consume a
 * small max_tokens budget entirely on reasoning and return content=None with
 * finish_reason=length (isEmptyCompletion -> TRANSIENT -> chain skips). The
 * -lite models answer even at max_tokens=10, which matters because the
 * campaign agent sends small budgets.
 */

import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';

import { shortCircuit } from './chain-routing.js';
import {
  EXTRA_PROVIDER_ORDER,
  buildExtras,
  extraRoutingEntries,
  isExtraProvider,
} from './extras.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

afterEach(() => loadEnv({}));

describe('gemini (generativelanguage) slot', () => {
  it('sits after mistral and before cline in the declared walk order', () => {
    // Google has the most reliable free tier of the extras, so it is tried
    // before the cline aggregator; cloudflare stays last.
    expect(EXTRA_PROVIDER_ORDER.indexOf('gemini')).toBe(
      EXTRA_PROVIDER_ORDER.indexOf('mistral') + 1,
    );
    expect(EXTRA_PROVIDER_ORDER.indexOf('cline')).toBe(
      EXTRA_PROVIDER_ORDER.indexOf('gemini') + 1,
    );
    expect(EXTRA_PROVIDER_ORDER[EXTRA_PROVIDER_ORDER.length - 1]).toBe('cloudflare');
  });

  it('is unavailable without a key and available with one', () => {
    loadEnv({});
    expect(buildExtras(silent).gemini.available).toBe(false);
    loadEnv({ GEMINI_API_KEY: 'AIza-test' });
    expect(buildExtras(silent).gemini.available).toBe(true);
  });

  it('defaults to the non-thinking model so a small max_tokens still answers', () => {
    // gemini-2.5-flash-lite returned content='OK' at max_tokens=10 live; the
    // thinking defaults (2.5-flash, 3.x-flash) return None/finish=length there.
    expect(loadEnv({}).env.GEMINI_MODEL).toBe('gemini-2.5-flash-lite');
  });

  it('points at the OpenAI-compatible base url', () => {
    expect(loadEnv({}).env.GEMINI_BASE_URL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  });

  it('gates the walk entry on key + model (retire convention)', () => {
    loadEnv({ GEMINI_API_KEY: 'AIza-test', GEMINI_MODEL: '' });
    expect(extraRoutingEntries()).toEqual([]);
    loadEnv({
      GEMINI_API_KEY: 'AIza-test',
      GEMINI_MODEL: 'gemini-2.5-flash-lite',
      GEMINI_MODELS: 'gemini-3.5-flash-lite,gemini-2.5-flash',
    });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => [e.provider, e.model])).toEqual([
      ['gemini', 'gemini-2.5-flash-lite'],
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-2.5-flash'],
    ]);
    expect(entries[1]!.label).toBe('gemini/gemini-3.5-flash-lite');
  });

  it('joins the walk between mistral and cline when both are configured', () => {
    loadEnv({
      MISTRAL_API_KEY: 'mk-1',
      GEMINI_API_KEY: 'AIza-test',
      CLINE_API_KEY: 'sk_cline-test',
      CLINE_MODEL: 'poolside/laguna-s-2.1:free',
    });
    const providers = extraRoutingEntries().map((e) => e.provider);
    expect(providers.indexOf('mistral')).toBeLessThan(providers.indexOf('gemini'));
    expect(providers.indexOf('gemini')).toBeLessThan(providers.indexOf('cline'));
  });

  it('pins a model with direct:gemini/<model>', () => {
    loadEnv({ GEMINI_API_KEY: 'AIza-test', GEMINI_MODEL: 'gemini-2.5-flash-lite' });
    expect(shortCircuit('direct:gemini/gemini-2.5-flash-lite')).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });
    expect(isExtraProvider('gemini')).toBe(true);
  });
});