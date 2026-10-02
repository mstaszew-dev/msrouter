/**
 * Factory wiring: the laptop provider's prompt guard must match the model's
 * REAL runtime context. 2026-10-02 audit: the travelmate laptop loads
 * qwen35-2b-64k with num_ctx 8192 (/api/ps context_length), while the guard
 * advertised 100 000 - prompts up to 25x the window were forwarded and
 * silently left-truncated by ollama (the ZCode compacted history sat at the
 * top, exactly where ollama cuts).
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
  it('laptop maxPromptTokens fits the real 8192 runtime context', () => {
    loadEnv({ LAPTOP_ENABLED: 'true' });
    const laptop = buildProviders(silent).laptop as unknown as {
      maxPromptTokens: number;
    };
    expect(laptop.maxPromptTokens).toBeLessThanOrEqual(8000);
  });
});
