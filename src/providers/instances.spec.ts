/**
 * Factory wiring: the laptop provider's prompt guard must match the model's
 * REAL context window. 2026-10-02: guard 100_000 was wrong twice - against the
 * 8192 num_ctx ollama loaded, and against the model's true 64K window
 * (qwen35-2b-64k). Guard now = 64K minus generation headroom, so the gateway
 * never claims more context than the laptop can hold.
 */
import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';

import { buildProviders } from './instances.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('buildProviders laptop guard', () => {
  it('laptop maxPromptTokens fits the real 64K window minus headroom', () => {
    loadEnv({ LAPTOP_ENABLED: 'true' });
    const laptop = buildProviders(silent).laptop as unknown as {
      maxPromptTokens: number;
    };
    expect(laptop.maxPromptTokens).toBeLessThanOrEqual(61_440);
    expect(laptop.maxPromptTokens).toBeGreaterThan(8_000);
  });
});
