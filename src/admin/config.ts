/**
 * Admin process configuration, parsed with zod so the process fails fast at
 * boot on malformed values (same policy as src/config/env.ts). Kept separate
 * from the gateway env so the console can boot without any provider keys.
 *
 * JWT_SECRET is required and must be long enough in production; outside
 * production a random ephemeral secret is generated per boot (dev convenience,
 * flagged via `jwtSecretEphemeral` so the server can warn loudly).
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADMIN_PORT: z.coerce.number().int().positive().default(8790),
  JWT_SECRET: z.string().default(''),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3600),
  USERS_FILE: z.string().default('data/users.json'),
  WEB_DIST: z.string().optional(),
  GATEWAY_URL: z.string().url().default('http://127.0.0.1:8787'),
});

export interface AdminEnv extends z.infer<typeof schema> {
  jwtSecretEphemeral: boolean;
}

const MIN_SECRET_LENGTH = 16;

/** Publicly known values that must never sign production tokens. */
const KNOWN_PLACEHOLDERS = [/^change-me/i, /^secret$/, /^password$/i, /^my-?secret/i];

export function parseAdminEnv(input: Record<string, string | undefined> = process.env): AdminEnv {
  const parsed = schema.parse(input);
  const isProd = parsed.NODE_ENV === 'production';
  let jwtSecretEphemeral = false;
  if (!parsed.JWT_SECRET) {
    if (isProd) {
      throw new Error('JWT_SECRET is required in production (set it in .env)');
    }
    parsed.JWT_SECRET = randomBytes(32).toString('hex');
    jwtSecretEphemeral = true;
  } else if (isProd && parsed.JWT_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production`);
  } else if (
    isProd &&
    KNOWN_PLACEHOLDERS.some((re) => re.test(parsed.JWT_SECRET))
  ) {
    throw new Error('JWT_SECRET is a well-known placeholder; generate a random secret for production');
  }
  return { ...parsed, jwtSecretEphemeral };
}
