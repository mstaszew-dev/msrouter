import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyPatch, readOverrides, serializeOverrides } from './apply.js';
import type { Patch } from './types.js';

function overridesPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'director-apply-')), 'overrides.env');
}

const patch = (overrides: Record<string, string>): Patch => ({
  id: 'p1',
  createdAt: '2026-07-27T10:00:00Z',
  overrides,
  rationale: 'test',
  risk: 'low',
  classifications: [],
});

describe('readOverrides', () => {
  it('parses KEY=VALUE lines and ignores blanks/comments', async () => {
    const path = overridesPath();
    writeFileSync(path, '# comment\nFOO=bar\n\nBAZ=qux\n');
    expect(await readOverrides(path)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty for a missing file', async () => {
    expect(await readOverrides(overridesPath())).toEqual({});
  });
});

describe('serializeOverrides', () => {
  it('sorts keys and adds a trailing newline', () => {
    const out = serializeOverrides({ B: '2', A: '1' });
    expect(out).toBe('A=1\nB=2\n');
  });
});

describe('applyPatch', () => {
  it('merges overrides onto an existing file', async () => {
    const path = overridesPath();
    writeFileSync(path, 'FOO=old\nKEEP=1\n');
    await applyPatch(patch({ FOO: 'new', ADDED: 'x' }), path);
    expect(readFileSync(path, 'utf8')).toBe('ADDED=x\nFOO=new\nKEEP=1\n');
  });

  it('creates the file if missing', async () => {
    const path = overridesPath();
    await applyPatch(patch({ FIRST: '1' }), path);
    expect(readFileSync(path, 'utf8')).toBe('FIRST=1\n');
  });

  it('leaves no .pending file behind after success', async () => {
    const path = overridesPath();
    await applyPatch(patch({ X: '1' }), path);
    expect(existsSync(`${path}.pending`)).toBe(false);
  });
});
