/**
 * RAG tools exposed to the Director agent loop. The Python server lives once
 * (openclaw-job-search/rag) and owns THE shared index.db - these tests pin
 * that the director queries it through RagClient, never a private copy.
 */
import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ragSearchApps = vi.fn();
const ragSearchDocs = vi.fn();
let lastClientOpts: unknown;

vi.mock('./rag.js', () => ({
  RagClient: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      lastClientOpts = opts;
    }
    ragSearchApps = (...args: unknown[]) => ragSearchApps(...args);
    ragSearchDocs = (...args: unknown[]) => ragSearchDocs(...args);
  },
}));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

import { callTool, toolDefinitions } from './tools.js';

describe('director RAG tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastClientOpts = undefined;
  });

  it('advertises rag_search_apps and rag_search_docs', () => {
    const names = toolDefinitions().map((t) => t.function.name);
    expect(names).toContain('rag_search_apps');
    expect(names).toContain('rag_search_docs');
  });

  it('dispatches rag_search_apps through RagClient and returns JSON hits', async () => {
    ragSearchApps.mockResolvedValue([{ score: 0.9, text: 'Java @ Acme' }]);
    const res = await callTool(
      'rag_search_apps',
      { query: 'java spring tel aviv', k: 3 },
      silent,
    );
    expect(ragSearchApps).toHaveBeenCalledWith('java spring tel aviv', 3);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content)).toEqual({
      result: [{ score: 0.9, text: 'Java @ Acme' }],
    });
    // Consolidation contract: the client targets the canonical RAG checkout;
    // rag.ts applies the shared index.db default at query time (pinned there).
    expect(lastClientOpts).toMatchObject({
      campaignDir: expect.any(String),
    });
    expect((lastClientOpts as { log: unknown }).log).toBeDefined();
  });

  it('dispatches rag_search_docs with the default k', async () => {
    ragSearchDocs.mockResolvedValue([]);
    const res = await callTool('rag_search_docs', { query: 'cv notes' }, silent);
    expect(ragSearchDocs).toHaveBeenCalledWith('cv notes', 3);
    expect(JSON.parse(res.content)).toEqual({ result: [] });
  });

  it('rejects an empty query without spawning python', async () => {
    const res = await callTool('rag_search_apps', { query: '   ' }, silent);
    expect(res.isError).toBe(true);
    expect(ragSearchApps).not.toHaveBeenCalled();
  });
  it('defaults k for rag_search_apps when omitted', async () => {
    ragSearchApps.mockResolvedValue([]);
    await callTool('rag_search_apps', { query: 'x' }, silent);
    expect(ragSearchApps).toHaveBeenCalledWith('x', 5);
  });

});
