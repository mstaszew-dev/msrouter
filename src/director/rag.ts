/**
 * rag.ts: One-shot CLI client for the Director's Python RAG. For each query,
 * spawns a Python subprocess, waits for the result, and exits. No persistent
 * server, no line-protocol. Simple and debuggable.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

const execFileP = promisify(execFile);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(MODULE_DIR, 'rag', 'rag_server.py');

export interface RagResult {
  score: number;
  text: string;
}

export interface RagClientOpts {
  pythonPath: string;
  dbPath: string;
  campaignDir: string;
  log: Logger;
}

export class RagClient {
  constructor(private readonly opts: RagClientOpts) {}

  async ragSearchApps(query: string, k = 5): Promise<RagResult[]> {
    return this.query('rag_search_apps', query, k);
  }

  async ragSearchDocs(query: string, k = 3): Promise<RagResult[]> {
    return this.query('rag_search_docs', query, k);
  }

  private async query(tool: string, query: string, k: number): Promise<RagResult[]> {
    try {
      const { stdout, stderr } = await execFileP(
        this.opts.pythonPath,
        [
          SERVER_PATH,
          '--query', query,
          '--tool', tool,
          '--k', String(k),
          '--db', this.opts.dbPath,
          '--campaign', this.opts.campaignDir,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      if (stderr) {
        this.opts.log.debug({ stderr }, 'rag stderr');
      }
      const parsed = JSON.parse(stdout) as { result?: RagResult[]; error?: string };
      if (parsed.error) {
        this.opts.log.warn({ error: parsed.error }, 'rag query returned error');
        return [];
      }
      return parsed.result ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.opts.log.error({ err: msg, tool, query }, 'rag query failed');
      return [];
    }
  }
}
