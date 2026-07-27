import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { parseLineResponse } from './rag.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;
void silent;

describe('parseLineResponse', () => {
  it('parses a rag_search_apps result line', () => {
    const line = JSON.stringify({
      result: [{ score: 0.92, text: 'Backend Dev @ Acme (drushim, 2026-07-27, submitted)' }],
    });
    const out = parseLineResponse(line, 'rag_search_apps');
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBeCloseTo(0.92);
  });

  it('returns [] when the line is malformed', () => {
    expect(parseLineResponse('not json', 'rag_search_apps')).toEqual([]);
    expect(parseLineResponse('{}', 'rag_search_apps')).toEqual([]);
  });

  it('returns [] when result is not an array', () => {
    expect(parseLineResponse(JSON.stringify({ result: 'nope' }), 'rag_search_apps')).toEqual([]);
  });
});
