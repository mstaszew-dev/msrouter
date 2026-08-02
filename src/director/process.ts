import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
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
  return { pids, running: pids.length > 0 };
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
