import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendLedger, readLedger, readPending, readApprovedPatches } from './ledger.js';
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

describe('readApprovedPatches', () => {
  it('returns approved patches that are not yet applied', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'approved', decidedAt: 't2', decidedBy: 'slack' },
    });
    const approved = await readApprovedPatches(path);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.id).toBe('p1');
  });

  it('excludes patches that are rejected', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'rejected', decidedAt: 't2', decidedBy: 'slack' },
    });
    const approved = await readApprovedPatches(path);
    expect(approved).toEqual([]);
  });

  it('excludes patches that are already applied', async () => {
    const path = ledgerPath();
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'approved', decidedAt: 't2', decidedBy: 'slack' },
    });
    await appendLedger(path, { at: 't3', kind: 'applied', patchId: 'p1' });
    const approved = await readApprovedPatches(path);
    expect(approved).toEqual([]);
  });

  it('handles multiple patches with mixed states', async () => {
    const path = ledgerPath();
    // p1: proposed + approved + applied -> excluded
    await appendLedger(path, { at: 't1', kind: 'proposed', patchId: 'p1', patch: samplePatch });
    await appendLedger(path, {
      at: 't2',
      kind: 'decided',
      patchId: 'p1',
      decision: { patchId: 'p1', decision: 'approved', decidedAt: 't2', decidedBy: 'slack' },
    });
    await appendLedger(path, { at: 't3', kind: 'applied', patchId: 'p1' });

    // p2: proposed + approved -> should be returned
    await appendLedger(path, {
      at: 't4',
      kind: 'proposed',
      patchId: 'p2',
      patch: { ...samplePatch, id: 'p2' },
    });
    await appendLedger(path, {
      at: 't5',
      kind: 'decided',
      patchId: 'p2',
      decision: { patchId: 'p2', decision: 'approved', decidedAt: 't5', decidedBy: 'slack' },
    });

    // p3: proposed + rejected -> excluded
    await appendLedger(path, {
      at: 't6',
      kind: 'proposed',
      patchId: 'p3',
      patch: { ...samplePatch, id: 'p3' },
    });
    await appendLedger(path, {
      at: 't7',
      kind: 'decided',
      patchId: 'p3',
      decision: { patchId: 'p3', decision: 'rejected', decidedAt: 't7', decidedBy: 'slack' },
    });

    const approved = await readApprovedPatches(path);
    expect(approved.map((p) => p.id)).toEqual(['p2']);
  });

  it('returns [] on empty ledger', async () => {
    const path = ledgerPath();
    const approved = await readApprovedPatches(path);
    expect(approved).toEqual([]);
  });
});
