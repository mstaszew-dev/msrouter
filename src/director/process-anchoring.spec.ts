/**
 * detectWorker must anchor to a real runner invocation.
 *
 * 2026-10-07 live incident: a monitoring shell whose COMMAND LINE merely
 * CONTAINED 'job-search-agent' (a grep/pgrep invocation) satisfied the
 * unanchored pgrep -f pattern, so the Director believed a worker was running
 * and skipped a needed respawn for two consecutive ticks. Kept in a separate
 * spec file because restart.spec.ts mocks node:child_process; these tests
 * need the real spawn/pgrep.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectWorker } from './process.js';

function atMost(ms: number, fn: () => void): void {
  const deadline = Date.now() + ms;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

describe('detectWorker argv anchoring', () => {
  it('does not match a sleeping shell whose argv merely mentions the runner name', () => {
    const observer = spawn('/bin/zsh', ['-c', 'sleep 5 && echo done # job-search-agent mentioned'], {
      stdio: 'ignore',
    });
    try {
      atMost(2_000, () => {
        const pids = detectWorker('/Users/mst/bin/job-search-agent');
        expect(pids).not.toContain(observer.pid);
      });
    } finally {
      observer.kill('SIGKILL');
    }
  });

  it('still matches the real runner invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detectworker-'));
    const script = join(dir, 'job-search-agent-real');
    writeFileSync(script, '#!/bin/zsh\nsleep 5\n', { mode: 0o755 });
    const real = spawn('/bin/zsh', [script], { stdio: 'ignore' });
    try {
      atMost(2_000, () => {
        const pids = detectWorker(script);
        expect(pids).toContain(real.pid);
      });
    } finally {
      real.kill('SIGKILL');
    }
  });
});
