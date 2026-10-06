import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogFileStream } from './file-log.js';

/**
 * msrouter had stdout-only logging (logger.ts transport), so the live gateway
 * wrote nothing durable: .run/gateway.log went stale and the chain's
 * per-entry failure detail (e.g. the laptop's TRANSIENT(0) fetch message) was
 * unrecoverable. This adds the file half, size-rotated like the python
 * agent's log (5MB x 3).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msrouter-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createLogFileStream', () => {
  it('writes to the target file and creates it', async () => {
    const file = join(dir, 'msrouter.log');
    const s = createLogFileStream(file, 1024, 3);
    s.write('hello\n');
    await s.end();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('hello');
  });

  it('rotates once the size threshold is passed, keeping the newest chunk', async () => {
    const file = join(dir, 'msrouter.log');
    // Tiny threshold so the test does not need megabytes of writes.
    const s = createLogFileStream(file, 64, 3);
    for (let i = 0; i < 20; i++) s.write(`line ${i} padding padding padding\n`);
    await s.end();

    expect(existsSync(`${file}.1`)).toBe(true);
    // The live file holds the most recent writes.
    expect(readFileSync(file, 'utf8')).toContain('line 19');
  });

  it('never keeps more than maxFiles rotated chunks', async () => {
    const file = join(dir, 'msrouter.log');
    const s = createLogFileStream(file, 32, 2);
    for (let i = 0; i < 60; i++) s.write(`entry ${i} padding padding\n`);
    await s.end();

    // maxFiles=2 -> .1 and .2 exist, .3 does not.
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it('truncates on open by default so a restart cannot append to a stale file', async () => {
    const file = join(dir, 'msrouter.log');
    writeFileSync(file, 'STALE FROM LAST RUN\n');
    const s = createLogFileStream(file, 1024, 3);
    s.write('fresh\n');
    await s.end();
    const out = readFileSync(file, 'utf8');
    expect(out).not.toContain('STALE FROM LAST RUN');
    expect(out).toContain('fresh');
  });

  it('reports a non-zero size for the file it opened', async () => {
    const file = join(dir, 'msrouter.log');
    const s = createLogFileStream(file, 1024, 3);
    s.write('data\n');
    await s.end();
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});