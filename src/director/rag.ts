/**
 * rag.ts: One-shot CLI client for the Director's Python RAG. For each query,
 * spawns a Python subprocess, waits for the result, and exits. Simple and
 * debuggable.
 *
 * The Python RAG server lives ONCE, in the openclaw-job-search repo, and owns
 * THE shared index.db that the job-search agent's dedupe also queries - one
 * corpus, one index, always consistent. Rebuild it from here:
 *   npm run rag:rebuild
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

const execFileP = promisify(execFile);

export const CANONICAL_RAG_DIR =
  '/Users/mst/ZCodeProject/openclaw-job-search/rag';
const SERVER_PATH = `${CANONICAL_RAG_DIR}/rag_server.py`;
const DEFAULT_PYTHON = `${CANONICAL_RAG_DIR}/.venv/bin/python`;
const DEFAULT_DB = `${CANONICAL_RAG_DIR}/index.db`;

export interface RagResult {
  score: number;
  text: string;
}

export interface RagClientOpts {
  /** Defaults to the canonical RAG venv python. */
  pythonPath?: string;
  /** Defaults to the canonical shared index.db (the agent's dedupe index). */
  dbPath?: string;
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
        this.opts.pythonPath ?? DEFAULT_PYTHON,
        [
          SERVER_PATH,
          '--query', query,
          '--tool', tool,
          '--k', String(k),
          '--db', this.opts.dbPath ?? DEFAULT_DB,
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
