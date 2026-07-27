/**
 * restart.ts: restart the OpenClaw worker via a pidfile wrapper. The wrapper
 * (~/.openclaw/director-launch) writes the pidfile on start and execs
 * run-one-job. The Director kills via the pidfile, then re-launches via the
 * wrapper, then polls CDP health before returning.
 *
 * No pkill by pattern (non-deterministic). The wrapper is the contract.
 */

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

export interface RestartOpts {
  pidfile: string;
  runner: string;
  workspace: string;
  cdpUrl: string;
  log: Logger;
}

export async function killWorkerByPidfile(
  pidfile: string,
): Promise<{ killed: number; pid?: number }> {
  let raw: string;
  try {
    raw = await readFile(pidfile, 'utf8');
  } catch {
    return { killed: 0 };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { killed: 0 };
  // Verify the pid is a live process BEFORE signalling. macOS sometimes
  // accepts signals to out-of-range pids without raising ESRCH, so we cannot
  // rely on the SIGTERM throw alone. If the pid is already gone (or we lack
  // permission), do not claim a kill.
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return { killed: 0 };
    return { killed: 0 }; // EPERM etc.: cannot manage this pid.
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return { killed: 0 };
  }
  // Wait up to 5s for the process to exit.
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      // Process is gone. Best-effort remove the stale pidfile.
      await unlink(pidfile).catch(() => {});
      return { killed: 1, pid };
    }
    await sleep(100);
  }
  return { killed: 0, pid };
}

export async function launchWorker(
  runner: string,
  workspace: string,
): Promise<{ pid: number; logPath: string }> {
  const logPath = `/tmp/director-worker-${Date.now()}.log`;
  const child = spawn(runner, [], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid ?? -1, logPath };
}

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

export async function restartWorker(opts: RestartOpts): Promise<{ pid: number; logPath: string }> {
  const killed = await killWorkerByPidfile(opts.pidfile);
  if (killed.killed) {
    opts.log.info({ pid: killed.pid }, 'killed previous worker');
  }
  const launched = await launchWorker(opts.runner, opts.workspace);
  opts.log.info({ pid: launched.pid }, 'launched new worker');
  const healthy = await pollCdp(opts.cdpUrl);
  if (!healthy) {
    opts.log.warn(
      { cdpUrl: opts.cdpUrl },
      'CDP did not become healthy; worker may still be starting',
    );
  }
  return launched;
}
