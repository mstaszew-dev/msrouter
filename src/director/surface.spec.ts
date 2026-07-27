import type pino from 'pino';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readLedger } from './ledger.js';
import { NullSurface } from './surface.js';
import type { Patch } from './types.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const samplePatch: Patch = {
  id: 'p1',
  createdAt: '2026-07-27T10:00:00Z',
  overrides: { X: '1' },
  rationale: 'r',
  risk: 'low',
  classifications: [],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'director-surface-')), 'ledger.jsonl');
}

describe('NullSurface', () => {
  it('postProposal writes a proposed ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postProposal(samplePatch);
    const entries = await readLedger(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'proposed', patchId: 'p1' });
  });

  it('postDecision writes a decided ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postDecision({
      patchId: 'p1',
      decision: 'approved',
      decidedAt: 't',
      decidedBy: 'null-surface',
    });
    const entries = await readLedger(path);
    expect(entries[0]).toMatchObject({ kind: 'decided' });
  });

  it('postApplied writes an applied ledger entry', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postApplied(samplePatch);
    expect((await readLedger(path))[0]).toMatchObject({ kind: 'applied', patchId: 'p1' });
  });

  it('postRestart writes a restart ledger entry with pid', async () => {
    const path = ledgerPath();
    const s = new NullSurface({ ledgerPath: path, log: silent });
    await s.postRestart({ pid: 12345, logPath: '/tmp/x.log' });
    expect((await readLedger(path))[0]).toMatchObject({ kind: 'restart' });
  });
});
