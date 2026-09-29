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
import { EXTRA_PROVIDER_ORDER, buildExtras, extraRoutingEntries, isExtraProvider } from './extras.js';

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
    loadEnv({ CLOUDFLARE_API_KEY: 'cf-1', CLOUDFLARE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
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
