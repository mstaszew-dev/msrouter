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
