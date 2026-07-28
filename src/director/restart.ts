/**
 * restart.ts: detect + stop/restart the campaign via iTerm2.
 *
 * The campaign has exactly one entry point: `job-search-agent` (a symlink on
 * PATH; the underlying script file is named run-one-job, which is misleading
 * because it runs the whole campaign, not one job). The Director treats that
 * script as the unit of supervision and always refers to it as job-search-agent.
 * It does NOT micro-manage inner ticks or the openclaw-agent child.
 *
 * Detection: pgrep for `job-search-agent` (catches the symlink invocation
 * whether the user runs it via PATH or via the resolved script path).
 * Stop: SIGTERM each matched PID; the tee'd log + openclaw-agent child go down
 *       with it via process-group semantics.
 * Start: open a new iTerm2 tab and run `job-search-agent` there. Keeps the
 *        campaign in a visible terminal (the user's "in iterm" instruction) and
 *        preserves the per-launch /tmp/campaign-<ts>.log trace.
 *
 * No wrapper script, no pidfile, no direct detached spawn. The campaign stays
 * standalone; job-search-agent is the normal, only entry point.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

export interface SuperviseOpts {
  /** Command name used to launch the campaign (on PATH). Default: job-search-agent. */
  entryCommand: string;
  /** Working directory for the iTerm launch (the openclaw-job-search workspace). */
  workspace: string;
  /** CDP health URL polled after a restart. */
  cdpUrl: string;
  log: Logger;
  /** CDP health-poll timeout in ms (default 30_000). */
  cdpTimeoutMs?: number;
}

export interface SuperviseState {
  /** PIDs of job-search-agent processes currently running (zero or more). */
  pids: number[];
  /** True if at least one job-search-agent process is alive. */
  running: boolean;
}

/**
 * Ensure the Director override files exist. These are read by run-one-job:
 * - .env: env vars (INNER_MAX_FAILS, etc.)
 * - .md: prompt additions (appended to --message)
 */
export function ensureOverrideFiles(): void {
  const dir = join(homedir(), '.openclaw');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const envPath = join(dir, 'director-overrides.env');
  const mdPath = join(dir, 'director-prompt-overrides.md');
  if (!existsSync(envPath)) writeFileSync(envPath, '', { mode: 0o644 });
  if (!existsSync(mdPath)) writeFileSync(mdPath, '', { mode: 0o644 });
}

/** Detect running job-search-agent processes. Returns their PIDs (empty if none). */
export function detectWorker(entryCommand: string): number[] {
  // Match on the entry-command basename; pgrep -f scans the full command line.
  const base = entryCommand.split('/').pop() ?? 'job-search-agent';
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
  const pids = detectWorker(opts.entryCommand);
  return { pids, running: pids.length > 0 };
}

/**
 * Stop the campaign: SIGTERM each job-search-agent PID. The tee'd log +
 * openclaw-agent child go down with it via process-group semantics.
 */
export async function stopWorker(opts: SuperviseOpts): Promise<{ killed: number[] }> {
  const pids = detectWorker(opts.entryCommand);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        opts.log.warn({ pid, err: String(e) }, 'failed to SIGTERM job-search-agent');
      }
    }
  }
  // Wait up to 10s for all of them to clear.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (detectWorker(opts.entryCommand).length === 0) break;
  }
  return { killed: pids };
}

/**
 * Start the campaign in iTerm2 via AppleScript: open a new tab in the current
 * window (or a new window if none) and run the entry command there. The
 * campaign keeps its visible terminal trace + the per-launch
 * /tmp/campaign-<ts>.log tee'd by the underlying run-one-job script.
 *
 * Throws if iTerm2 is unavailable. The actual job-search-agent PID is not
 * knowable from here without a pidfile; the campaign is "started" once pgrep
 * sees it (call waitForStartup).
 */
export function startWorkerInIterm(opts: SuperviseOpts): void {
  const cmd = `cd ${opts.workspace} && ${opts.entryCommand}`;
  // AppleScript: open a new tab in iTerm2 and run the entry command. The cmd
  // has no quotes/backslashes here, but escape minimally for safety.
  const script = `
tell application "iTerm2"
  if (count of windows) = 0 then
    create window with default profile
    set newTab to current session of current window
  else
    tell current window
      set newTab to (create tab with default profile)
    end tell
  end if
  tell newTab
    write text "${cmd}"
  end tell
end tell`;
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: 'ignore' });
    opts.log.info(
      { workspace: opts.workspace, command: opts.entryCommand },
      'started job-search-agent in iTerm2',
    );
  } catch (e) {
    opts.log.error({ err: e instanceof Error ? e.message : String(e) }, 'failed to launch in iTerm2');
    throw new Error(
      'iTerm2 launch failed (is iTerm2 installed and running?). Launch job-search-agent manually.',
    );
  }
}

/** Block until pgrep sees job-search-agent or the timeout elapses. */
export async function waitForStartup(opts: SuperviseOpts, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (detectWorker(opts.entryCommand).length > 0) return true;
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
 * Full restart: stop, start in iTerm2, wait for the worker to register, poll
 * CDP. Returns the final detection state.
 */
export async function restartWorker(opts: SuperviseOpts): Promise<{
  iterm: true;
  state: SuperviseState;
}> {
  ensureOverrideFiles();
  const stopped = await stopWorker(opts);
  if (stopped.killed.length > 0) {
    opts.log.info({ pids: stopped.killed }, 'stopped previous campaign');
  }
  startWorkerInIterm(opts);
  const up = await waitForStartup(opts, opts.cdpTimeoutMs ?? 30_000);
  if (!up) {
    opts.log.warn('job-search-agent did not register via pgrep within timeout');
  }
  const cdp = await pollCdp(opts.cdpUrl, opts.cdpTimeoutMs ?? 30_000);
  if (!cdp) {
    opts.log.warn({ cdpUrl: opts.cdpUrl }, 'CDP did not become healthy; worker may still be starting');
  }
  return { iterm: true, state: snapshot(opts) };
}
