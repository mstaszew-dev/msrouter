import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';

import { isStartLocked } from './process.js';

/** Repo root (scripts/kafka.sh lives here). Walks up from this module until
 *  scripts/kafka.sh is found, so it works from both src/ and dist/. */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'scripts', 'kafka.sh'))) return dir;
    dir = dirname(dir);
  }
  // Fallback: validate the path contains the marker before returning it.
  const fallback = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(fallback, 'scripts', 'kafka.sh'))) {
    throw new Error(
      `findRoot() failed: could not locate scripts/kafka.sh from ${fileURLToPath(import.meta.url)}`,
    );
  }
  return fallback;
}
export const MSROUTER_ROOT = findRoot();

export interface iTermOpts {
  entryCommand: string;
  workspace: string;
  log: Logger;
}

function startLockPath(): string {
  return join(homedir(), '.campaign-agent', 'agent-start.lock');
}

function itermScript(first: string, second?: string): string {
  const body = second
    ? `  tell newSess\n    write text "${first}"\n    delay 1\n    write text "${second}"\n  end tell`
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

/**
 * Check if the Kafka broker is already running by testing the fixed port.
 * The pidfile is unreliable (kafka.sh uses nohup, bash exits immediately).
 */
function isKafkaRunning(): boolean {
  try {
    const out = execFileSync('lsof', ['-i', ':19092', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: 'pipe',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Timestamp of last Kafka spawn attempt (module-level cooldown). */
let lastKafkaSpawnAt = 0;
const KAFKA_SPAWN_COOLDOWN_MS = 60_000;

/** Consecutive Kafka start attempts (resets when broker detected running). */
let kafkaConsecutiveFailures = 0;
const KAFKA_BACKOFF_MAX_MS = 30 * 60_000; // 30 minutes cap

/** Exponential backoff: 60s, 120s, 240s, ... capped at 30min. */
function getKafkaBackoffMs(): number {
  const ms = KAFKA_SPAWN_COOLDOWN_MS * Math.pow(2, kafkaConsecutiveFailures);
  return Math.min(ms, KAFKA_BACKOFF_MAX_MS);
}

/** Reset spawn cooldown + failure state (for testing only). */
export function __resetKafkaSpawnCooldown(): void {
  lastKafkaSpawnAt = 0;
}

/** Reset failure state (for testing only). */
export function __resetKafkaFailureState(): void {
  kafkaConsecutiveFailures = 0;
  lastKafkaSpawnAt = 0;
}

export function startWorkerInIterm(opts: iTermOpts): void {
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
      'started campaign worker in iTerm2',
    );
  } catch (e) {
    opts.log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'failed to launch in iTerm2',
    );
    throw new Error(
      'iTerm2 launch failed (is iTerm2 installed and running?). Launch the campaign worker manually.',
    );
  }
}

export function startKafkaInIterm(opts: iTermOpts): void {
  if (isKafkaRunning()) {
    kafkaConsecutiveFailures = 0;
    opts.log.info('Kafka broker already running; skipping spawn');
    return;
  }
  // Cooldown: exponential backoff when Kafka repeatedly fails to start.
  const now = Date.now();
  const backoffMs = getKafkaBackoffMs();
  if (now - lastKafkaSpawnAt < backoffMs) {
    opts.log.info('Kafka spawn cooldown active; skipping');
    return;
  }
  lastKafkaSpawnAt = now;
  // Use start-or-init: if the broker can't start (e.g. KRaft storage wiped
  // from /tmp cleanup), reinitialize KRaft and retry once.
  const script = itermScript(
    `cd ${MSROUTER_ROOT} && bash scripts/kafka.sh start-or-init`,
    `cd ${MSROUTER_ROOT} && bash scripts/kafka.sh monitor`,
  );
  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: 'ignore' });
    kafkaConsecutiveFailures++;
    if (kafkaConsecutiveFailures >= 3) {
      opts.log.warn(
        { failures: kafkaConsecutiveFailures, nextBackoffMs: getKafkaBackoffMs() },
        'Kafka has failed to start multiple times; backing off',
      );
    }
    opts.log.info('started Kafka in iTerm2');
  } catch (e) {
    kafkaConsecutiveFailures++;
    opts.log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'failed to launch Kafka in iTerm2',
    );
    throw new Error(
      'iTerm2 launch failed (is iTerm2 installed and running?). Start Kafka manually.',
    );
  }
}

/** Check if iTerm2 is running as a process (anywhere on the system). */
export function isInIterm(): boolean {
  try {
    const out = execFileSync('pgrep', ['-x', 'iTerm2'], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the CURRENT process has $TERM_PROGRAM === "iTerm.app". WEAK: the
 * variable is inherited env - it survives detachment (nohup/&) and is present
 * in any shell that ever descended from an iTerm tab. Use
 * isItermInAncestry() for the authoritative check. Distinct from isInIterm()
 * which only checks if iTerm2 is installed/running.
 */
export function isRunningInIterm(): boolean {
  return process.env['TERM_PROGRAM'] === 'iTerm.app';
}

/** Process identity snapshot: parent pid + executable name. */
export interface ProcInfo {
  ppid: number;
  comm: string;
}

/**
 * Real lookup via ps (macOS). Returns null when the pid is dead or ps
 * fails - callers treat that as "not an iTerm child" (fail closed).
 */
export function procInfo(pid: number): ProcInfo | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: 'pipe',
    });
    const m = out.trim().split('\n')[0]?.match(/^\s*(\d+)\s+(.+)$/);
    return m ? { ppid: Number(m[1]), comm: m[2]!.trim() } : null;
  } catch {
    return null;
  }
}

/**
 * True when a live iTerm2 process is in this process's PARENT chain. This is
 * the authoritative "launched from an iTerm tab" check. The old TERM_PROGRAM
 * env check was not proof: the variable is inherited env, and run.sh nohups
 * the gateway, which detaches it to launchd within minutes while TERM_PROGRAM
 * stays baked into its env (2026-09-09: the gateway ran fully detached and
 * the env-only guard passed).
 *
 * Fail-closed: a dead ancestor (ps returns nothing) ends the walk as false.
 */
export function isItermInAncestry(
  startPid: number = process.pid,
  lookup: (pid: number) => ProcInfo | null = procInfo,
): boolean {
  let pid = startPid;
  for (let hop = 0; hop < 32; hop++) {
    const info = lookup(pid);
    if (!info) return false;
    if (/iterm/i.test(info.comm)) return true;
    if (info.ppid <= 1) return false;
    pid = info.ppid;
  }
  return false;
}

/**
 * Assert that msrouter was launched from a live iTerm2 session (a live
 * iTerm2 process in the parent chain). Calls process.exit(1) with an
 * actionable message if not. Must be called before any infrastructure is
 * started (Kafka, Chrome, agent tabs).
 */
export function assertInIterm(
  startPid: number = process.pid,
  lookup: (pid: number) => ProcInfo | null = procInfo,
): void {
  if (!isItermInAncestry(startPid, lookup)) {
    const term = process.env['TERM_PROGRAM'] ?? '(unset)';
    console.error(
      `[msrouter] FATAL: no live iTerm2 process found in this process's parent chain ` +
        `(TERM_PROGRAM=${term} is inherited env and is not proof).\n` +
        `Open an iTerm2 tab and run: cd ${MSROUTER_ROOT} && ./scripts/run.sh dev`,
    );
    process.exit(1);
  }
}
