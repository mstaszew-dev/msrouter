/**
 * Provider-factory wiring tests for the laptop slot.
 *
 * The laptop slot targets the travelmate's tailnet Ollama (Qwen3.5 2B, single
 * slot) since 2026-09-27. Policy (user, 2026-09-27): large contexts and slow
 * responses are preferable to no response when every remote is down, so the
 * prompt guard only enforces the server's 131072-token context window minus
 * headroom (pinned at 100K); it must NOT reject big cache-warm conversations.
 */
import type pino from 'pino';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env.js';

import { buildProviders } from './instances.js';
import type { ProviderCallResult } from './types.js';

// Minimal pino stand-in (no logger dep); vitest isolates spec files, so the
// loadEnv() below replacing the module-cached env only affects this file.
const silent = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as pino.Logger;

/** Port 9 (discard) refuses instantly: a request that passes the guard fails
 *  as a network error instead of the guard's BAD_REQUEST. */
const UNROUTABLE_BASE = 'http://127.0.0.1:9/v1';

function attemptWith(promptChars: number): Promise<ProviderCallResult> {
  loadEnv({
    ...process.env,
    LAPTOP_ENABLED: 'true',
    LAPTOP_BASE_URL: UNROUTABLE_BASE,
    LAPTOP_MODEL: 'qwen35-2b-64k',
  });
  const laptop = buildProviders(silent).laptop;
  return laptop.attempt(
    {
      model: 'qwen35-2b-64k',
      messages: [{ role: 'user', content: 'x'.repeat(promptChars) }],
    },
    new AbortController().signal,
    { model: 'qwen35-2b-64k' },
  );
}

describe('laptop slot prompt guard (large-context policy)', () => {
  it('admits a ~90K-token prompt (large contexts allowed by policy)', async () => {
    const res = await attemptWith(90_000 * 4);
    expect(res.kind).not.toBe('BAD_REQUEST');
  });

  it('fast-fails a prompt beyond the 100K window guard', async () => {
    const res = await attemptWith(110_000 * 4);
    expect(res.kind).toBe('BAD_REQUEST');
    const msg = (res as { message: string }).message;
    expect(msg).toContain('max 100000');
  });
});
