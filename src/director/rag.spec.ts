import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';


const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('Director RAG one-shot CLI', () => {
  it('exports RagClient class', async () => {
    const { RagClient } = await import('./rag.js');
    expect(typeof RagClient).toBe('function');
  });

  it('RagClient has ragSearchApps and ragSearchDocs methods', async () => {
    const { RagClient } = await import('./rag.js');
    const client = new RagClient({
      pythonPath: '/bin/echo',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    expect(typeof client.ragSearchApps).toBe('function');
    expect(typeof client.ragSearchDocs).toBe('function');
  });

  it('ragSearchApps returns [] when Python binary does not exist', async () => {
    const { RagClient } = await import('./rag.js');
    const client = new RagClient({
      pythonPath: '/nonexistent/python-binary-9999',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchApps('backend developer', 5);
    expect(results).toEqual([]);
  });

  it('ragSearchDocs returns [] when Python binary does not exist', async () => {
    const { RagClient } = await import('./rag.js');
    const client = new RagClient({
      pythonPath: '/nonexistent/python-binary-9999',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchDocs('portal policy', 3);
    expect(results).toEqual([]);
  });

  it('ragSearchApps returns [] when Python returns invalid JSON', async () => {
    // /bin/echo outputs plain text, not JSON, so JSON.parse will throw
    const { RagClient } = await import('./rag.js');
    const client = new RagClient({
      pythonPath: '/bin/echo',
      dbPath: '/tmp/index.db',
      campaignDir: '/tmp/campaign',
      log: silent,
    });
    const results = await client.ragSearchApps('query', 3);
    expect(results).toEqual([]);
  });
});
