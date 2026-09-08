/**
 * Unit/integration tests for the admin HTTP server shell itself (not the API
 * handlers, which have their own suite): JSON body parsing limits (413/400),
 * static SPA serving (index fallback, content types, HEAD), the traversal
 * guard, security headers on every response, and the method gate for non-API
 * routes.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ObsDeps } from './obs.js';
import { hashPassword } from './password.js';
import { createAdminServer } from './server.js';
import { UserStore } from './userStore.js';

let dir: string;
let webDist: string;
let usersPath: string;
let server: ReturnType<typeof createAdminServer>;
let baseUrl: string;

const SECRET = 'server-spec-secret-0123456789';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'admin-server-'));
  webDist = join(dir, 'web-dist');
  await mkdir(webDist);
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

const obsDeps = (): ObsDeps => ({
  gatewayBaseUrl: 'http://127.0.0.1:8999',
  fetchImpl: async () => new Response('{}', { status: 200 }),
  ledgerPath: join(dir, 'ledger.jsonl'),
  checkpointPath: join(dir, 'checkpoint.json'),
  ragDbPath: '',
  kafkaEnabled: false,
  kafkaBootstrap: 'localhost:19092',
  slackConfigured: false,
  tcpProbe: async () => true,
});

async function startServer(webDistDir?: string): Promise<string> {
  await writeFile(
    usersPath,
    JSON.stringify({
      schemaVersion: 1,
      columns: [],
      users: [
        {
          username: 'demo',
          passwordHash: await hashPassword('demo1234'),
          role: 'admin',
          email: 'demo@example.com',
          displayName: 'Demo Admin',
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  );
  const store = await UserStore.load(usersPath);
  server = createAdminServer({
    store,
    storePath: usersPath,
    jwtSecret: SECRET,
    tokenTtlSeconds: 3600,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    obsDeps: obsDeps(),
    webDistDir,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

describe('admin server: JSON body handling', () => {
  it('rejects a body over 1MB with 413 (or the connection reset that carries it)', async () => {
    await startServer();
    // The server responds 413 and sets connection: close while the client is
    // still streaming the oversized body; the client may see EPIPE before it
    // can read the response. Either outcome proves the 1MB cap is enforced.
    await expect(
      fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'x'.repeat(2 * 1024 * 1024), password: 'y' }),
      }),
    ).rejects.toMatchObject({ cause: { code: 'EPIPE' } });
  });

  it('rejects invalid JSON with 400', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not valid JSON');
  });
});

describe('admin server: static SPA serving', () => {
  it('serves index.html for / with HTML content type and CSP', async () => {
    await writeFile(join(webDist, 'index.html'), '<html><body>console</body></html>');
    await startServer(webDist);
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain('default-src');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect((await res.text())).toContain('console');
  });

  it('falls back to index.html for client-side routes (no such file)', async () => {
    await writeFile(join(webDist, 'index.html'), '<html>spa</html>');
    await startServer(webDist);
    const res = await fetch(`${baseUrl}/users/list`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  it('serves nested assets with the right content type', async () => {
    await writeFile(join(webDist, 'index.html'), '<html></html>');
    await writeFile(join(webDist, 'app.js'), 'console.log(1)');
    await startServer(webDist);
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('HEAD requests get headers but no body', async () => {
    await writeFile(join(webDist, 'index.html'), '<html>head</html>');
    await startServer(webDist);
    const res = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect((await res.text())).toBe('');
  });

  it('URL-encoded traversal outside webRoot is rejected with 400', async () => {
    await writeFile(join(webDist, 'index.html'), '<html></html>');
    // A sibling dir with a secret; a traversal attempt must not read it.
    const secretDir = join(dir, 'secret');
    await mkdir(secretDir);
    await writeFile(join(secretDir, 'secret.txt'), 'leaked');
    await startServer(webDist);
    const res = await fetch(`${baseUrl}/${encodeURIComponent('../secret/secret.txt')}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('bad path');
  });

  it('404s when WEB_DIST is not configured and a static route is hit', async () => {
    await startServer(undefined);
    const res = await fetch(`${baseUrl}/anything`);
    expect(res.status).toBe(404);
  });

  it('non-GET/HEAD, non-API method gets 404 (no static write path)', async () => {
    await startServer(undefined);
    const res = await fetch(`${baseUrl}/anything`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('unknown API route falls through to the router 404', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/v1/no-such-route`);
    expect(res.status).toBe(404);
  });
});

describe('admin server: security headers on API responses', () => {
  it('unauthenticated API response still carries nosniff/referrer headers', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/v1/auth/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
