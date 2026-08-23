import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

import { startWorkerInIterm } from './iterm.js';
import { isCampaignComplete } from './observe.js';
import { detectProcess, detectWorker, snapshot, stopWorker } from './process.js';

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
  orphaned: boolean;
}
export {
  detectProcess,
  detectWorker,
  childrenOf,
  isStartLocked,
  isOrphaned,
  readStartLock,
  stopTree,
  stopWorker,
  snapshot,
} from './process.js';
export {
  __resetKafkaFailureState,
  __resetKafkaSpawnCooldown,
  assertInIterm,
  isInIterm,
  isRunningInIterm,
  startKafkaInIterm,
  startWorkerInIterm,
} from './iterm.js';

export function ensureOverrideFiles(): void {
  const dir = join(homedir(), '.campaign-agent');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const name of ['director-overrides.env', 'director-prompt-overrides.md']) {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, '', { mode: 0o644 });
  }
}

export async function waitForStartup(opts: SuperviseOpts, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const lockPath = join(homedir(), '.campaign-agent', 'agent-start.lock');
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
