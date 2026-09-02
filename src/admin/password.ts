/**
 * scrypt password hashing (NODEJS_CODE_REVIEW.md section 4: memory-hard KDF,
 * never SHA-family or MD5). The hash string is self-describing
 * (`scrypt$N$r$p$salt$key`) so parameters can be tuned later without
 * invalidating stored hashes. The async scrypt form runs on the libuv
 * threadpool and never blocks the event loop; comparison is constant-time.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Tuned scrypt cost (OWASP-recommended floor for interactive logins). */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 64 } as const;

/** maxmem must cover N * 2 * r * p * r with headroom or scrypt throws. */
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  const nRaw = parts[1];
  const rRaw = parts[2];
  const pRaw = parts[3];
  const saltHex = parts[4];
  const keyHex = parts[5];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  if (!nRaw || !rRaw || !pRaw || !saltHex || !keyHex) return false;
  const N = Number(nRaw);
  const R = Number(rRaw);
  const P = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  if (!isHex(saltHex) || !isHex(keyHex) || keyHex.length === 0) return false;
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length === 0 || salt.length !== saltHex.length / 2) return false;
  try {
    const key = await scrypt(password, salt, keyHex.length / 2, {
      N,
      r: R,
      p: P,
      maxmem: 128 * N * R * 2,
    });
    const storedKey = Buffer.from(keyHex, 'hex');
    return key.length === storedKey.length && timingSafeEqual(key, storedKey);
  } catch {
    // Impossible cost parameters (or OOM guard) -> not a hash we produced.
    return false;
  }
}

function isHex(s: string | undefined): boolean {
  return s !== undefined && /^[0-9a-f]*$/.test(s);
}
