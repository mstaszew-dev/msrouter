/**
 * rag.ts: TypeScript client for the Director's Python RAG server. The server
 * (src/director/rag/rag_server.py) runs with --line-protocol, reading one JSON
 * request per line and writing one JSON response per line. This client spawns
 * it once and reuses it. Search results are normalized to RagResult[].
 *
 * The Director-owned index.db is separate from OpenClaw's; no SQLite
 * concurrency with the worker.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';

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
  /** Test seam: inject a fake child process instead of spawning Python. */
  fakeChild?: ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  resolve: (out: unknown) => void;
  reject: (e: Error) => void;
}

export class RagClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly opts: RagClientOpts) {}

  async start(): Promise<void> {
    if (this.child) return;
    if (this.opts.fakeChild) {
      this.child = this.opts.fakeChild;
    } else {
      this.child = spawn(
        this.opts.pythonPath,
        [
          SERVER_PATH,
          '--line-protocol',
          '--db',
          this.opts.dbPath,
          '--campaign',
          this.opts.campaignDir,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], cwd: MODULE_DIR },
      );
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) =>
      this.opts.log.debug({ stderr: chunk.toString() }, 'rag server stderr'),
    );
    this.child.on('exit', (code) => {
      this.opts.log.warn({ code }, 'rag server exited');
      const err = new Error(`rag server exited (code=${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.child = undefined;
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = undefined;
  }

  async ragSearchApps(query: string, k = 5): Promise<RagResult[]> {
    return this.call('rag_search_apps', { query, k });
  }

  async ragSearchDocs(query: string, k = 3): Promise<RagResult[]> {
    return this.call('rag_search_docs', { query, k });
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<RagResult[]> {
    await this.start();
    if (!this.child?.stdin) throw new Error('rag server not started');
    const id = this.nextId++;
    const line = JSON.stringify({ id, tool, args }) + '\n';
    return new Promise<RagResult[]>((resolve, reject) => {
      this.pending.set(id, { resolve: (out) => resolve(out as RagResult[]), reject });
      this.child!.stdin.write(line);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rag call ${tool} timed out`));
        }
      }, 15_000).unref();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let parsed: { id?: number; result?: unknown; error?: string };
      try {
        parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: string };
      } catch {
        continue;
      }
      if (typeof parsed.id === 'number' && this.pending.has(parsed.id)) {
        const p = this.pending.get(parsed.id)!;
        this.pending.delete(parsed.id);
        if (parsed.error) p.reject(new Error(parsed.error));
        else p.resolve(parsed.result);
      }
    }
  }
}

export function parseLineResponse(line: string, _tool: string): RagResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const result = (parsed as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  const out: RagResult[] = [];
  for (const r of result) {
    if (!r || typeof r !== 'object') continue;
    const o = r as { score?: number; text?: string };
    if (typeof o.score === 'number' && typeof o.text === 'string') {
      out.push({ score: o.score, text: o.text });
    }
  }
  return out;
}
