import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { RagClient as RagClientType } from './rag.js';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('RagClient mocked query paths', () => {
  let RagClient: typeof RagClientType;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ RagClient } = await import('./rag.js'));
  });

  function stubExec(stdout: string, stderr = '') {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout, stderr });
      },
    );
  }

  it('calls log.debug with stderr text when subprocess writes to stderr', async () => {
    stubExec('{"result": []}', 'some warning');
    const client = new RagClient({
      pythonPath: '/usr/bin/python3',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    await client.ragSearchApps('query', 3);
    expect(silent.debug).toHaveBeenCalledWith({ stderr: 'some warning' }, 'rag stderr');
  });

  it('returns [] and logs warn when response contains error key', async () => {
    stubExec('{"error": "no index found"}', '');
    const client = new RagClient({
      pythonPath: '/usr/bin/python3',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchApps('query', 3);
    expect(results).toEqual([]);
    expect(silent.warn).toHaveBeenCalledWith(
      { error: 'no index found' },
      'rag query returned error',
    );
  });

  it('returns [] when JSON has no result key', async () => {
    stubExec('{}', '');
    const client = new RagClient({
      pythonPath: '/usr/bin/python3',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchApps('query', 3);
    expect(results).toEqual([]);
  });

  it('returns result array on successful response', async () => {
    stubExec('{"result": [{"score": 0.9, "text": "match"}]}', '');
    const client = new RagClient({
      pythonPath: '/usr/bin/python3',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchDocs('query', 3);
    expect(results).toEqual([{ score: 0.9, text: 'match' }]);
  });
});

describe('RagClient consolidation defaults', () => {
  let RagClient: typeof RagClientType;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ RagClient } = await import('./rag.js'));
  });

  function stubExec(stdout: string) {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout, stderr: '' });
      },
    );
  }

  it('falls back to the canonical shared RAG paths when optional opts omitted', async () => {
    stubExec('{"result": []}');
    const client = new RagClient({ campaignDir: '/tmp/campaign', log: silent });
    await client.ragSearchApps('dup check', 5);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { timeout: number; maxBuffer: number },
    ];
    // One corpus, one index: the Director must query THE index the agent's
    // dedupe uses, not a private copy.
    expect(cmd).toBe('/Users/mst/ZCodeProject/openclaw-job-search/rag/.venv/bin/python');
    expect(args[0]).toBe('/Users/mst/ZCodeProject/openclaw-job-search/rag/rag_server.py');
    expect(args).toContain('/Users/mst/ZCodeProject/openclaw-job-search/rag/index.db');
    expect(opts.timeout).toBe(30_000);
    expect(opts.maxBuffer).toBe(1024 * 1024);
  });
});
