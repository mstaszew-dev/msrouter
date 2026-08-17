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
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
export const MSROUTER_ROOT = findRoot();

export interface iTermOpts {
  entryCommand: string;
  workspace: string;
  cdpUrl: string;
  log: Logger;
}

function startLockPath(): string {
  return join(homedir(), '.campaign-agent', 'agent-start.lock');
}

function itermScript(first: string, second?: string): string {
  const body = second
    ? `  tell newSess\n    write text "${first}"\n  end tell\n  tell current window\n    set newTab to (create tab with default profile)\n    tell current session of newTab\n      write text "${second}"\n    end tell\n  end tell`
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
      'started job-search-agent in iTerm2',
    );
    try {
      startKafkaInIterm(opts);
    } catch {
      // best-effort: Kafka startup failure should not prevent agent launch
    }
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

export function startKafkaInIterm(opts: iTermOpts): void {
  const lockPath = join(homedir(), '.campaign-agent', 'kafka-start.lock');
  if (isStartLocked(lockPath)) {
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
