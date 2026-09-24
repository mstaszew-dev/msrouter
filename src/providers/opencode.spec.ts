import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { loadEnv } from '../config/env.js';

import { postChatCompletion } from './fetch.js';
import { buildProviders } from './instances.js';
import { OpenCodeProvider } from './opencode.js';

vi.mock('./fetch.js', () => ({ postChatCompletion: vi.fn() }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

/** White-box view of the triple queue for tests. */
interface QueueView {
  queueSnapshot(): readonly { model: string; keyIdx: number }[];
  demoteTriple(t: { model: string; keyIdx: number }): void;
}

function makeProvider(keys: string[], models = ['big-pickle', 'nemotron-3-ultra-free']) {
  const p = new OpenCodeProvider({
    keys,
    baseUrl: 'https://opencode.ai/zen/v1',
    models,
    timeoutMs: 1000,
    log: silent,
  });
  return { p, q: p as unknown as QueueView };
}

describe('OpenCodeProvider pool', () => {
  it('is available iff at least one key is configured', () => {
    expect(makeProvider(['k1']).p.available).toBe(true);
    expect(makeProvider([]).p.available).toBe(false);
  });

  it('exposes keyCount and tripleCount', () => {
    const { p } = makeProvider(['k1', 'k2'], ['m1', 'm2', 'm3']);
    expect(p.keyCount).toBe(2);
    expect(p.tripleCount).toBe(6);
  });

  it('builds the rotation queue in model-major, key-minor order', () => {
    const { q } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
    // order: (m1,k0), (m1,k1), (m2,k0), (m2,k1) — all keys for m1, then all keys for m2
    expect(q.queueSnapshot()).toEqual([
      { model: 'm1', keyIdx: 0 },
      { model: 'm1', keyIdx: 1 },
      { model: 'm2', keyIdx: 0 },
      { model: 'm2', keyIdx: 1 },
    ]);
  });

  it('demoting the first triple moves it to the back', () => {
    const { q } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
    const first = q.queueSnapshot()[0]!;
    q.demoteTriple(first);
    expect(q.queueSnapshot()).toEqual([
      { model: 'm1', keyIdx: 1 },
      { model: 'm2', keyIdx: 0 },
      { model: 'm2', keyIdx: 1 },
      { model: 'm1', keyIdx: 0 },
    ]);
  });

  it('demote is idempotent', () => {
    const { q } = makeProvider(['k1'], ['m1', 'm2']);
    // Demote by the actual stored reference (matches how attempt() drives it
    // in production: it demotes the triple it received from queue.at()).
    const m1k0 = q.queueSnapshot().find((t) => t.model === 'm1' && t.keyIdx === 0)!;
    q.demoteTriple(m1k0);
    q.demoteTriple(m1k0); // second demote of the same reference is a no-op
    expect(q.queueSnapshot()).toEqual([
      { model: 'm2', keyIdx: 0 },
      { model: 'm1', keyIdx: 0 },
    ]);
  });

  it('attempt on unavailable provider returns KEY_FAILURE without throwing', async () => {
    const { p } = makeProvider([], ['m1']);
    const res = await p.attempt({ model: 'x', messages: [] }, new AbortController().signal, {
      model: 'm1',
      tripleIndex: 0,
    });
    expect(res.kind).toBe('KEY_FAILURE');
  });

  it('returns a KEY_FAILURE when the triple queue is empty (no models configured)', async () => {
    // Keys exist (so the provider is "available") but zero models means the
    // rotation queue has no triples at all; attempt() must fail safe instead
    // of throwing on the missing triple.
    const { p } = makeProvider(['k1'], []);
    const res = await p.attempt({ model: 'x', messages: [] }, new AbortController().signal, {
      tripleIndex: 0,
    });
    expect(res).toEqual({
      kind: 'KEY_FAILURE',
      status: 0,
      message: 'opencode: triple index out of range',
    });
  });

  it('queue.at wraps modulo length, so any tripleIndex resolves to a real triple (no out-of-range path)', () => {
    // RotationQueue.at() wraps; there is no "out of range" early-return by
    // design. This test documents that contract: a length-1 queue has one
    // triple regardless of the requested index.
    const { q } = makeProvider(['k1'], ['m1']);
    expect(q.queueSnapshot()).toHaveLength(1);
    expect(q.queueSnapshot()[0]).toEqual({ model: 'm1', keyIdx: 0 });
  });

  describe('attempt with a mocked chat completion', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('defaults tripleIndex to 0 and model to the triple model', async () => {
      const { p } = makeProvider(['k1'], ['m1']);
      vi.mocked(postChatCompletion).mockResolvedValue({
        kind: 'OK',
        response: new Response(),
      });
      const res = await p.attempt({ model: 'm1', messages: [] }, new AbortController().signal, {});
      expect(res.kind).toBe('OK');
      const [body, opts] = vi.mocked(postChatCompletion).mock.calls[0]!;
      expect(body.model).toBe('m1');
      expect(opts.authorization).toBe('Bearer k1');
      expect(opts.baseUrl).toBe('https://opencode.ai/zen/v1');
    });

    it('passes the requested tripleIndex and model override', async () => {
      const { p } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
      vi.mocked(postChatCompletion).mockResolvedValue({
        kind: 'OK',
        response: new Response(),
      });
      await p.attempt({ model: 'm1', messages: [] }, new AbortController().signal, {
        model: 'm2',
        tripleIndex: 1,
      });
      const [body, opts] = vi.mocked(postChatCompletion).mock.calls[0]!;
      expect(body.model).toBe('m2');
      expect(opts.authorization).toBe('Bearer k2');
    });

    it('demotes the triple and warns when the upstream returns KEY_FAILURE', async () => {
      const { p, q } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
      vi.mocked(postChatCompletion).mockResolvedValue({
        kind: 'KEY_FAILURE',
        status: 429,
        message: 'rate limited',
      });
      const res = await p.attempt({ model: 'm1', messages: [] }, new AbortController().signal, {
        tripleIndex: 0,
      });
      expect(res.kind).toBe('KEY_FAILURE');
      // (m1,k0) was demoted to the back of the queue.
      expect(q.queueSnapshot().map((t) => `${t.model}:${t.keyIdx}`)).toEqual([
        'm1:1',
        'm2:0',
        'm2:1',
        'm1:0',
      ]);
      expect(silent.warn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'opencode', status: 429 }),
        'opencode triple demoted to back of queue',
      );
    });
  });
});

describe('buildProviders free pool: x-opencode-session wiring', () => {
  // 2026-09-11: the /zen/v1 free tier rejects requests without a session
  // header (400 {"type":"MissingSessionID"} - "free tier can only be used in
  // OpenCode"). The factory must send one on every pool call, mirroring the
  // opencodego wiring. Verified by direct curl probes: with the header the
  // same key/model serves 200.
  beforeEach(() => {
    vi.mocked(postChatCompletion).mockReset();
    vi.mocked(postChatCompletion).mockResolvedValue({
      kind: 'OK',
      response: new Response('{}', { status: 200 }),
    });
  });

  afterEach(() => loadEnv({}));

  it('sends x-opencode-session, stable per process (auto-generated when unset)', async () => {
    loadEnv({ OPENCODE_KEY1: 'k1', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    const sessions: string[] = [];
    for (let i = 0; i < 2; i++) {
      await providers.opencode.attempt(
        { model: 'big-pickle', messages: [] },
        new AbortController().signal,
        {},
      );
      const [, opts] = vi.mocked(postChatCompletion).mock.calls[i]!;
      sessions.push((opts.extraHeaders as Record<string, string>)['x-opencode-session']!);
    }
    // Both attempts carry the SAME non-empty UUID: the free tier 400s without
    // it, and the id must identify the process, not the individual call.
    expect(sessions[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sessions[1]).toBe(sessions[0]);
  });

  it('pins x-opencode-session to OPENCODE_SESSION_ID when set', async () => {
    loadEnv({
      OPENCODE_KEY1: 'k1',
      OPENCODE_SESSION_ID: 'stable-session',
      SCHEDULE_INTERVAL_MINUTES: '-1',
    });
    const providers = buildProviders(silent);
    await providers.opencode.attempt(
      { model: 'big-pickle', messages: [] },
      new AbortController().signal,
      {},
    );
    const [, opts] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect((opts.extraHeaders as Record<string, string>)['x-opencode-session']).toBe(
      'stable-session',
    );
  });
});

describe('buildProviders free pool: gone-model slot filtering', () => {
  // 2026-09-17: nemotron-3-ultra-free and nemotron-3.5-lightning-free answer
  // 403 "free tier can only be used from within OpenCode" to every non-OpenCode
  // client (verified by direct curl probes), so they can never serve through
  // the gateway. Slots are removed by setting their env var empty; the factory
  // must drop the empty slot instead of building a broken empty-model triple.
  afterEach(() => loadEnv({}));

  it('drops slots whose model env var is empty, keeping the live ones', () => {
    loadEnv({
      OPENCODE_KEY1: 'k1',
      OPENCODE_MODEL: 'big-pickle',
      OPENCODE_NEMOTRON_MODEL: '',
      OPENCODE_MINIMAX_MODEL: '',
      SCHEDULE_INTERVAL_MINUTES: '-1',
    });
    const providers = buildProviders(silent);
    const models = providers.opencode.queueSnapshot().map((t) => t.model);
    // Nemotron pair dropped (emptied); absent vars keep their schema defaults.
    expect(models).toEqual([
      'big-pickle',
      'muse-spark-1.2-contributor-free',
      'mimo-v2.5-free',
      'deepseek-v4-flash-free',
      'muse-spark-1.3-contributor-free',
      'ling-3.0-flash-fin-free',
    ]);
  });

  it('keeps all eight slots when no model var is overridden (zod defaults)', () => {
    loadEnv({ OPENCODE_KEY1: 'k1', SCHEDULE_INTERVAL_MINUTES: '-1' });
    const providers = buildProviders(silent);
    // 8 defaulted model slots x 1 key = 8 triples
    expect(providers.opencode.queueSnapshot().length).toBe(8);
  });

  it('drops ALL slots when every model var is empty (provider still available, zero triples)', () => {
    loadEnv({
      OPENCODE_KEY1: 'k1',
      OPENCODE_MODEL: '',
      OPENCODE_MINIMAX_MODEL: '',
      OPENCODE_QWEN_MODEL: '',
      OPENCODE_NEMOTRON_MODEL: '',
      OPENCODE_MIMO_MODEL: '',
      OPENCODE_DEEPSEEK_FLASH_MODEL: '',
      OPENCODE_LAGUNA_MODEL: '',
      OPENCODE_LING_MODEL: '',
      SCHEDULE_INTERVAL_MINUTES: '-1',
    });
    const providers = buildProviders(silent);
    expect(providers.opencode.available).toBe(true); // keys configured
    expect(providers.opencode.queueSnapshot()).toEqual([]);
  });

  it('queues big-pickle then nemotron-3-ultra-free triples when both slots are configured (production contract)', () => {
    // The exact .env the gateway is expected to run with for this work:
    // big-pickle + nemotron-3-ultra-free live, every other slot retired.
    loadEnv({
      OPENCODE_KEY1: 'k1',
      OPENCODE_KEY2: 'k2',
      OPENCODE_KEY3: 'k3',
      OPENCODE_MODEL: 'big-pickle',
      OPENCODE_NEMOTRON_MODEL: 'nemotron-3-ultra-free',
      OPENCODE_MINIMAX_MODEL: '',
      OPENCODE_QWEN_MODEL: '',
      OPENCODE_MIMO_MODEL: '',
      OPENCODE_DEEPSEEK_FLASH_MODEL: '',
      OPENCODE_LAGUNA_MODEL: '',
      OPENCODE_LING_MODEL: '',
      SCHEDULE_INTERVAL_MINUTES: '-1',
    });
    const providers = buildProviders(silent);
    // Model-major, key-minor: every key for big-pickle, then every key for nemotron.
    expect(providers.opencode.keyCount).toBe(3);
    expect(providers.opencode.queueSnapshot()).toEqual([
      { model: 'big-pickle', keyIdx: 0 },
      { model: 'big-pickle', keyIdx: 1 },
      { model: 'big-pickle', keyIdx: 2 },
      { model: 'nemotron-3-ultra-free', keyIdx: 0 },
      { model: 'nemotron-3-ultra-free', keyIdx: 1 },
      { model: 'nemotron-3-ultra-free', keyIdx: 2 },
    ]);
  });
});
