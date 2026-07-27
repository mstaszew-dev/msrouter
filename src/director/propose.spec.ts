import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { parseProposeResponse, propose } from './propose.js';
import type { CampaignSnapshot, DecisionClassification } from './types.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const snap: CampaignSnapshot = {
  fetchedAt: 't',
  tracker: { submitted: 100, target: 1200, queueLength: 0, updatedAt: 't' },
  recentEvents: [],
  tickStatus: '',
};

const classifications: DecisionClassification[] = [
  {
    kind: 'portal-error',
    severity: 'warn',
    reason: 'captcha loops on JobMaster',
    evidence: 'captcha',
  },
];

/**
 * Build a chain stub. `inner` is the model's `message.content` payload
 * (typically a JSON string the parser expects), OR a pre-shaped chat-completion
 * object if you pass `{ rawChatObject: true }`.
 */
function makeChain(inner: string | object): { chain: { handle: ReturnType<typeof vi.fn> } } {
  const content = typeof inner === 'string' ? inner : JSON.stringify(inner);
  return {
    chain: {
      handle: vi.fn(async () => ({
        response: new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
        }),
        servedBy: { provider: 'test', model: 'test' },
      })),
    },
  };
}

describe('parseProposeResponse', () => {
  it('parses a valid patches array', () => {
    const raw = JSON.stringify({
      patches: [{ overrides: { JOBMASTER_DELAY_MS: '5000' }, rationale: 'slow down', risk: 'low' }],
    });
    const out = parseProposeResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.overrides).toEqual({ JOBMASTER_DELAY_MS: '5000' });
    expect(out[0]!.id).toMatch(/^[0-9a-f-]{36}$/i); // uuid
  });

  it('rejects keys that are not env-var-shaped', () => {
    const raw = JSON.stringify({
      patches: [{ overrides: { 'bad-key': 'x' }, rationale: 'r', risk: 'low' }],
    });
    expect(parseProposeResponse(raw)).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseProposeResponse('not json')).toEqual([]);
    expect(parseProposeResponse('{}')).toEqual([]);
  });
});

describe('propose', () => {
  it('returns patches from a successful model call', async () => {
    const { chain } = makeChain({
      patches: [{ overrides: { SLEEP_MS: '2000' }, rationale: 'r', risk: 'low' }],
    });
    const overridesPath = join(mkdtempSync(join(tmpdir(), 'p-')), 'overrides.env');
    writeFileSync(overridesPath, 'EXISTING=1\n');
    const out = await propose(snap, classifications, {
      chain: chain as never,
      overridesPath,
      model: 'mst/free',
      log: silent,
      signal: new AbortController().signal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.overrides).toEqual({ SLEEP_MS: '2000' });
  });

  it('returns [] when the model returns no patches', async () => {
    const { chain } = makeChain({ patches: [] });
    const out = await propose(snap, [], {
      chain: chain as never,
      overridesPath: '/tmp/none.env',
      model: 'mst/free',
      log: silent,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when the chain throws', async () => {
    const chain = {
      handle: vi.fn(async () => {
        throw new Error('upstream down');
      }),
    };
    const out = await propose(snap, classifications, {
      chain: chain as never,
      overridesPath: '/tmp/none.env',
      model: 'mst/free',
      log: silent,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([]);
  });
});
