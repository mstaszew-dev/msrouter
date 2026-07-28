/**
 * restart.ts: detect + stop/restart the campaign. The campaign has exactly one
 * entry point, run-one-job (the main script). The Director treats that whole
 * script as the unit of supervision: it does NOT micro-manage inner ticks or
 * the openclaw-agent child.
 *
 * Detection: pgrep for the run-one-job script name (catches the symlink too).
 * Stop: SIGTERM each matched PID, wait for them to clear.
 * Start: spawn run-one-job detached, in its own session, mirroring how it runs
 *        when launched by hand from a terminal.
 *
 * No wrapper script, no pidfile, no iTerm AppleScript. The campaign stays
 * standalone; run-one-job is the normal, only entry point.
 */

import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

export interface SuperviseOpts {
  /** Path to the run-one-job script (the campaign's single entry point). */
  runnerScript: string;
  /** Working directory for the launch (the openclaw-job-search workspace). */
  workspace: string;
  /** CDP health URL polled after a restart. */
  cdpUrl: string;
  log: Logger;
  /** CDP health-poll timeout in ms (default 30_000). */
  cdpTimeoutMs?: number;
}

export interface SuperviseState {
  /** PIDs of run-one-job processes currently running (zero or more). */
  pids: number[];
  /** True if at least one run-one-job process is alive. */
  running: boolean;
}

/** Detect running run-one-job processes. Returns their PIDs (empty if none). */
export function detectWorker(runnerScript: string): number[] {
  // Match on the script basename so the job-search-agent symlink is caught too.
  const base = runnerScript.split('/').pop() ?? 'run-one-job';
  try {
    const out = execFileSync('pgrep', ['-f', base], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits non-zero when no matches; that means "not running".
    return [];
  }
}

/** Snapshot the supervise state. */
export function snapshot(opts: SuperviseOpts): SuperviseState {
  const pids = detectWorker(opts.runnerScript);
  return { pids, running: pids.length > 0 };
}

/**
 * Stop the campaign: SIGTERM each run-one-job PID. The tee'd log + openclaw-agent
 * child go down with it via process-group semantics. Returns the PIDs signalled.
 */
export async function stopWorker(opts: SuperviseOpts): Promise<{ killed: number[] }> {
  const pids = detectWorker(opts.runnerScript);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        opts.log.warn({ pid, err: String(e) }, 'failed to SIGTERM run-one-job');
      }
    }
  }
  // Wait up to 10s for all of them to clear.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (detectWorker(opts.runnerScript).length === 0) break;
  }
  return { killed: pids };
}

/**
 * Start the campaign: spawn run-one-job detached, in its own session, mirroring
 * a manual terminal launch. Stdio goes to /tmp/director-campaign-<ts>.log so
 * the trace is reviewable even though it's not attached to a visible terminal.
 */
export function startWorker(opts: SuperviseOpts): { pid: number; logPath: string } {
  const logPath = `/tmp/director-campaign-${Date.now()}.log`;
  const child = spawn(opts.runnerScript, [], {
    cwd: opts.workspace,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  opts.log.info({ pid: child.pid, logPath, workspace: opts.workspace }, 'started run-one-job');
  return { pid: child.pid ?? -1, logPath };
}

/** Block until pgrep sees run-one-job or the timeout elapses. */
export async function waitForStartup(opts: SuperviseOpts, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (detectWorker(opts.runnerScript).length > 0) return true;
    await sleep(500);
  }
  return false;
}

/** Block until CDP responds or the timeout elapses. */
export async function pollCdp(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/json/version`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

/**
 * Full restart: stop, start run-one-job, wait for it to register, poll CDP.
 * Returns the final detection state.
 */
export async function restartWorker(opts: SuperviseOpts): Promise<{
  pid: number;
  logPath: string;
  state: SuperviseState;
}> {
  const stopped = await stopWorker(opts);
  if (stopped.killed.length > 0) {
    opts.log.info({ pids: stopped.killed }, 'stopped previous campaign');
  }
  const launched = startWorker(opts);
  const up = await waitForStartup(opts, opts.cdpTimeoutMs ?? 30_000);
  if (!up) {
    opts.log.warn('run-one-job did not register via pgrep within timeout');
  }
  const cdp = await pollCdp(opts.cdpUrl, opts.cdpTimeoutMs ?? 30_000);
  if (!cdp) {
    opts.log.warn(
      { cdpUrl: opts.cdpUrl },
      'CDP did not become healthy; worker may still be starting',
    );
  }
  return { pid: launched.pid, logPath: launched.logPath, state: snapshot(opts) };
}
