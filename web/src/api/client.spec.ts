/**
 * Tests for the API client: a thin fetch wrapper that attaches the JWT,
 * normalizes the server's error envelope into ApiError, handles 401 by
 * clearing the session, and validates responses against the shared zod
 * schemas so a backend contract break surfaces immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, tokenStore, unauthorizedHandler } from './client';

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const loginPayload = {
  token: 'jwt-token-abc',
  tokenType: 'Bearer',
  expiresAt: '2026-09-02T23:00:00.000Z',
  user: {
    username: 'demo',
    role: 'admin',
    email: 'demo@msrouter.local',
    displayName: 'Demo Admin',
    active: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    department: 'platform',
    logins: 0,
  },
};

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  unauthorizedHandler.set(null);
});

describe('api.login', () => {
  it('posts credentials and returns a validated LoginResponse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(loginPayload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.login('demo', 'demo1234');
    expect(res.token).toBe('jwt-token-abc');
    expect(res.user.username).toBe('demo');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ username: 'demo', password: 'demo1234' }));
  });

  it('surfaces the server error envelope as ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({ error: { code: 'UNAUTHORIZED', message: 'invalid credentials' } }, 401),
      ),
    );
    const err = await api.login('demo', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe('UNAUTHORIZED');
    expect((err as ApiError).message).toBe('invalid credentials');
  });
});

describe('authenticated requests', () => {
  it('attaches the stored bearer token', async () => {
    tokenStore.set('tok-123');
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        columns: [],
        users: [loginPayload.user],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.users();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123');
  });

  it('on 401: clears the token and fires the unauthorized handler', async () => {
    tokenStore.set('stale-token');
    const handler = vi.fn();
    unauthorizedHandler.set(handler);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401),
      ),
    );

    await expect(api.users()).rejects.toBeInstanceOf(ApiError);
    expect(tokenStore.get()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('typed endpoint wrappers', () => {
  it('me() unwraps the user envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ user: loginPayload.user })));
    const me = await api.me();
    expect(me.username).toBe('demo');
  });

  it('createUser posts the form and returns the created user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ user: loginPayload.user }));
    vi.stubGlobal('fetch', fetchMock);
    const created = await api.createUser({
      username: 'newbie',
      password: 'longenough1',
      role: 'viewer',
      email: 'n@msrouter.local',
      displayName: 'New Bie',
    });
    expect(created.username).toBe('demo');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).password).toBe('longenough1');
  });

  it('addColumn posts to the columns endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ columns: [{ name: 'team', type: 'string' }], users: [loginPayload.user] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await api.addColumn({ name: 'team', type: 'string' });
    expect(res.columns[0]?.name).toBe('team');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v1/users/columns');
  });

  it('updateProfile patches the own profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ user: { ...loginPayload.user, email: 'x@msrouter.local' } }));
    vi.stubGlobal('fetch', fetchMock);
    const updated = await api.updateProfile({ email: 'x@msrouter.local' });
    expect(updated.email).toBe('x@msrouter.local');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/users/me');
    expect(init.method).toBe('PATCH');
  });

  it('changePassword posts to the password endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ user: loginPayload.user }));
    vi.stubGlobal('fetch', fetchMock);
    await api.changePassword({ currentPassword: 'a', newPassword: 'longenough1' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v1/auth/password');
  });

  it('rejects client-side schema violations before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      api.createUser({
        username: 'ok',
        password: 'short',
        role: 'viewer',
        email: 'n@msrouter.local',
        displayName: 'X',
      }),
    ).rejects.toThrowError(/too_small/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps network failures in ApiError with code NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('wraps a non-JSON error body in a generic ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })),
    );
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('BAD_RESPONSE');
    expect((err as ApiError).status).toBe(502);
  });
});

describe('response validation', () => {
  it('rejects an obs snapshot that violates the shared schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ gateway: 'not-an-object' })));
    await expect(api.obs()).rejects.toBeInstanceOf(Error);
  });

  it('returns parsed QueryResponse rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson({ columns: ['username'], rows: [{ username: 'demo' }], rowCount: 1 }),
      ),
    );
    const res = await api.query('SELECT username FROM ?');
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]?.['username']).toBe('demo');
  });
});
