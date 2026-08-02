/**
 * restart.ts: detect + stop/restart the campaign via iTerm2.
 * Also provides infrastructure health-checking for Playwright MCP, OpenClaw gateway.
 * The campaign entry point is `job-search-agent` (symlink → run-one-job).
 * Detection via pgrep, stop via SIGTERM, start via iTerm AppleScript.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { detectProcess, detectWorker, isStartLocked, readStartLock, snapshot, stopWorker } from './process.js';
export interface SuperviseOpts {
  entryCommand: string;
  workspace: string;
  cdpUrl: string;
  log: Logger;
  cdpTimeoutMs?: number;
}
export interface SuperviseState {
  /** PIDs of job-search-agent processes (zero or more). */
  pids: number[];
  /** True if at least one is alive. */
  running: boolean;
}
/** Ensure the Director override files exist (.env + .md). */
export function ensureOverrideFiles(): void {
  const dir = join(homedir(), '.campaign-agent');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const envPath = join(dir, 'director-overrides.env');
  const mdPath = join(dir, 'director-prompt-overrides.md');
  if (!existsSync(envPath)) writeFileSync(envPath, '', { mode: 0o644 });
  if (!existsSync(mdPath)) writeFileSync(mdPath, '', { mode: 0o644 });
}

/** Process-management helpers (detectProcess, detectWorker, childrenOf,
 * stopTree, stopWorker, snapshot) live in ./process.ts - re-exported here so
 * existing imports keep working. */
export { detectProcess, detectWorker, childrenOf, isStartLocked, readStartLock, stopTree, stopWorker, snapshot } from './process.js';

/** Path for the startup lock (prevents double-spawn during manual/Director races). */
function startLockPath(): string {
  return join(homedir(), '.campaign-agent', 'agent-start.lock');
}

/** Start the campaign in iTerm2 via AppleScript. Throws if iTerm2 unavailable.
 *  Checks a startup lock first to avoid double-spawning when the Director tick
 *  races with a manual start (the agent hasn't registered via pgrep yet). */
export function startWorkerInIterm(opts: SuperviseOpts): void {
  const lockPath = startLockPath();
  if (isStartLocked(lockPath)) {
    opts.log.info('startup lock is held; skipping spawn (another instance is coming up)');
    return;
  }
  // Write the lock so a concurrent caller skips the spawn.
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
  } catch { /* best-effort */ }

  const cmd = `cd ${opts.workspace} && ${opts.entryCommand}`;
  // AppleScript: open a new tab in iTerm2 and run the entry command. The cmd
  // has no quotes/backslashes here, but escape minimally for safety.
  const script = `
tell application "iTerm2"
  if (count of windows) = 0 then
    set newWin to (create window with default profile)
    set newSess to current session of newWin
  else
    tell current window
      set newTab to (create tab with default profile)
      set newSess to current session of newTab
    end tell
  end if
  tell newSess
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
  const lockPath = startLockPath();
  while (Date.now() < deadline) {
    if (detectWorker(opts.entryCommand).length > 0) {
      // Agent registered -> clear the startup lock.
      try { writeFileSync(lockPath, ''); } catch { /* ignore */ }
      return true;
    }
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
/** Launch Chrome with remote debugging if CDP is not reachable. */
export function startChromeCdp(cdpUrl: string, userDataDir?: string): void {
  const port = new URL(cdpUrl).port || '9222';
  const dir = userDataDir ?? join(homedir(), '.playwright-chrome');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const args = [
    chromePath,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const child = spawn(args[0]!, args.slice(1), {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}
/** Ensure Chrome CDP is reachable; launch if not. */
export async function ensureCdpRunning(cdpUrl: string): Promise<void> {
  const ok = await pollCdp(cdpUrl, 5_000);
  if (!ok) {
    startChromeCdp(cdpUrl);
    await sleep(2_000);
  }
}
/** Infrastructure health check result. */
export interface InfraStatus {
  cdpAlive: boolean;
  playwrightMcpAlive: boolean;
  openclawGatewayAlive: boolean;
}
/** Check all infrastructure components needed by the campaign agent.
 *  The OpenClaw gateway is informational only — with --local mode the agent
 *  bypasses it entirely. Only Playwright MCP is critical for browser automation. */
export function checkInfrastructure(): InfraStatus {
  return {
    cdpAlive: detectProcess('chrome.*remote-debugging').length > 0,
    playwrightMcpAlive: detectProcess('playwright/mcp').length > 0,
    openclawGatewayAlive: detectProcess('openclaw.*gateway').length > 0,
  };
}
/**
 * Ensure campaign infrastructure is healthy. If Playwright MCP is missing,
 * restart the campaign to force a clean relaunch. Chrome CDP is handled
 * separately by ensureCdpRunning(). The OpenClaw gateway is optional since
 * the agent now uses --local mode (bypasses gateway entirely).
 * Returns true if a restart was triggered.
 */
export async function ensureInfrastructureHealthy(opts: SuperviseOpts): Promise<boolean> {
  const status = checkInfrastructure();
  const missing: string[] = [];
  if (!status.playwrightMcpAlive) missing.push('playwright-mcp');
  // OpenClaw gateway is NOT critical — agent uses --local mode (HTTP direct to msrouter)
  if (missing.length === 0) return false;
  opts.log.warn({ missing }, 'Campaign infrastructure unhealthy; restarting campaign');
  if (status.cdpAlive) {
    opts.log.info('Chrome CDP is still up; restarting campaign to reinitialize Playwright MCP');
  } else {
    opts.log.info('Chrome CDP is also down; ensureCdpRunning will start it');
  }
  await restartWorker(opts);
  return true;
}
/** VPN rotation helpers (protonVpnConnected, rotateVpnIp, shouldRotateVpn, ...)
 * live in ./vpn.ts - re-exported here so existing imports keep working.
 */
export { protonVpnConnected, protonVpnServer, publicIp, rotateVpnIp, shouldRotateVpn } from './vpn.js';

/** Full restart: stop, start in iTerm2, wait for worker to register, poll CDP. */
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
