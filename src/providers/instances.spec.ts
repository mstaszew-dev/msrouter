/**
 * Provider-factory wiring tests for the laptop slot.
 *
 * The laptop slot targets the travelmate's tailnet Ollama (Qwen3.5 2B, 64K
 * context) since 2026-09-27; the prompt-token guard must admit prompts that
 * fit that window and fast-fail larger ones with the pinned budget.
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
    LAPTOP_MODEL: 'qwen35-2b-64k:latest',
  });
  const laptop = buildProviders(silent).laptop;
  return laptop.attempt(
    {
      model: 'qwen35-2b-64k:latest',
      messages: [{ role: 'user', content: 'x'.repeat(promptChars) }],
    },
    new AbortController().signal,
    { model: 'qwen35-2b-64k:latest' },
  );
}

describe('laptop slot prompt guard (64K tailnet model)', () => {
  it('admits a ~45K-token prompt (over the old 32K budget, under the new one)', async () => {
    const res = await attemptWith(45_000 * 4);
    expect(res.kind).not.toBe('BAD_REQUEST');
  });

  it('fast-fails a ~70K-token prompt with the pinned 52K budget', async () => {
    const res = await attemptWith(70_000 * 4);
    expect(res.kind).toBe('BAD_REQUEST');
    const msg = (res as { message: string }).message;
    expect(msg).toContain('max 52000');
  });
});
