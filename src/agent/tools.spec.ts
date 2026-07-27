import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';

import { callTool } from './tools.js';

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('terminal tool', () => {
  it('runs an allowlisted command and returns stdout', async () => {
    loadEnv({ TERMINAL_ALLOWLIST: 'echo' });
    const res = await callTool('terminal', { command: 'echo', args: ['hello'] }, silentLogger);
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('hello');
  });

  it('rejects a command not in the allowlist', async () => {
    loadEnv({ TERMINAL_ALLOWLIST: 'echo' });
    const res = await callTool('terminal', { command: 'rm' }, silentLogger);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not in the allowlist');
  });

  it('returns an error for an unknown tool', async () => {
    const res = await callTool('nope', {}, silentLogger);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('unknown tool');
  });
});
