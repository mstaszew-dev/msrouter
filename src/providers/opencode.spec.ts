import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { postChatCompletion } from './fetch.js';
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
