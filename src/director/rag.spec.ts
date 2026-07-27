import { EventEmitter } from 'node:events';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { RagClient, parseLineResponse } from './rag.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

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

/** Minimal fake child process for unit-testing RagClient without spawning Python. */
function fakeChild(): {
  child: NodeJS.EventEmitter & {
    stdout: NodeJS.EventEmitter;
    stderr: NodeJS.EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  emit: (line: string) => void;
  emitExit: (code: number | null) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const outer = new EventEmitter();
  const stdin = { write: vi.fn() };
  (outer as unknown as { stdin: unknown }).stdin = stdin;
  (outer as unknown as { stdout: unknown }).stdout = stdout;
  (outer as unknown as { stderr: unknown }).stderr = stderr;
  (outer as unknown as { kill: unknown }).kill = vi.fn();
  // Attach setEncoding no-op that RagClient calls on stdout.
  (stdout as { setEncoding?: unknown }).setEncoding = vi.fn();
  return {
    child: outer as never,
    emit: (line) => stdout.emit('data', line),
    emitExit: (code) => outer.emit('exit', code),
  };
}

describe('RagClient (fake child)', () => {
  it('round-trips a rag_search_apps call through the line protocol', async () => {
    const fc = fakeChild();
    const client = new RagClient({
      pythonPath: '/fake/python',
      dbPath: '/fake/db',
      campaignDir: '/fake/campaign',
      log: silent,
      fakeChild: fc.child as never,
    });
    const promise = client.ragSearchApps('backend dev', 5);
    // Let start() resolve and the request line get written.
    await Promise.resolve();
    await Promise.resolve();
    expect(fc.child.stdin.write).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fc.child.stdin.write.mock.calls[0]![0])) as {
      id: number;
      tool: string;
      args: { query: string; k: number };
    };
    expect(sent.tool).toBe('rag_search_apps');
    expect(sent.args.query).toBe('backend dev');
    // Simulate the server's response on the same id.
    fc.emit(JSON.stringify({ id: sent.id, result: [{ score: 0.9, text: 'hit' }] }) + '\n');
    const out = await promise;
    expect(out).toEqual([{ score: 0.9, text: 'hit' }]);
    await client.stop();
  });

  it('rejects when the server exits while a request is pending', async () => {
    const fc = fakeChild();
    const client = new RagClient({
      pythonPath: '/fake/python',
      dbPath: '/fake/db',
      campaignDir: '/fake/campaign',
      log: silent,
      fakeChild: fc.child as never,
    });
    const promise = client.ragSearchDocs('x', 3);
    await Promise.resolve();
    await Promise.resolve();
    fc.emitExit(1);
    await expect(promise).rejects.toThrow(/rag server exited/);
  });

  it('splits responses across chunk boundaries', async () => {
    const fc = fakeChild();
    const client = new RagClient({
      pythonPath: '/fake/python',
      dbPath: '/fake/db',
      campaignDir: '/fake/campaign',
      log: silent,
      fakeChild: fc.child as never,
    });
    const promise = client.ragSearchApps('q', 1);
    await Promise.resolve();
    await Promise.resolve();
    const sent = JSON.parse(String(fc.child.stdin.write.mock.calls[0]![0])) as { id: number };
    const full = JSON.stringify({ id: sent.id, result: [{ score: 0.1, text: 't' }] }) + '\n';
    // Emit the response in two chunks split mid-line.
    fc.emit(full.slice(0, 10));
    fc.emit(full.slice(10));
    const out = await promise;
    expect(out).toEqual([{ score: 0.1, text: 't' }]);
  });
});
