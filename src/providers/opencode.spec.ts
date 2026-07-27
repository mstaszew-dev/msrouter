import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenCodeProvider } from './opencode.js';

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

  it('builds the candidate queue in model-major, key-minor order', () => {
    const { q } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
    // order: (m1,k0), (m2,k0), (m1,k1), (m2,k1)
    expect(q.queueSnapshot()).toEqual([
      { model: 'm1', keyIdx: 0 },
      { model: 'm2', keyIdx: 0 },
      { model: 'm1', keyIdx: 1 },
      { model: 'm2', keyIdx: 1 },
    ]);
  });

  it('demoting the first triple moves it to the back', () => {
    const { q } = makeProvider(['k1', 'k2'], ['m1', 'm2']);
    const first = q.queueSnapshot()[0]!;
    q.demoteTriple(first);
    expect(q.queueSnapshot()).toEqual([
      { model: 'm2', keyIdx: 0 },
      { model: 'm1', keyIdx: 1 },
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

  it('attempt on an out-of-range triple index returns KEY_FAILURE', async () => {
    const { p } = makeProvider(['k1'], ['m1']);
    const res = await p.attempt({ model: 'x', messages: [] }, new AbortController().signal, {
      model: 'm1',
      tripleIndex: 99,
    });
    expect(res.kind).toBe('KEY_FAILURE');
  });
});
