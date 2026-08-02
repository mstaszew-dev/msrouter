import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { callTool, toolDefinitions } from './tools.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

describe('toolDefinitions', () => {
  it('exposes terminal + web_search + write_prompt_override', () => {
    const defs = toolDefinitions();
    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual(['terminal', 'web_search', 'write_prompt_override']);
  });
});

describe('callTool: terminal', () => {
  it('rejects unknown command', async () => {
    const res = await callTool('terminal', { command: 'rm', args: ['-rf', '/'] }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('not in the allowlist');
  });

  it('rejects missing command', async () => {
    const res = await callTool('terminal', { command: '' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('not in the allowlist');
  });

  it('accepts allowlisted command (ls)', async () => {
    const res = await callTool('terminal', { command: 'ls', args: ['-la', '/tmp'] }, silent);
    expect(res.isError).not.toBe(true);
    expect(typeof res.content).toBe('string');
    expect(res.content.length).toBeGreaterThan(0);
  });

  it('accepts allowlisted command (echo)', async () => {
    const res = await callTool('terminal', { command: 'echo', args: ['hello'] }, silent);
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('hello');
  });

  it('returns error for unknown tool name', async () => {
    const res = await callTool('unknown_tool', { query: 'x' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('unknown tool');
  });
});

describe('callTool: web_search', () => {
  it('rejects missing query', async () => {
    const res = await callTool('web_search', { query: '' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('query is required');
  });

  it('rejects null query', async () => {
    const res = await callTool('web_search', {}, silent);
    expect(res.isError).toBe(true);
  });
});

describe('callTool: write_prompt_override', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = process.env['HOME']!;
    // Point HOME at a temp dir so we don't pollute the real ~/.campaign-agent
    const tmpHome = mkdtempSync(join(tmpdir(), 'director-tools-home-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('rejects missing text', async () => {
    const res = await callTool('write_prompt_override', { text: '' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('text is required');
  });

  it('appends text to the prompt override file', async () => {
    const res = await callTool('write_prompt_override', { text: 'slow down on Drushim' }, silent);
    expect(res.isError).not.toBe(true);
    const mdPath = join(process.env['HOME']!, '.campaign-agent', 'director-prompt-overrides.md');
    expect(existsSync(mdPath)).toBe(true);
    const content = readFileSync(mdPath, 'utf8');
    expect(content).toContain('slow down on Drushim');
  });

  it('appends multiple entries (does not truncate)', async () => {
    await callTool('write_prompt_override', { text: 'first note' }, silent);
    await callTool('write_prompt_override', { text: 'second note' }, silent);
    const mdPath = join(process.env['HOME']!, '.campaign-agent', 'director-prompt-overrides.md');
    const content = readFileSync(mdPath, 'utf8');
    expect(content).toContain('first note');
    expect(content).toContain('second note');
  });
});
