/**
 * Tests for the HS256 JWT token module. Per the product requirement the admin
 * console uses symmetric signing (HS256) for this single-service demo; the
 * verifier pins the algorithm so `alg: none` / cross-algorithm confusions are
 * rejected, and all standard claims are validated.
 */
import { describe, expect, it } from 'vitest';

import { signToken, verifyToken } from './token.js';
import type { AuthClaims } from './token.js';

const SECRET = 'test-secret-0123456789abcdef';
const TTL_SECONDS = 3600;

describe('signToken', () => {
  it('produces a token carrying the expected claims', () => {
    const { token, expiresAt } = signToken(
      { sub: 'demo', role: 'admin' },
      { secret: SECRET, ttlSeconds: TTL_SECONDS },
    );
    const claims = verifyToken(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('demo');
    expect(claims?.role).toBe('admin');
    expect(claims?.iss).toBe('msrouter-admin');
    expect(claims?.aud).toBe('msrouter-web');
    // iat is set by the library clock; exp = iat + ttl.
    expect(claims?.iat).toBeGreaterThan(Math.floor(Date.now() / 1000) - 30);
    expect(claims?.exp).toBe((claims?.iat ?? 0) + TTL_SECONDS);
    expect(new Date(expiresAt).getTime()).toBe((claims?.exp ?? 0) * 1000);
  });
});

describe('verifyToken', () => {
  it('round-trips a valid token', () => {
    const { token } = signToken(
      { sub: 'viewer', role: 'viewer' },
      { secret: SECRET, ttlSeconds: TTL_SECONDS },
    );
    const claims: AuthClaims | null = verifyToken(token, SECRET);
    expect(claims?.sub).toBe('viewer');
  });

  it('rejects an expired token (negative TTL)', () => {
    const { token } = signToken(
      { sub: 'demo', role: 'admin' },
      { secret: SECRET, ttlSeconds: -10 },
    );
    expect(verifyToken(token, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signToken(
      { sub: 'demo', role: 'admin' },
      { secret: 'other-secret', ttlSeconds: TTL_SECONDS },
    );
    expect(verifyToken(token, SECRET)).toBeNull();
  });

  it('rejects garbage and empty strings', () => {
    expect(verifyToken('not-a-jwt', SECRET)).toBeNull();
    expect(verifyToken('', SECRET)).toBeNull();
    expect(verifyToken('a.b.c', SECRET)).toBeNull();
  });

  it('rejects alg-none forgeries', () => {
    // Hand-built unsigned token: header {"alg":"none","typ":"JWT"}.
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forgery = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({
      sub: 'demo',
      role: 'admin',
      iss: 'msrouter-admin',
      aud: 'msrouter-web',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    expect(verifyToken(forgery, SECRET)).toBeNull();
  });
});
