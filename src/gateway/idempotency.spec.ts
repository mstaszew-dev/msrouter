/**
 * Tests for idempotency cache — value caching, in-flight deduplication,
 * TTL expiry, and bounded eviction.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  idempotencyHit,
  beginIdem,
  storeIdemResult,
  dropIdem,
  pruneIdem,
  idemCache,
} from './idempotency.js';

function createMockResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
    headers: {},
  } as any;
}

describe('idempotency cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    idemCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    idemCache.clear();
  });

  describe('idempotencyHit', () => {
    it('returns false for unknown key', async () => {
      const hit = await idempotencyHit('unknown-key', {} as any);
      expect(hit).toBe(false);
    });

    it('returns false for expired entry', async () => {
      const idemKey = 'expired-key';
      const now = Date.now();
      idemCache.set(idemKey, {
        kind: 'value',
        status: 200,
        body: { foo: 'bar' },
        exp: now - 1000,
      });

      const hit = await idempotencyHit(idemKey, {} as any);
      expect(hit).toBe(false);
    });

    it('serves cached value and returns true', async () => {
      const idemKey = 'cached-key';
      const now = Date.now();
      idemCache.set(idemKey, {
        kind: 'value',
        status: 201,
        body: { id: 'abc' },
        exp: now + 60_000,
      });

      const res = createMockResponse();
      const hit = await idempotencyHit(idemKey, res);
      expect(hit).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(201, expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
      }));
    });

    it('awaits in-flight promise and returns true', async () => {
      const idemKey = 'inflight-key';
      const promise = Promise.resolve({ status: 200, body: { ok: true } });
      idemCache.set(idemKey, {
        kind: 'promise',
        promise,
        exp: Date.now() + 60_000,
      });

      const res = createMockResponse();
      const hit = await idempotencyHit(idemKey, res);
      expect(hit).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
      }));
    });

    it('returns false when in-flight promise rejects', async () => {
      const idemKey = 'failing-key';
      const promise = Promise.reject(new Error('upstream failed'));
      idemCache.set(idemKey, {
        kind: 'promise',
        promise,
        exp: Date.now() + 60_000,
      });

      const hit = await idempotencyHit(idemKey, {} as any);
      expect(hit).toBe(false);
    });
  });

  describe('beginIdem / storeIdemResult / dropIdem', () => {
    it('returns undefined for stream or missing key', () => {
      const streamResult = beginIdem('key', true);
      expect(streamResult).toBeUndefined();

      const noKeyResult = beginIdem(undefined, false);
      expect(noKeyResult).toBeUndefined();
    });

    it('creates in-flight promise and stores it', () => {
      const handle = beginIdem('new-key', false);
      expect(handle).toBeDefined();
      expect(handle?.key).toBe('new-key');
      expect(handle?.resolve).toBeDefined();
      expect(handle?.reject).toBeDefined();

      const cached = idemCache.get('new-key');
      expect(cached).toBeDefined();
      expect(cached?.kind).toBe('promise');
    });

    it('storeIdemResult resolves promise and caches value', async () => {
      const handle = beginIdem('store-key', false);
      expect(handle).toBeDefined();

      storeIdemResult(handle!, 201, { created: true });

      const cached = idemCache.get('store-key');
      expect(cached).toBeDefined();
      expect(cached?.kind).toBe('value');
      expect(cached?.status).toBe(201);
      expect(cached?.body).toEqual({ created: true });

      const result = await handle!.promise;
      expect(result).toEqual({ status: 201, body: { created: true } });
    });

    it('dropIdem removes the key', () => {
      beginIdem('drop-key', false);
      dropIdem('drop-key');
      const cached = idemCache.get('drop-key');
      expect(cached).toBeUndefined();

      dropIdem(undefined);
    });
  });

  describe('pruneIdem', () => {
    it('evicts oldest entries when over capacity', () => {
      for (let i = 0; i < 1010; i++) {
        beginIdem(`key-${i}`, false);
      }
      expect(idemCache.size).toBeLessThanOrEqual(1000);
    });

    it('does nothing when under capacity', () => {
      for (let i = 0; i < 500; i++) {
        beginIdem(`key-${i}`, false);
      }
      const sizeBefore = idemCache.size;
      pruneIdem();
      expect(idemCache.size).toBe(sizeBefore);
    });
  });
});
