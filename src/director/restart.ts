import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';

import { isCampaignComplete } from './observe.js';
import { detectProcess, detectWorker, isStartLocked, snapshot, stopWorker } from './process.js';

/** Repo root (scripts/kafka.sh lives here). Derived from this module's own
 *  path so the Kafka wrapper never depends on the campaign workspace. */
const MSROUTER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface SuperviseOpts {
  entryCommand: string;
  workspace: string;
  cdpUrl: string;
  log: Logger;
  cdpTimeoutMs?: number;
  campaignDir?: string;
}
export interface SuperviseState {
  pids: number[];
  running: boolean;
}
export {
  detectProcess,
  detectWorker,
  childrenOf,
  isStartLocked,
  readStartLock,
  stopTree,
  stopWorker,
  snapshot,
} from './process.js';

export function ensureOverrideFiles(): void {
  const dir = join(homedir(), '.campaign-agent');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const name of ['director-overrides.env', 'director-prompt-overrides.md']) {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, '', { mode: 0o644 });
  }
}

function startLockPath(): string {
  return join(homedir(), '.campaign-agent', 'agent-start.lock');
}

function itermScript(first: string, second?: string): string {
  const body = second
    ? `  tell newSess\n    write text "${first}"\n  end tell\n  tell current session of (create tab with default profile)\n    write text "${second}"\n  end tell`
    : `  tell newSess\n    write text "${first}"\n  end tell`;
  return `tell application "iTerm2"
  if (count of windows) = 0 then
    set newWin to (create window with default profile)
    set newSess to current session of newWin
  else
    tell current window
      set newTab to (create tab with default profile)
      set newSess to current session of newTab
    end tell
  end if
${body}
end tell`;
}

export function startWorkerInIterm(opts: SuperviseOpts): void {
  const lockPath = startLockPath();
  if (isStartLocked(lockPath)) {
    opts.log.info('startup lock is held; skipping spawn (another instance is coming up)');
    return;
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
  } catch {
    /* best-effort */
  }
  const script = itermScript(`cd ${opts.workspace} && ${opts.entryCommand}`);
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: 'ignore' });
    opts.log.info(
      { workspace: opts.workspace, command: opts.entryCommand },
      'started job-search-agent in iTerm2',
    );
    startKafkaInIterm(opts);
  } catch (e) {
    opts.log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'failed to launch in iTerm2',
    );
    throw new Error(
      'iTerm2 launch failed (is iTerm2 installed and running?). Launch job-search-agent manually.',
    );
  }
}

export function startKafkaInIterm(opts: SuperviseOpts): void {
  const lockPath = join(homedir(), '.campaign-agent', 'kafka-start.lock');
  if (existsSync(lockPath)) {
    opts.log.info('Kafka startup lock is held; skipping spawn');
    return;
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
  } catch {
    /* best-effort */
  }
  const startCmd = `cd ${MSROUTER_ROOT} && bash scripts/kafka.sh start`;
  const monitorCmd = `cd ${MSROUTER_ROOT} && bash scripts/kafka.sh monitor`;
  const script = itermScript(startCmd, monitorCmd);
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: 'ignore' });
    opts.log.info('started Kafka in iTerm2');
  } catch (e) {
    opts.log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'failed to launch Kafka in iTerm2',
    );
    throw new Error(
      'iTerm2 launch failed (is iTerm2 installed and running?). Start Kafka manually.',
    );
  }
}

export async function waitForStartup(opts: SuperviseOpts, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const lockPath = startLockPath();
  while (Date.now() < deadline) {
    if (detectWorker(opts.entryCommand).length > 0) {
      try {
        writeFileSync(lockPath, '');
      } catch {
        /* ignore */
      }
      return true;
    }
    await sleep(500);
  }
  return false;
}

export async function pollCdp(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

export function startChromeCdp(cdpUrl: string, userDataDir?: string): void {
  const port = new URL(cdpUrl).port || '9222';
  const dir = userDataDir ?? join(homedir(), '.playwright-chrome');
  const args = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const child = spawn(args[0]!, args.slice(1), { stdio: 'ignore', detached: true });
  child.unref();
}

export async function ensureCdpRunning(cdpUrl: string): Promise<void> {
  const ok = await pollCdp(cdpUrl, 5_000);
  if (!ok) {
    startChromeCdp(cdpUrl);
    await sleep(2_000);
  }
}

export interface InfraStatus {
  cdpAlive: boolean;
  playwrightMcpAlive: boolean;
  openclawGatewayAlive: boolean;
}

export function checkInfrastructure(): InfraStatus {
  return {
    cdpAlive: detectProcess('chrome.*remote-debugging').length > 0,
    playwrightMcpAlive: detectProcess('playwright/mcp').length > 0,
    openclawGatewayAlive: detectProcess('openclaw.*gateway').length > 0,
  };
}

export async function ensureInfrastructureHealthy(opts: SuperviseOpts): Promise<boolean> {
  if (opts.campaignDir && (await isCampaignComplete(opts.campaignDir))) {
    opts.log.info('Campaign target met; skipping infrastructure health restart');
    return false;
  }
  const status = checkInfrastructure();
  const missing: string[] = [];
  if (!status.playwrightMcpAlive) missing.push('playwright-mcp');
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

export { protonVpnConnected, publicIp, rotateVpnIp, shouldRotateVpn } from './vpn.js';

export async function restartWorker(
  opts: SuperviseOpts,
): Promise<{ iterm: true; state: SuperviseState }> {
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
    opts.log.warn(
      { cdpUrl: opts.cdpUrl },
      'CDP did not become healthy; worker may still be starting',
    );
  }
  return { iterm: true, state: snapshot(opts) };
}

export function isInIterm(): boolean {
  try {
    const out = execFileSync('pgrep', ['-x', 'iTerm2'], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
