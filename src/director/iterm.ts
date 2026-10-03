import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import { isStartLocked } from './process.js';

const execFileP = promisify(execFile);

/** Expand a leading `~` so KAFKA_HOME can be configured the way .env writes it.
 *  Without this, join() keeps the literal tilde and execFile fails ENOENT,
 *  which reads as "Kafka is down" and re-spawns duplicate tabs. */
function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p;
}

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

/** Options shared by every iTerm launcher. */
export interface iTermOpts {
  entryCommand: string;
  workspace: string;
  log: Logger;
}

/**
 * Kafka adds two REQUIRED fields: they are the single source of truth for which
 * port to probe, and an optional field with a hardcoded default was exactly how
 * the 19092-vs-KAFKA_PORT divergence shipped. Making them required means the
 * compiler rejects any future caller that forgets to pass the loaded env.
 */
export interface KafkaItermOpts extends iTermOpts {
  kafkaBootstrap: string;
  kafkaHome: string;
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
 * Check if the Kafka broker is already running.
 *
 * Two bugs fixed 2026-10-03 (this is what let duplicate broker+monitor tabs pile
 * up in iTerm):
 *
 *  1. The port was HARDCODED to 19092 while kafka.sh honours KAFKA_PORT. On a
 *     non-default port the Director watched a port nobody listened on, decided
 *     Kafka was down, and spawned a fresh tab on every tick - while the real
 *     broker ran happily on its configured port. The port now comes from the
 *     bootstrap address the rest of the app uses.
 *  2. A bound socket was taken as "broker running". Any listener (nc, a stray
 *     JVM, another app) satisfied the old check, so a hijacked port looked
 *     healthy and the real broker was never started. Detection now requires a
 *     Kafka topic API to answer, which is the same readiness proof kafka.sh
 *     itself uses.
 *
 * `bootstrap` is host:port as configured (KAFKA_BOOTSTRAP); only the port is
 * probed locally, which matches kafka.sh binding 0.0.0.0.
 *
 * ASYNC ON PURPOSE (2026-10-03): the Director loop runs inside the gateway
 * process, so a synchronous probe here freezes the Node event loop and stalls
 * every in-flight SSE streaming response. kafka-topics.sh is a JVM: measured on
 * this box, an unbounded `--list` against a dead broker takes 61s, and even a
 * healthy one pays full JVM startup on every tick. The cheap lsof probe
 * short-circuits first (~65ms) and only a held port pays for the JVM call.
 */
export async function isKafkaRunningWith(bootstrap: string, kafkaHome: string): Promise<boolean> {
  const addr = bootstrap.trim();
  const port = addr.slice(addr.lastIndexOf(':') + 1);
  if (!/^\d+$/.test(port)) {
    return false; // unparseable bootstrap: never claim Kafka is up
  }
  let listener: string;
  try {
    const out = await execFileP('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    // promisify(execFile) resolves to { stdout, stderr } when the child_process
    // promisify.custom symbol is present (real Node), and to the raw callback's
    // 2nd argument otherwise. Both shapes appear depending on how execFile is
    // provided, so accept either rather than trusting one.
    listener = typeof out === 'string' ? out : out.stdout;
  } catch {
    return false;
  }
  if (!listener || listener.trim().length === 0) return false;
  // Something holds the port. Only a real broker counts as running.
  const topics = join(expandHome(kafkaHome), 'bin', 'kafka-topics.sh');
  try {
    await execFileP(topics, ['--bootstrap-server', addr, '--list'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1 << 20,
    });
    return true;
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

export async function startKafkaInIterm(opts: KafkaItermOpts): Promise<void> {
  if (
    await isKafkaRunningWith(opts.kafkaBootstrap, opts.kafkaHome)
  ) {
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
