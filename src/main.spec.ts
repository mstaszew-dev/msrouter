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

describe('main.ts pidfile parity with run.sh', () => {
  it('writes .run/gateway.pid with the current pid and removes it on shutdown', async () => {
    vi.resetModules();
    const writes: Array<[string, string]> = [];
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      writeFileSync: (p: string, data: string) => {
        writes.push([p, String(data)]);
      },
      mkdirSync: () => undefined,
      rmSync: (p: string) => writes.push(['__rm__', p]),
    }));
    await import('./main.js');
    // Fire 'listening' on the server instance main() created.
    const { createGatewayServer } = await import('./gateway/server.js');
    const server = vi.mocked(createGatewayServer).mock.results.at(-1)!.value as unknown as {
      on: (ev: string, cb: () => void) => void;
    };
    const handlers: Record<string, () => void> = {};
    for (const [ev, cb] of vi.mocked(server.on).mock.calls) {
      handlers[ev] = cb;
    }
    handlers['listening']!();

    const pidLine = writes.find(([p]) => p.endsWith('.run/gateway.pid'));
    expect(pidLine).toBeDefined();
    expect(pidLine![1]).toBe(String(process.pid));

    // SIGTERM -> pidfile removed
    process.emit('SIGTERM');
    expect(writes.some(([p, d]) => p === '__rm__' && d.endsWith('.run/gateway.pid'))).toBe(true);
  });
});
