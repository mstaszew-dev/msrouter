import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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



describe('tilde expansion (DIRECTOR_OVERRIDES default is ~/...)', () => {
  // 2026-09-18 audit: the zod default is '~/.campaign-agent/...' but apply.ts
  // never expanded '~', so approved patches silently wrote into a literal
  // './~/.campaign-agent/' under CWD and never reached the real file.
  it('applyPatch expands a leading ~ to the real home dir', async () => {
    const path = '~/.campaign-agent-tilde-test/overrides.env';
    try {
      await applyPatch(patch({ FOO: 'bar' }), path);
      const real = join(homedir(), '.campaign-agent-tilde-test/overrides.env');
      expect(existsSync(real)).toBe(true);
      expect(await readOverrides(path)).toEqual({ FOO: 'bar' });
    } finally {
      rmSync(join(homedir(), '.campaign-agent-tilde-test'), { recursive: true, force: true });
    }
  });
});
