/**
 * JWT issuing/verification for the admin console. Symmetric HS256 signing per
 * the product requirement (single self-contained service; the About page
 * documents the RS256 + refresh-token hardening path for multi-service
 * production use). The verifier pins `algorithms: ['HS256']` so `alg: none`
 * and cross-algorithm confusions are rejected, and iss/aud are enforced.
 * The library owns the clock (iat via Date.now(), exp = iat + ttl).
 */

import jwt from 'jsonwebtoken';

import type { UserRole } from '../shared/schema.js';

const ISSUER = 'msrouter-admin';
const AUDIENCE = 'msrouter-web';

export interface AuthClaims {
  sub: string;
  role: UserRole;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface SignOptions {
  secret: string;
  /** Token lifetime in seconds; may be negative in tests to mint expired tokens. */
  ttlSeconds: number;
}

export interface SignedToken {
  token: string;
  /** ISO-8601 UTC instant at which the token expires. */
  expiresAt: string;
}

export function signToken(claims: { sub: string; role: UserRole }, opts: SignOptions): SignedToken {
  const token = jwt.sign({ role: claims.role }, opts.secret, {
    algorithm: 'HS256',
    subject: claims.sub,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: opts.ttlSeconds,
  });
  // Read back the exp the library stamped into this token we just created.
  const payload = jwt.decode(token) as { exp?: number } | null;
  return {
    token,
    expiresAt: new Date((payload?.exp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

/** Returns the claims for a valid token, or null for any invalid/expired one. */
export function verifyToken(token: string, secret: string): AuthClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string') return null;
    const { sub, role, iss, aud, iat, exp } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
      return null;
    }
    if (role !== 'admin' && role !== 'viewer') return null;
    return { sub, role, iss: iss as string, aud: aud as string, iat, exp };
  } catch {
    return null;
  }
}
