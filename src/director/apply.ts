/**
 * apply.ts: parse + atomically write the director-overrides.env file. This is
 * the single patch surface the Director mutates. Atomic via .pending + rename
 * so a crash mid-write never leaves a half-written overrides file.
 *
 * Format: KEY=VALUE per line, blanks and # comments ignored on read. On write
 * the serializer sorts keys for deterministic diffs in the ledger/git.
 */

import { homedir } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Patch } from './types.js';

/** Expand a leading '~' to the real home dir (the zod default is '~/...'). */
function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export async function readOverrides(rawPath: string): Promise<Record<string, string>> {
  const path = expandTilde(rawPath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function serializeOverrides(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k] ?? ''}`)
    .join('\n')
    .concat('\n');
}

export async function applyPatch(patch: Patch, rawPath: string): Promise<void> {
  const path = expandTilde(rawPath);
  const current = await readOverrides(path);
  const merged = { ...current, ...patch.overrides };
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.pending`;
  await writeFile(pending, serializeOverrides(merged), 'utf8');
  // rename is atomic on POSIX local FS; this is the durability fence.
  await rename(pending, path);
}
