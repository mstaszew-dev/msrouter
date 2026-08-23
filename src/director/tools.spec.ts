import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
    expect(names).toEqual([
      'rag_search_apps',
      'rag_search_docs',
      'terminal',
      'web_search',
      'write_prompt_override',
    ]);
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

  it('reports an error result when an allowlisted command fails', async () => {
    // ls on a missing path exits non-zero: execFileP rejects and the catch
    // maps the failure into a ToolResult instead of throwing.
    const res = await callTool(
      'terminal',
      { command: 'ls', args: ['/definitely/not/a/real/path-xyz'] },
      silent,
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/^terminal: /);
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

  it('parses DuckDuckGo HTML results into title/url/snippet', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<a class="result__snippet" href="https://example.com/jobs">Example Jobs</a>' +
        '<a class="result__url">example.com</a>',
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await callTool('web_search', { query: 'java jobs' }, silent);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('duckduckgo.com/html/?q=java%20jobs'),
        expect.any(Object),
      );
      expect(res.isError).not.toBe(true);
      const content = String(res.content);
      expect(content).toContain('Example Jobs');
      expect(content).toContain('https://example.com/jobs');
      expect(content).toContain('example.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns an HTTP error message on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }));
    try {
      const res = await callTool('web_search', { query: 'x' }, silent);
      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain('HTTP 429');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a failure on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')));
    try {
      const res = await callTool('web_search', { query: 'x' }, silent);
      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain('web_search failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stringifies non-Error network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce('socket blew'));
    try {
      const res = await callTool('web_search', { query: 'x' }, silent);
      expect(res.isError).toBe(true);
      expect(String(res.content)).toBe('web_search failed: socket blew');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports no results when the HTML contains none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: true, text: async () => '<html>nothing</html>' }),
    );
    try {
      const res = await callTool('web_search', { query: 'x' }, silent);
      expect(res.isError).not.toBe(true);
      expect(String(res.content)).toContain('no results found');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('reports failure when the override file cannot be written', async () => {
    const mdDir = join(process.env['HOME']!, '.campaign-agent');
    mkdirSync(mdDir, { recursive: true });
    // A directory where the override file should live makes appendFileSync fail.
    mkdirSync(join(mdDir, 'director-prompt-overrides.md'));
    const res = await callTool('write_prompt_override', { text: 'x' }, silent);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('write_prompt_override failed');
  });
});
