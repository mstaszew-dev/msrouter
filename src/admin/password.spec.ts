/**
 * Tests for the scrypt password hashing primitive. scrypt is the
 * NODEJS_CODE_REVIEW.md-approved KDF (memory-hard, tuned N/r/p) and runs on
 * the libuv threadpool in its async form, so the event loop is never blocked.
 */
import { describe, expect, it } from 'vitest';

import { SCRYPT_PARAMS, hashPassword, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('returns a self-describing scrypt hash string', async () => {
    const hash = await hashPassword('demo1234');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  it('salts every hash, so equal passwords produce different hashes', async () => {
    const a = await hashPassword('demo1234');
    const b = await hashPassword('demo1234');
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('demo1234');
    await expect(verifyPassword('demo1234', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('demo1234');
    await expect(verifyPassword('wrong-pass', hash)).resolves.toBe(false);
  });

  it('handles unicode passwords', async () => {
    const hash = await hashPassword('p@ssłódevěž');
    await expect(verifyPassword('p@ssłódevěž', hash)).resolves.toBe(true);
    await expect(verifyPassword('p@sslodovez', hash)).resolves.toBe(false);
  });

  it('rejects malformed or tampered hashes without throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$16384$8$1$zz$ff')).resolves.toBe(false);
    const hash = await hashPassword('demo1234');
    const tampered = `${hash.slice(0, -2)}ff`;
    await expect(verifyPassword('demo1234', tampered)).resolves.toBe(false);
  });

  it('uses the documented scrypt parameters', () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 16384, r: 8, p: 1, keyLength: 64 });
  });
});
