import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { applyCorrelationId, matchPath, Router, sendJson, type HttpRequest } from './http.js';

function mockRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    headers: {},
    url: '/',
    method: 'GET',
    id: '',
    params: {},
    ...overrides,
  } as unknown as HttpRequest;
}

function mockResponse(): ServerResponse {
  return { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

describe('matchPath', () => {
  it('matches a literal path', () => {
    expect(matchPath('api/v1/models', 'api/v1/models')).toEqual({});
  });

  it('captures :params', () => {
    expect(matchPath('orgs/:id/deployments', 'orgs/org-1/deployments')).toEqual({
      id: 'org-1',
    });
  });

  it('returns null on mismatched segment count', () => {
    expect(matchPath('a/b', 'a')).toBeNull();
  });

  it('returns null on a differing literal', () => {
    expect(matchPath('a/b', 'a/c')).toBeNull();
  });
});

describe('Router', () => {
  it('resolves a parametrized route and exposes params', () => {
    const router = new Router();
    const seen: Record<string, string> = {};
    router.add('GET', 'v1/deployments/:id', (req) => {
      Object.assign(seen, req.params);
    });
    const matched = router.resolve('GET', 'v1/deployments/dep-9');
    expect(matched).not.toBeNull();
    expect(matched?.params).toEqual({ id: 'dep-9' });
  });

  it('returns null for an unknown route', () => {
    const router = new Router();
    router.add('GET', 'v1/x', () => undefined);
    expect(router.resolve('GET', 'v1/nope')).toBeNull();
  });

  it('add() is chainable and getRoutes() returns the registered routes', () => {
    const router = new Router();
    const handler = () => undefined;
    expect(router.add('post', 'v1/x', handler)).toBe(router);
    const routes = router.getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe('POST');
    expect(routes[0]!.handler).toBe(handler);
  });

  it('dispatch parses the URL and invokes the matched handler with params', async () => {
    const router = new Router();
    const seen: Array<{ id: string; params: Record<string, string> }> = [];
    router.add('GET', 'v1/models/:model', (req, res) => {
      seen.push({ id: req.id, params: req.params });
      res.setHeader('x-cid', req.id);
    });
    const res = { setHeader: vi.fn() } as unknown as ServerResponse;
    const req = { url: '/v1/models/gpt-4', method: 'get', headers: {}, id: '' } as unknown as HttpRequest;

    await router.dispatch(req, res);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.params).toEqual({ model: 'gpt-4' });
    expect(res.setHeader).toHaveBeenCalledWith('x-cid', '');
  });

  it('dispatch falls back to the default 404 handler when no route matches', async () => {
    const router = new Router();
    const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse;

    await router.dispatch({ url: '/nope', method: 'GET', headers: {} } as unknown as HttpRequest, res);

    expect(res.writeHead).toHaveBeenCalledWith(
      404,
      expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
    );
    expect(res.end).toHaveBeenCalled();
  });
});

describe('applyCorrelationId', () => {
  it('echoes a valid incoming correlation id and trims it', () => {
    const req = mockRequest({ headers: { 'x-correlation-id': '  abc-123  ' } });
    const res = mockResponse();
    applyCorrelationId(req, res);
    expect(req.id).toBe('abc-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'abc-123');
  });

  it('mints a fresh id when the incoming one is empty or too long', () => {
    for (const bad of ['', '   ', 'x'.repeat(129)]) {
      const req = mockRequest({ headers: { 'x-correlation-id': bad } });
      const res = mockResponse();
      applyCorrelationId(req, res);
      expect(req.id).not.toBe('');
      expect(req.id.length).toBeLessThanOrEqual(128);
      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', req.id);
    }
  });

  it('falls back to a random id when crypto.randomUUID is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: undefined },
      configurable: true,
      writable: true,
    });
    try {
      const req = mockRequest();
      const res = mockResponse();
      applyCorrelationId(req, res);
      expect(req.id).toHaveLength(32);
    } finally {
      Object.defineProperty(globalThis, 'crypto', descriptor!);
    }
  });
});

describe('sendJson', () => {
  it('writes a JSON body with content-type and content-length', () => {
    const res = mockResponse();
    sendJson(res, 201, { ok: true });
    expect(res.writeHead).toHaveBeenCalledWith(
      201,
      expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
    );
    expect(res.end).toHaveBeenCalledWith('{"ok":true}');
  });
});
