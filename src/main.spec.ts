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
    tokenrouter: { available: false },
    opencodego: { available: false },
    extras: {
      unorouter: { available: false },
      groq: { available: true },
      sambanova: { available: false },
      mistral: { available: true },
      cloudflare: { available: true },
    },
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

  it('gateway listening summary includes the extra providers', async () => {
    vi.resetModules(); // re-run main.ts side effects for this test
    await import('./main.js');
    const { createGatewayServer } = await import('./gateway/server.js');
    const { createLogger } = await import('./config/logger.js');
    const server = vi.mocked(createGatewayServer).mock.results[0]!.value as {
      on: (ev: string, cb: () => void) => void;
    };
    const handlers: Record<string, () => void> = {};
    vi.mocked(server.on).mock.calls.forEach(([ev, cb]) => {
      handlers[ev] = cb;
    });
    handlers['listening']!();
    const log = vi.mocked(createLogger).mock.results[0]!.value as {
      info: ReturnType<typeof vi.fn>;
    };
    const call = vi.mocked(log.info).mock.calls.find((args) => args[1] === 'gateway listening')!;
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      groq: true,
      mistral: true,
      cloudflare: true,
      unorouter: false,
    });
  });
});
