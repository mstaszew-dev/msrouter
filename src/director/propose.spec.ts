import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { parseProposeResponse, propose } from './propose.js';
import type { CampaignSnapshot, DecisionClassification } from './types.js';

// Steer readPrompt(): make reading prompt.md fail so the built-in fallback
// system prompt kicks in; every other fs path stays real.
const promptState = vi.hoisted(() => ({ fail: false }));

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:fs')>();
  const realRead = actual.readFileSync.bind(actual);
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
      if (promptState.fail && String(path).endsWith('prompt.md')) {
        throw new Error('prompt.md unavailable');
      }
      return realRead(path, options as never);
    }) as typeof actual.readFileSync,
  };
});

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

  it('returns [] for non-object JSON payloads', () => {
    expect(parseProposeResponse('42')).toEqual([]);
    expect(parseProposeResponse('"str"')).toEqual([]);
    expect(parseProposeResponse('null')).toEqual([]);
  });

  it('skips patch entries that are null or lack valid overrides', () => {
    const raw = JSON.stringify({
      patches: [
        null,
        'nope',
        { overrides: null },
        { overrides: 'not-an-object' },
        { overrides: {} }, // no entries -> empty clean map -> skipped
      ],
    });
    expect(parseProposeResponse(raw)).toEqual([]);
  });

  it("defaults rationale to '' and coerces out-of-range risk to low", () => {
    const raw = JSON.stringify({
      patches: [
        { overrides: { A: '1' }, rationale: 42, risk: 'extreme' },
        { overrides: { B: '2' }, risk: 'medium' },
        { overrides: { C: '3' }, risk: 'high' },
      ],
    });
    const out = parseProposeResponse(raw);
    expect(out.map((p) => p.rationale)).toEqual(['', '', '']);
    expect(out.map((p) => p.risk)).toEqual(['low', 'medium', 'high']);
  });

  it('rejects overrides whose values are not strings', () => {
    const raw = JSON.stringify({
      patches: [{ overrides: { GOOD_KEY: 'ok', NUMERIC_KEY: 7 } }],
    });
    expect(parseProposeResponse(raw)).toEqual([]);
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

  it('treats a choice-less model response as no patches', async () => {
    const chain = {
      handle: vi.fn(async () => ({
        response: new Response(JSON.stringify({}), { status: 200 }),
        servedBy: { provider: 'test', model: 'test' },
      })),
    };
    const out = await propose(snap, [], {
      chain: chain as never,
      overridesPath: '/tmp/none.env',
      model: 'mst/free',
      log: silent,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([]);
  });

  it('stringifies non-Error chain failures into the warn log', async () => {
    const chain = {
      handle: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error failure branch
        throw 'plain string failure';
      }),
    };
    const out = await propose(snap, [], {
      chain: chain as never,
      overridesPath: '/tmp/none.env',
      model: 'mst/free',
      log: silent,
      signal: new AbortController().signal,
    });
    expect(out).toEqual([]);
    expect(silent.warn).toHaveBeenCalledWith(
      { err: 'plain string failure' },
      'propose: chain call failed',
    );
  });

  it('uses the built-in fallback system prompt when prompt.md is unreadable', async () => {
    promptState.fail = true;
    try {
      const { chain } = makeChain({ patches: [] });
      await propose(snap, [], {
        chain: chain as never,
        overridesPath: '/tmp/none.env',
        model: 'mst/free',
        log: silent,
        signal: new AbortController().signal,
      });
      // The system message sent upstream is the fallback text, proving
      // readPrompt() recovered instead of throwing.
      const body = vi.mocked(chain.handle).mock.calls[0]![0] as unknown as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: 'You are the Campaign Director. Respond with {"patches":[]} when unsure.',
      });
    } finally {
      promptState.fail = false;
    }
  });
});
