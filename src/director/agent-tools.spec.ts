import { describe, expect, it, vi } from 'vitest';

import { callTool, toolDefinitions } from './agent-tools.js';

const silent = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('agent-tools', () => {
  it('toolDefinitions returns read-only tools (terminal + web_search) by default', () => {
    const defs = toolDefinitions();
    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual(['terminal', 'web_search']);
  });

  it('toolDefinitions includes write_prompt_override in write mode', () => {
    const defs = toolDefinitions('write');
    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual(['terminal', 'web_search', 'write_prompt_override']);
  });

  it('callTool dispatches terminal', async () => {
    const res = await callTool('terminal', { command: 'echo', args: ['hi'] }, silent);
    expect(res.isError).not.toBe(true);
    expect(String(res.content)).toContain('hi');
  });

  it('callTool dispatches web_search', async () => {
    const res = await callTool('web_search', { query: '' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('query is required');
  });

  it('callTool dispatches write_prompt_override', async () => {
    const res = await callTool('write_prompt_override', { text: 'test' }, silent);
    expect(res.isError).not.toBe(true);
    expect(String(res.content)).toContain('appended');
  });

  it('callTool returns error for unknown tool', async () => {
    const res = await callTool('unknown_tool', {}, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('unknown tool');
  });
});
