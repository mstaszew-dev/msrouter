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
 * Check if the CURRENT process is running inside an iTerm2 tab.
 * Uses $TERM_PROGRAM which iTerm2 sets to "iTerm.app" on every session.
 * This is distinct from isInIterm() which only checks if iTerm2 is installed/running.
 */
export function isRunningInIterm(): boolean {
  return process.env['TERM_PROGRAM'] === 'iTerm.app';
}

/**
 * Assert that msrouter is running inside iTerm2. Calls process.exit(1) with a
 * clear message if not. Must be called before any infrastructure is started
 * (Kafka, Chrome, agent tabs) so the user gets actionable feedback.
 */
export function assertInIterm(): void {
  if (!isRunningInIterm()) {
    const term = process.env['TERM_PROGRAM'] ?? '(unset)';
    console.error(
      `[msrouter] FATAL: must be launched from iTerm2 (detected TERM_PROGRAM=${term}).\n` +
        `Open iTerm2 and run: node dist/main.js`,
    );
    process.exit(1);
  }
}
