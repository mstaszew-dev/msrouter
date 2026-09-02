/**
 * Tests for the read-only observability snapshot builder. Everything external
 * is injected at a seam: the gateway is polled through an injectable fetch
 * (real Response objects, no mocks of our own code), files are read from a
 * temp dir, and the Kafka broker probe can be faked or run against a real
 * ephemeral socket. The builder never writes anywhere.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObsSnapshot } from '../shared/schema.js';

import { buildObsSnapshot, probeTcp } from './obs.js';
import type { ObsDeps } from './obs.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'obs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function baseDeps(overrides: Partial<ObsDeps> = {}): ObsDeps {
  return {
    gatewayBaseUrl: 'http://127.0.0.1:8787',
    fetchImpl: async () => json({ status: 'ok', uptime: 120 }),
    ledgerPath: join(dir, 'ledger.jsonl'),
    checkpointPath: join(dir, 'checkpoint.json'),
    ragDbPath: '',
    kafkaEnabled: false,
    kafkaBootstrap: 'localhost:19092',
    slackConfigured: false,
    tcpProbe: async () => true,
    ...overrides,
  };
}

describe('gateway probing', () => {
  it('collects live/ready/models when the gateway is up', async () => {
    const snapshot = await buildObsSnapshot(
      baseDeps({
        fetchImpl: async (input) => {
          const u =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (u.endsWith('/health/live')) return json({ status: 'ok', uptime: 120 });
          if (u.endsWith('/health/ready')) return json({ status: 'ok' });
          if (u.endsWith('/v1/models')) {
            return json({ object: 'list', data: [{ id: 'vendor/a' }, { id: 'vendor/b' }] });
          }
          return new Response('not found', { status: 404 });
        },
      }),
    );
    expect(snapshot.gateway.live.status).toBe('up');
    expect(snapshot.gateway.ready.status).toBe('up');
    expect(snapshot.gateway.uptimeSeconds).toBe(120);
    expect(snapshot.gateway.models).toEqual({
      status: 'up',
      count: 2,
      names: ['vendor/a', 'vendor/b'],
    });
  });

  it('reports down (not throw) when the gateway is unreachable', async () => {
    const snapshot = await buildObsSnapshot(
      baseDeps({
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(snapshot.gateway.live.status).toBe('down');
    expect(snapshot.gateway.ready.status).toBe('down');
    expect(snapshot.gateway.uptimeSeconds).toBeNull();
    expect(snapshot.gateway.models.status).toBe('down');
    expect(snapshot.gateway.models.count).toBeNull();
  });

  it('reports down when an endpoint answers with garbage', async () => {
    const snapshot = await buildObsSnapshot(
      baseDeps({
        fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
      }),
    );
    expect(snapshot.gateway.live.status).toBe('down');
    expect(snapshot.gateway.models.status).toBe('down');
  });

  it('sends the gateway bearer token when configured', async () => {
    let seenAuth = '';
    await buildObsSnapshot(
      baseDeps({
        gatewayToken: 'tok-123',
        fetchImpl: async (_url, init) => {
          seenAuth = new Headers(init?.headers).get('authorization') ?? '';
          return json({ status: 'ok', uptime: 1 });
        },
      }),
    );
    expect(seenAuth).toBe('Bearer tok-123');
  });
});

describe('director files', () => {
  it('parses the checkpoint and computes its age from the injected clock', async () => {
    const now = Date.parse('2026-09-02T21:00:00.000Z');
    await writeFile(
      join(dir, 'checkpoint.json'),
      JSON.stringify({ eventsReadOffset: 10, lastTickAt: '2026-09-02T20:30:00.000Z' }),
      'utf8',
    );
    const snapshot = await buildObsSnapshot(baseDeps({ nowMs: now }));
    expect(snapshot.director.checkpoint.status).toBe('up');
    expect(snapshot.director.checkpoint.lastTickAt).toBe('2026-09-02T20:30:00.000Z');
    expect(snapshot.director.checkpoint.ageMinutes).toBe(30);
  });

  it('reports down when the checkpoint is missing', async () => {
    const snapshot = await buildObsSnapshot(baseDeps());
    expect(snapshot.director.checkpoint.status).toBe('down');
  });

  it('never emits NaN for a garbage lastTickAt', async () => {
    await writeFile(
      join(dir, 'checkpoint.json'),
      JSON.stringify({ eventsReadOffset: 0, lastTickAt: 'garbage' }),
      'utf8',
    );
    const snapshot = await buildObsSnapshot(baseDeps());
    expect(snapshot.director.checkpoint.status).toBe('up');
    expect(snapshot.director.checkpoint.lastTickAt).toBeNull();
    expect(snapshot.director.checkpoint.ageMinutes).toBeNull();
  });

  it('tails the last 20 ledger entries and counts the rest', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(
        JSON.stringify({
          at: `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`,
          kind: 'observation',
          detail: `d${i}`,
        }),
      );
    }
    lines.splice(10, 0, 'not json at all');
    await writeFile(join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const snapshot = await buildObsSnapshot(baseDeps());
    expect(snapshot.director.ledgerEntries).toBe(25);
    expect(snapshot.director.ledgerTail).toHaveLength(20);
    expect(snapshot.director.ledgerTail[0]?.detail).toBe('d6');
    expect(snapshot.director.ledgerTail.at(-1)?.detail).toBe('d25');
  });

  it('returns an empty tail when the ledger does not exist', async () => {
    const snapshot = await buildObsSnapshot(baseDeps());
    expect(snapshot.director.ledgerTail).toEqual([]);
    expect(snapshot.director.ledgerEntries).toBeNull();
  });
});

describe('kafka / slack / rag', () => {
  it('marks kafka unconfigured when disabled, up/down per probe when enabled', async () => {
    const disabled = await buildObsSnapshot(baseDeps());
    expect(disabled.kafka.enabled).toBe(false);
    expect(disabled.kafka.broker.status).toBe('unconfigured');

    const up = await buildObsSnapshot(baseDeps({ kafkaEnabled: true, tcpProbe: async () => true }));
    expect(up.kafka.broker.status).toBe('up');

    const down = await buildObsSnapshot(
      baseDeps({ kafkaEnabled: true, tcpProbe: async () => false }),
    );
    expect(down.kafka.broker.status).toBe('down');
  });

  it('reflects slack configuration', async () => {
    expect((await buildObsSnapshot(baseDeps())).slack.status).toBe('unconfigured');
    expect((await buildObsSnapshot(baseDeps({ slackConfigured: true }))).slack.status).toBe('up');
  });

  it('checks the RAG database file only when configured', async () => {
    expect((await buildObsSnapshot(baseDeps())).rag.status).toBe('unconfigured');
    const missing = await buildObsSnapshot(baseDeps({ ragDbPath: join(dir, 'index.db') }));
    expect(missing.rag.status).toBe('down');
    await writeFile(join(dir, 'index.db'), 'sqlite', 'utf8');
    const present = await buildObsSnapshot(baseDeps({ ragDbPath: join(dir, 'index.db') }));
    expect(present.rag.status).toBe('up');
  });
});

describe('probeTcp (real sockets)', () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('succeeds against a listening socket and fails on a refused one', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    await expect(probeTcp(`127.0.0.1:${port}`, 500)).resolves.toBe(true);
    await expect(probeTcp('127.0.0.1:1', 500)).resolves.toBe(false);
  });
});

describe('snapshot schema conformance', () => {
  it('produces an ObsSnapshot-valid payload', async () => {
    const snapshot = await buildObsSnapshot(baseDeps({ kafkaEnabled: true }));
    expect(snapshot.generatedAt).toBeTruthy();
    // parse() throws if any field violates the shared schema.
    expect(() => ObsSnapshot.parse(snapshot)).not.toThrow();
  });
});
