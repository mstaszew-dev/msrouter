/**
 * Integration tests for the admin API: a real server on an ephemeral port,
 * driven with fetch. Covers the auth flows (JWT + scrypt), role-based
 * authorization (401 unauthenticated / 403 viewer on admin-only routes), the
 * users-file CRUD + add-column schema evolution, the SELECT-only SQL console
 * (hashes never leave the server), the observability snapshot, and static SPA
 * serving with security headers.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoginResponse, ObsSnapshot, QueryResponse } from '../shared/schema.js';
import type { UsersFile } from '../shared/schema.js';

import type { ObsDeps } from './obs.js';
import { hashPassword } from './password.js';
import { createAdminServer } from './server.js';
import { UserStore } from './userStore.js';

let dir: string;
let usersPath: string;
let server: ReturnType<typeof createAdminServer>;
let baseUrl: string;

const SECRET = 'test-secret-0123456789abcdef';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'admin-api-'));
  usersPath = join(dir, 'users.json');
  server = undefined as unknown as ReturnType<typeof createAdminServer>;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  await rm(dir, { recursive: true, force: true });
});

const obsDeps = (overrides: Partial<ObsDeps> = {}): ObsDeps => ({
  gatewayBaseUrl: 'http://127.0.0.1:8999',
  fetchImpl: async () =>
    new Response(JSON.stringify({ status: 'ok', uptime: 42 }), { status: 200 }),
  ledgerPath: join(dir, 'ledger.jsonl'),
  checkpointPath: join(dir, 'checkpoint.json'),
  ragDbPath: '',
  kafkaEnabled: false,
  kafkaBootstrap: 'localhost:19092',
  slackConfigured: false,
  tcpProbe: async () => true,
  ...overrides,
});

async function startServer(seed: UsersFile, opts: { webDistDir?: string } = {}): Promise<string> {
  await writeFile(usersPath, JSON.stringify(seed), 'utf8');
  const store = await UserStore.load(usersPath);
  server = createAdminServer({
    store,
    storePath: usersPath,
    jwtSecret: SECRET,
    tokenTtlSeconds: 3600,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    obsDeps: obsDeps(),
    webDistDir: opts.webDistDir,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

const demoHash = () => hashPassword('demo1234');
const viewerHash = () => hashPassword('viewer1234');

async function seedUsers(extra: UsersFile['users'] = []): Promise<UsersFile> {
  const [dh, vh] = await Promise.all([demoHash(), viewerHash()]);
  const doc: UsersFile = {
    schemaVersion: 1,
    columns: [{ name: 'department', type: 'string', defaultValue: 'general' }],
    users: [
      {
        username: 'demo',
        passwordHash: dh,
        role: 'admin',
        email: 'demo@example.com',
        displayName: 'Demo User',
        active: true,
        createdAt: '2026-09-01T10:00:00.000Z',
        department: 'platform',
      },
      {
        username: 'viewer',
        passwordHash: vh,
        role: 'viewer',
        email: 'viewer@example.com',
        displayName: 'Viewer One',
        active: true,
        createdAt: '2026-09-01T10:00:00.000Z',
        department: 'support',
      },
      ...extra,
    ],
  };
  return doc;
}

async function login(username: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function loginToken(username = 'demo', password = 'demo1234'): Promise<string> {
  const res = await login(username, password);
  expect(res.status).toBe(200);
  const body = (await res.json()) as LoginResponse;
  return body.token;
}

const authed = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

describe('POST /api/v1/auth/login', () => {
  it('issues a JWT and the public user for valid credentials', async () => {
    await startServer(await seedUsers());
    const res = await login('demo', 'demo1234');
    expect(res.status).toBe(200);
    const body = (await res.json()) as LoginResponse;
    expect(body.tokenType).toBe('Bearer');
    expect(body.token.split('.')).toHaveLength(3);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(body.user)).not.toContain('scrypt$');
    expect(body.user.username).toBe('demo');
    expect(body.user.department).toBe('platform');
  });

  it('rejects a wrong password with 401', async () => {
    await startServer(await seedUsers());
    const res = await login('demo', 'wrong-pass');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown user with the same 401 (no user enumeration)', async () => {
    await startServer(await seedUsers());
    const res = await login('ghost', 'whatever1');
    expect(res.status).toBe(401);
    const wrongPw = await login('demo', 'wrong-pass');
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      ((await wrongPw.json()) as { error: { message: string } }).error.message,
    );
  });

  it('rejects an inactive account with 403', async () => {
    const disabled: UsersFile['users'][number] = {
      username: 'offboarded',
      passwordHash: await hashPassword('password1'),
      role: 'viewer',
      email: 'off@example.com',
      displayName: 'Gone',
      active: false,
      createdAt: '2026-09-01T10:00:00.000Z',
    };
    await startServer(await seedUsers([disabled]));
    const res = await login('offboarded', 'password1');
    expect(res.status).toBe(403);
  });

  it('rate limits repeated attempts (429) even with valid credentials', async () => {
    await startServer(await seedUsers());
    for (let i = 0; i < 5; i++) {
      await login('demo', 'definitely-wrong');
    }
    const sixth = await login('demo', 'demo1234');
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('rejects malformed bodies with 400', async () => {
    await startServer(await seedUsers());
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('authorization', () => {
  it('blocks tokenless and garbage-token requests with 401', async () => {
    await startServer(await seedUsers());
    expect((await fetch(`${baseUrl}/api/v1/auth/me`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { authorization: 'Bearer junk' } }))
        .status,
    ).toBe(401);
  });

  it('lets a viewer read but not mutate (403), including the SQL console', async () => {
    await startServer(await seedUsers());
    const token = await loginToken('viewer', 'viewer1234');
    expect((await fetch(`${baseUrl}/api/v1/users`, { headers: authed(token) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/v1/obs/snapshot`, { headers: authed(token) })).status).toBe(
      200,
    );
    const query = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ sql: 'SELECT username FROM ?' }),
    });
    expect(query.status).toBe(403);
    const create = await fetch(`${baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        username: 'nope',
        password: 'longenough1',
        email: 'n@example.com',
        displayName: 'Nope',
      }),
    });
    expect(create.status).toBe(403);
    const column = await fetch(`${baseUrl}/api/v1/users/columns`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'x', type: 'string' }),
    });
    expect(column.status).toBe(403);
  });

  it('returns the caller profile from /auth/me', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: authed(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('demo');
  });
});

describe('users administration (admin role)', () => {
  it('creates a user, persists it, and hides the hash', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        username: 'newbie',
        password: 'longenough1',
        role: 'viewer',
        email: 'newbie@example.com',
        displayName: 'New Bie',
      }),
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain('scrypt$');
    const onDisk = JSON.parse(await readFile(usersPath, 'utf8')) as UsersFile;
    expect(onDisk.users.some((u) => u.username === 'newbie')).toBe(true);
    const list = await fetch(`${baseUrl}/api/v1/users`, { headers: authed(token) });
    const listBody = (await list.json()) as { users: Array<{ username: string }> };
    expect(listBody.users.some((u) => u.username === 'newbie')).toBe(true);
  });

  it('rejects duplicate usernames with 409', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        username: 'demo',
        password: 'longenough1',
        email: 'd@example.com',
        displayName: 'Dup',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('adds a column and backfills existing rows', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/users/columns`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'team', type: 'string', defaultValue: 'core' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      columns: Array<{ name: string }>;
      users: Array<Record<string, unknown>>;
    };
    expect(body.columns.map((c) => c.name)).toContain('team');
    expect(body.users.every((u) => u['team'] === 'core')).toBe(true);
  });
});

describe('POST /api/v1/query (admin)', () => {
  it('runs read-only SQL and never exposes password hashes', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ sql: 'SELECT * FROM ? WHERE active = true ORDER BY username' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueryResponse;
    expect(body.rowCount).toBe(2);
    expect(body.columns).toContain('department');
    expect(JSON.stringify(body)).not.toContain('scrypt$');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('blocks write attempts with 400', async () => {
    await startServer(await seedUsers());
    const token = await loginToken();
    const res = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ sql: 'DELETE FROM ?' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('profile management', () => {
  it('updates own email and persists it', async () => {
    await startServer(await seedUsers());
    const token = await loginToken('viewer', 'viewer1234');
    const res = await fetch(`${baseUrl}/api/v1/users/me`, {
      method: 'PATCH',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ email: 'new-v@example.com' }),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(usersPath, 'utf8')) as UsersFile;
    expect(onDisk.users.find((u) => u.username === 'viewer')?.email).toBe('new-v@example.com');
  });

  it('changes own password: old stops working, new works', async () => {
    await startServer(await seedUsers());
    const token = await loginToken('viewer', 'viewer1234');
    const wrongCurrent = await fetch(`${baseUrl}/api/v1/auth/password`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ currentPassword: 'nope', newPassword: 'brand-new-pass' }),
    });
    expect(wrongCurrent.status).toBe(401);
    const ok = await fetch(`${baseUrl}/api/v1/auth/password`, {
      method: 'POST',
      headers: authed(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ currentPassword: 'viewer1234', newPassword: 'brand-new-pass' }),
    });
    expect(ok.status).toBe(200);
    expect((await login('viewer', 'viewer1234')).status).toBe(401);
    expect((await login('viewer', 'brand-new-pass')).status).toBe(200);
  });
});

describe('GET /api/v1/obs/snapshot', () => {
  it('returns a full observability snapshot for any authenticated role', async () => {
    await startServer(await seedUsers());
    const token = await loginToken('viewer', 'viewer1234');
    const res = await fetch(`${baseUrl}/api/v1/obs/snapshot`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ObsSnapshot;
    expect(body.gateway.live.status).toBe('up');
    expect(body.gateway.uptimeSeconds).toBe(42);
    expect(body.director).toBeTruthy();
    expect(body.kafka.enabled).toBe(false);
    expect(body.slack.status).toBe('unconfigured');
  });
});

describe('static SPA serving', () => {
  it('serves index.html, assets with content types, and SPA fallback', async () => {
    const webDist = join(dir, 'webdist');
    await mkdir(webDist, { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>app</title>', 'utf8');
    await writeFile(join(webDist, 'assets.js'), 'console.log(1)', 'utf8');
    await startServer(await seedUsers(), { webDistDir: webDist });
    const index = await fetch(`${baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await index.text()).toContain('<!doctype html>');
    const asset = await fetch(`${baseUrl}/assets.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const spa = await fetch(`${baseUrl}/dashboard`);
    expect(await spa.text()).toContain('<!doctype html>');
  });

  it('blocks path traversal outside the dist root', async () => {
    const webDist = join(dir, 'webdist2');
    await mkdir(webDist, { recursive: true });
    await writeFile(join(webDist, 'index.html'), 'app', 'utf8');
    await writeFile(join(dir, 'secret.txt'), 'secret', 'utf8');
    await startServer(await seedUsers(), { webDistDir: webDist });
    const res = await fetch(`${baseUrl}/..%2Fsecret.txt`);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('secret');
  });

  it('returns API-style 404 JSON when no dist dir is configured', async () => {
    await startServer(await seedUsers());
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
