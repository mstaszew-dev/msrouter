/**
 * ledger.ts: append-only JSONL ledger of every Director action (proposed,
 * decided, applied, restart, error). One JSON object per line. Atomic appends
 * via O_APPEND + fsync. readPending() computes the open proposals by diffing
 * proposed vs decided entries.
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LedgerEntry, Patch } from './types.js';

export async function appendLedger(path: string, entry: LedgerEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  // O_APPEND is atomic for writes under the pipe-buffer size on local FS.
  const handle = await open(path, 'a');
  try {
    await handle.appendFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readLedger(path: string): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      // Skip malformed line.
    }
  }
  return out;
}

export async function readPending(path: string): Promise<Patch[]> {
  const entries = await readLedger(path);
  const decided = new Set<string>();
  const proposed = new Map<string, Patch>();
  for (const e of entries) {
    if (e.kind === 'decided' && e.patchId) {
      decided.add(e.patchId);
    } else if (e.kind === 'proposed' && e.patch && e.patchId) {
      proposed.set(e.patchId, e.patch);
    }
  }
  return [...proposed.entries()].filter(([id]) => !decided.has(id)).map(([, p]) => p);
}
