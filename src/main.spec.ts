vi.mock('dotenv/config', () => ({}));
vi.mock('./config/env.js', () => ({
  config: vi.fn(() => ({ env: {} })),
  loadEnv: vi.fn(() => ({ env: {} })),
}));
vi.mock('./config/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('./director/iterm.js', () => ({
  assertInIterm: vi.fn(),
}));
vi.mock('./gateway/server.js', () => ({
  createGatewayServer: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn((_cb: () => void) => undefined),
  })),
}));
vi.mock('./orchestrator.js', () => ({
  startOrchestrator: vi.fn(() => ({ shutdown: vi.fn() })),
}));
vi.mock('./providers/chain.js', () => ({ ProviderChain: vi.fn() }));
vi.mock('./providers/instances.js', () => ({
  buildProviders: vi.fn(() => ({
    openrouter: { keyCount: 0 },
    openai: { available: false },
    zai: { available: false },
    opencode: { available: false },
  })),
}));

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { assertInIterm } from './director/iterm.js';

describe('main.ts startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls assertInIterm before starting the gateway', async () => {
    await import('./main.js');
    expect(assertInIterm).toHaveBeenCalled();
  });
});
