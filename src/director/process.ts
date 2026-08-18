import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { SuperviseOpts, SuperviseState } from './restart.js';

/**
 * Detect running campaign processes: the launcher parent (entryCommand
 * basename, e.g. job-search-agent) AND the python agent child
 * (campaign_agent.main). The python child can outlive its launcher parent
 * (orphaned) when the parent is SIGTERMed without forwarding the signal; it
 * must be detected so a restart never leaves a live duplicate running.
 */
export function detectWorker(entryCommand: string): number[] {
  const base = entryCommand.split('/').pop() ?? 'job-search-agent';
  const pids = detectProcess(base);
  for (const p of detectProcess('campaign_agent.main')) {
    if (!pids.includes(p)) pids.push(p);
  }
  return pids;
}


/** Detect processes by command-line pattern via pgrep. */
export function detectProcess(pattern: string): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Snapshot the supervise state. */
export function snapshot(opts: SuperviseOpts): SuperviseState {
  const pids = detectWorker(opts.entryCommand);
  const running = pids.length > 0;
  // A process is orphaned when its parent is PID 1 (init). This means the
  // terminal tab that launched it was closed but the process survived. An
  // orphaned agent can't be supervised (no terminal for logs, no signal
  // forwarding) and should be killed and restarted in a fresh iTerm tab.
  const orphaned = running && pids.every((p) => isOrphaned(p));
  return { pids, running, orphaned };
}

/**
 * Check if a process is orphaned (parent PID is 1 / init).
 * Orphaned processes survived their terminal tab closing and can't be
 * supervised — the director should kill and restart them in a fresh iTerm tab.
 */
export function isOrphaned(pid: number): boolean {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: 'pipe',
    });
    const ppid = Number.parseInt(out.trim(), 10);
    return ppid === 1;
  } catch {
    return false;
  }
}

/** Direct children of a pid via pgrep -P. */
export function childrenOf(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Kill a set of pids and ALL their descendants (children, grandchildren, ...).
 * SIGTERM first, then SIGKILL any survivors after the grace period. Returns
 * the full list of pids signaled.
 */
export async function stopTree(pids: number[], _log: unknown, graceMs = 2000): Promise<number[]> {
  // Breadth-first collect the whole tree.
  const all: number[] = [];
  const queue = [...pids];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (all.includes(pid)) continue;
    all.push(pid);
    queue.push(...childrenOf(pid));
  }
  // SIGTERM the whole tree.
  for (const pid of all) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ESRCH: already gone */ }
  }
  await sleep(graceMs);
  // SIGKILL survivors (children that ignore SIGTERM or got reparented).
  const survivors = all.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  for (const pid of survivors) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return all;
}

/** Stop the campaign: SIGTERM/SIGKILL the whole process tree (launcher +
 *  python agent + MCP children). */
export async function stopWorker(opts: SuperviseOpts): Promise<{ killed: number[] }> {
  const pids = detectWorker(opts.entryCommand);
  const killed = await stopTree(pids, opts.log);
  // Wait up to 10s for all of them to clear.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (detectWorker(opts.entryCommand).length === 0) break;
  }
  return { killed };
}


/** Read a start lock file. Returns { pid, at } or null if missing/corrupt. */
export function readStartLock(path: string): { pid: number; at: number } | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    const lines = text.split('\n');
    const pid = parseInt(lines[0] ?? '', 10);
    const at = parseInt(lines[1] ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return null;
    return { pid, at };
  } catch {
    return null;
  }
}

/**
 * Is a startup lock currently held by a live process within the TTL?
 * Prevents startWorkerInIterm from spawning a second agent when the Director
 * tick races with a manual start (the agent hasn't registered via pgrep yet
 * but is coming up).
 */
export function isStartLocked(path: string, ttlMs = 60_000): boolean {
  const lock = readStartLock(path);
  if (!lock) return false;
  // Expired lock -> stale, not held.
  if (Date.now() - lock.at > ttlMs) return false;
  // Owner no longer alive -> stale.
  try { process.kill(lock.pid, 0); return true; } catch { return false; }
}
