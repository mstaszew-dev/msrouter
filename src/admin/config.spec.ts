/**
 * Boundary tests for the admin process env parsing.
 */
import { describe, expect, it } from 'vitest';

import { parseAdminEnv } from './config.js';

const base = { JWT_SECRET: 'secret-0123456789abcdef' } as Record<string, string>;

describe('parseAdminEnv', () => {
  it('applies documented defaults', () => {
    const env = parseAdminEnv(base);
    expect(env.ADMIN_PORT).toBe(8790);
    expect(env.USERS_FILE).toBe('data/users.json');
    expect(env.JWT_TTL_SECONDS).toBe(8 * 3600);
    expect(env.GATEWAY_URL).toBe('http://127.0.0.1:8787');
    expect(env.WEB_DIST).toBeUndefined();
  });

  it('overrides via environment values and coerces numbers', () => {
    const env = parseAdminEnv({
      ...base,
      ADMIN_PORT: '9001',
      USERS_FILE: '/tmp/users.json',
      JWT_TTL_SECONDS: '60',
      GATEWAY_URL: 'http://localhost:9999',
      WEB_DIST: 'web/dist',
    });
    expect(env.ADMIN_PORT).toBe(9001);
    expect(env.JWT_TTL_SECONDS).toBe(60);
    expect(env.GATEWAY_URL).toBe('http://localhost:9999');
    expect(env.WEB_DIST).toBe('web/dist');
  });

  it('rejects a missing JWT_SECRET in production', () => {
    expect(() => parseAdminEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => parseAdminEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects known placeholder secrets in production', () => {
    expect(() =>
      parseAdminEnv({ NODE_ENV: 'production', JWT_SECRET: 'change-me-to-a-long-random-string' }),
    ).toThrow(/JWT_SECRET/);
    expect(() => parseAdminEnv({ NODE_ENV: 'production', JWT_SECRET: 'secret' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('reports a dev-fallback secret instead of throwing outside production', () => {
    const env = parseAdminEnv({ NODE_ENV: 'development' });
    expect(env.JWT_SECRET).not.toBe('');
    expect(env.jwtSecretEphemeral).toBe(true);
  });

  it('rejects non-numeric ports', () => {
    expect(() => parseAdminEnv({ ...base, ADMIN_PORT: 'http' })).toThrow();
  });
});
