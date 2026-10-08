/**
 * Tests for the extra free-tier single-key providers (UnoRouter, Groq,
 * SambaNova, Mistral, Cloudflare Workers AI). All are OpenAI-compatible
 * chat-completions upstreams added 2026-09-18; each becomes a chain entry
 * only when its API key (and model) is configured.
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

describe('buildExtras - availability gating', () => {
  it('is unavailable for every extra when no keys are configured', () => {
    loadEnv({});
    const extras = buildExtras(silent);
    for (const id of EXTRA_PROVIDER_ORDER) {
      expect(extras[id].available, id).toBe(false);
    }
  });

  it('each extra becomes available when its key is set', () => {
    loadEnv({
      UNOROUTER_API_KEY: 'uk-1',
      GROQ_API_KEY: 'gsk-1',
      SAMBANOVA_API_KEY: 'sk-1',
      MISTRAL_API_KEY: 'mk-1',
      CLINE_API_KEY: 'sk_cline-test',
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_ACCOUNT_ID: 'acct-1',
      UNOROUTER_MODEL: 'deepseek/deepseek-v3',
    });
    const extras = buildExtras(silent);
    for (const id of EXTRA_PROVIDER_ORDER) {
      expect(extras[id].available, id).toBe(true);
    }
  });

  it('cloudflare builds no walk entry without CLOUDFLARE_ACCOUNT_ID (URL embeds it)', () => {
    loadEnv({ CLOUDFLARE_API_KEY: 'cf-1' });
    const extras = buildExtras(silent);
    expect(extras.cloudflare.available).toBe(true); // key alone marks the provider
    expect(extras.cloudflare.attempt).toBeDefined();
    // but no routing entry is built (see extraRoutingEntries)
    expect(extraRoutingEntries()).toEqual([]);
  });
});

describe('extraRoutingEntries - walk entries', () => {
  it('builds entries only for configured providers, in declared order', () => {
    loadEnv({
      GROQ_API_KEY: 'gsk-1',
      MISTRAL_API_KEY: 'mk-1',
    });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => e.provider)).toEqual(['groq', 'mistral']);
    expect(entries[0]).toMatchObject({ model: 'openai/gpt-oss-120b', attemptIndex: 0 });
    expect(entries[1]).toMatchObject({ model: 'mistral-small-latest', attemptIndex: 0 });
  });

  it('skips a provider whose model env var is emptied (retire convention)', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-1', GROQ_MODEL: '' });
    expect(extraRoutingEntries()).toEqual([]);
  });

  it('cloudflare requires key + account id + model for an entry', () => {
    loadEnv({
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
    expect(extraRoutingEntries()).toEqual([]);
    loadEnv({
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_ACCOUNT_ID: 'acct-1',
      CLOUDFLARE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => e.provider)).toEqual(['cloudflare']);
  });

  it('routes to the env-declared models (sambanova case preserved)', () => {
    loadEnv({ SAMBANOVA_API_KEY: 'sk-1', SAMBANOVA_MODEL: 'Meta/Llama-4-Maverick-X' });
    const entries = extraRoutingEntries();
    expect(entries[0]!.model).toBe('Meta/Llama-4-Maverick-X');
  });
});

describe('shortCircuit - direct: extras', () => {
  it('parses direct:groq/<model> (case preserved)', () => {
    expect(shortCircuit('direct:groq/llama-3.3-70b-versatile')).toEqual({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
  });

  it('parses direct:sambanova/<model> with mixed-case model id', () => {
    expect(shortCircuit('direct:sambanova/Meta/Llama-4-Maverick-17B-12E-Instruct')).toEqual({
      provider: 'sambanova',
      model: 'Meta/Llama-4-Maverick-17B-12E-Instruct',
    });
  });

  it('parses direct:unorouter/, direct:mistral/, direct:cloudflare/ (prefix-insensitive)', () => {
    expect(shortCircuit('direct:UNOROUTER/deepseek/x')).toEqual({
      provider: 'unorouter',
      model: 'deepseek/x',
    });
    expect(shortCircuit('direct:Mistral/mistral-small-latest')).toEqual({
      provider: 'mistral',
      model: 'mistral-small-latest',
    });
    expect(shortCircuit('direct:cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toEqual({
      provider: 'cloudflare',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
  });
});

describe('isExtraProvider', () => {
  it('recognizes extra ids and rejects everything else', () => {
    expect(isExtraProvider('groq')).toBe(true);
    expect(isExtraProvider('cloudflare')).toBe(true);
    expect(isExtraProvider('openrouter')).toBe(false);
    expect(isExtraProvider('zai')).toBe(false);
  });
});

describe('extraRoutingEntries - additional models (<PROVIDER>_MODELS CSV)', () => {
  it('adds CSV models as extra walk entries after the primary', () => {
    loadEnv({
      GROQ_API_KEY: 'gsk-1',
      GROQ_MODELS: 'qwen/qwen3.8-27b,openai/gpt-oss-20b',
    });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => [e.provider, e.model])).toEqual([
      ['groq', 'openai/gpt-oss-120b'],
      ['groq', 'qwen/qwen3.8-27b'],
      ['groq', 'openai/gpt-oss-20b'],
    ]);
    // Labels carry the model so servedBy logs stay unambiguous.
    expect(entries[1]!.label).toBe('groq/qwen/qwen3.8-27b');
  });

  it('ignores the CSV when the primary model is empty (retired slot)', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-1', GROQ_MODEL: '', GROQ_MODELS: 'a,b' });
    expect(extraRoutingEntries()).toEqual([]);
  });

  it('dedupes a CSV entry that repeats the primary model', () => {
    loadEnv({ GROQ_API_KEY: 'gsk-1', GROQ_MODELS: 'openai/gpt-oss-120b, qwen/x ,,' });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => e.model)).toEqual(['openai/gpt-oss-120b', 'qwen/x']);
  });

  it('cloudflare CSV entries still require key + account id', () => {
    loadEnv({
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_MODELS: '@cf/openai/gpt-oss-120b',
    });
    expect(extraRoutingEntries()).toEqual([]);
    loadEnv({
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_ACCOUNT_ID: 'acct-1',
      CLOUDFLARE_MODELS: '@cf/openai/gpt-oss-120b',
    });
    expect(extraRoutingEntries().map((e) => e.model)).toEqual([
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/openai/gpt-oss-120b',
    ]);
  });
});

// 2026-10-08: cline (api.cline.bot/api/v1) joins the extras as a single-key
// slot. Only its ":free"-suffixed models are usable without credits; the
// account balance is negative, so any paid id fails insufficient_credits.
// Listed order: after the direct free tiers, before cloudflare (last).
describe('cline (api.cline.bot) slot', () => {
  it('sits between mistral and cloudflare in the declared walk order', () => {
    expect(EXTRA_PROVIDER_ORDER.indexOf('cline')).toBe(EXTRA_PROVIDER_ORDER.indexOf('mistral') + 1);
    expect(EXTRA_PROVIDER_ORDER[EXTRA_PROVIDER_ORDER.length - 1]).toBe('cloudflare');
  });

  it('is unavailable without a key and available with one', () => {
    loadEnv({});
    expect(buildExtras(silent).cline.available).toBe(false);
    loadEnv({ CLINE_API_KEY: 'sk_cline-test' });
    expect(buildExtras(silent).cline.available).toBe(true);
  });

  it('gates the walk entry on key + model (retire convention)', () => {
    loadEnv({ CLINE_API_KEY: 'sk_cline-test', CLINE_MODEL: '' });
    expect(extraRoutingEntries()).toEqual([]);
    loadEnv({
      CLINE_API_KEY: 'sk_cline-test',
      CLINE_MODEL: 'poolside/laguna-s-2.1:free',
      CLINE_MODELS: 'dots-studio/dots-3-note-preview:free,,cohere/north-mini-code:free',
    });
    const entries = extraRoutingEntries();
    expect(entries.map((e) => [e.provider, e.model])).toEqual([
      ['cline', 'poolside/laguna-s-2.1:free'],
      ['cline', 'dots-studio/dots-3-note-preview:free'],
      ['cline', 'cohere/north-mini-code:free'],
    ]);
    expect(entries[1]!.label).toBe('cline/dots-studio/dots-3-note-preview:free');
  });

  it('joins the walk between mistral and cloudflare when both are configured', () => {
    loadEnv({
      MISTRAL_API_KEY: 'mk-1',
      CLINE_API_KEY: 'sk_cline-test',
      CLOUDFLARE_API_KEY: 'cf-1',
      CLOUDFLARE_ACCOUNT_ID: 'acct-1',
    });
    // mistral defaults to mistral-small-latest, cline defaults empty via the
    // retire convention, cloudflare via account id; the CSV entries all key on
    // the provider, so just assert relative provider order of cline vs others.
    const providers = extraRoutingEntries().map((e) => e.provider);
    expect(providers.indexOf('mistral')).toBeLessThan(providers.indexOf('cline'));
    expect(providers.indexOf('cline')).toBeLessThan(providers.indexOf('cloudflare'));
  });

  it('pins a free model with direct:cline/<model> (case preserved)', () => {
    expect(shortCircuit('direct:cline/poolside/laguna-s-2.1:free')).toEqual({
      provider: 'cline',
      model: 'poolside/laguna-s-2.1:free',
    });
    expect(isExtraProvider('cline')).toBe(true);
  });
});
