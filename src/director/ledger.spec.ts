import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendLedger, readLedger, readPending } from './ledger.js';
import type { Patch } from './types.js';

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'director-ledger-')), 'ledger.jsonl');
}

const samplePatch: Patch = {
  id: 'p1',
  createdAt: '2026-07-27T10:00:00Z',
  overrides: { DIRECTOR_NOTE: 'slow down' },
  rationale: 'too many portal errors',
  risk: 'low',
  classifications: ['c1'],
};

describe('appendLedger + readLedger', () => {
  it('round-trips a single entry', async () => {
    const path = ledgerPath();
    await appendLedger(path, {
      at: '2026-07-27T10:00:00Z',
      kind: 'proposed',
      patchId: 'p1',
      patch: samplePatch,
    });
    const entries = await readLedger(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('proposed');
    expect(entries[0]!.patch?.id).toBe('p1');
  });

  it('preserves order across multiple appends', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'approved', decidedAt: 't2', decidedBy: 'cli:mst' },
    });
    const entries = await readLedger(path);
    expect(entries.map((e) => e.kind)).toEqual(['proposed', 'decided']);
  });

  it('skips malformed lines without throwing', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path, 'not-json\n');
    const entries = await readLedger(path);
    expect(entries).toHaveLength(1);
  });
});

describe('readPending', () => {
  it('returns patches that were proposed but not yet decided', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'proposed',
      patchId: 'p2',
      patch: { ...samplePatch, id: 'p2' },
    });
    const pending = await readPending(path);
    expect(pending.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('excludes patches that have any later decision', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'rejected', decidedAt: 't2', decidedBy: 'cli:mst' },
    });
    await appendLedger(path, {
      at: 't3',
      kind: 'proposed',
      patchId: 'p2',
      patch: { ...samplePatch, id: 'p2' },
    });
    const pending = await readPending(path);
    expect(pending.map((p) => p.id)).toEqual(['p2']);
  });
});
