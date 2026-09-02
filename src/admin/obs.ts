/**
 * Read-only observability snapshot for the dashboard. Polls the gateway's own
 * health/models endpoints, reads the Director's checkpoint + ledger tail from
 * disk, and probes the Kafka broker with a TCP connect. Nothing here writes,
 * configures, or influences routing - this module is a pure reader.
 *
 * Every side effect is injected at a seam (fetch, TCP probe) or parameterized
 * (paths, clock) so tests exercise real behavior without the live stack.
 */

import { access, readFile } from 'node:fs/promises';
import { connect } from 'node:net';

import { ObsSnapshot } from '../shared/schema.js';
import type {
  ComponentStatus,
  LedgerEventView,
  ObsSnapshot as ObsSnapshotDoc,
} from '../shared/schema.js';

export interface ObsDeps {
  gatewayBaseUrl: string;
  gatewayToken?: string;
  fetchImpl: typeof fetch;
  ledgerPath: string;
  checkpointPath: string;
  ragDbPath: string;
  kafkaEnabled: boolean;
  /** host:port of the Kafka bootstrap broker. */
  kafkaBootstrap: string;
  slackConfigured: boolean;
  /** Injected clock (ms epoch) for checkpoint age math. */
  nowMs?: number;
  tcpProbe?: (bootstrap: string, timeoutMs: number) => Promise<boolean>;
}

const GATEWAY_TIMEOUT_MS = 2000;
const KAFKA_PROBE_TIMEOUT_MS = 1500;
const LEDGER_TAIL_LINES = 20;

/** TCP connect probe: resolves true when the broker accepts, false otherwise. */
export function probeTcp(bootstrap: string, timeoutMs: number): Promise<boolean> {
  const sep = bootstrap.lastIndexOf(':');
  if (sep <= 0) return Promise.resolve(false);
  const host = bootstrap.slice(0, sep);
  const port = Number(bootstrap.slice(sep + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function buildObsSnapshot(deps: ObsDeps): Promise<ObsSnapshotDoc> {
  const nowMs = deps.nowMs ?? Date.now();
  const [live, ready, models, checkpoint, ledger, kafkaBroker, rag] = await Promise.all([
    probeGateway(deps, '/health/live'),
    probeGateway(deps, '/health/ready'),
    probeModels(deps),
    readCheckpoint(deps.checkpointPath, nowMs),
    readLedgerTail(deps.ledgerPath),
    deps.kafkaEnabled
      ? (deps.tcpProbe ?? probeTcp)(deps.kafkaBootstrap, KAFKA_PROBE_TIMEOUT_MS)
      : null,
    checkRag(deps.ragDbPath),
  ]);

  return ObsSnapshot.parse({
    generatedAt: new Date(nowMs).toISOString(),
    gateway: {
      live: live ?? { status: 'down', detail: 'no response' },
      ready: ready ?? { status: 'down', detail: 'no response' },
      uptimeSeconds: live?.uptime ?? null,
      models: models,
    },
    director: {
      checkpoint: checkpoint,
      ledgerTail: ledger.tail,
      ledgerEntries: ledger.total,
    },
    kafka: {
      enabled: deps.kafkaEnabled,
      broker: !deps.kafkaEnabled
        ? ({ status: 'unconfigured' } as const)
        : kafkaBroker
          ? ({ status: 'up', detail: deps.kafkaBootstrap } as const)
          : ({ status: 'down', detail: deps.kafkaBootstrap } as const),
    },
    slack: { status: (deps.slackConfigured ? 'up' : 'unconfigured') as ComponentStatus },
    rag: rag,
  });
}

interface GatewayProbe {
  status: ComponentStatus;
  detail?: string;
  uptime?: number;
}

async function gatewayFetch(deps: ObsDeps, path: string): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (deps.gatewayToken) headers['authorization'] = `Bearer ${deps.gatewayToken}`;
  return deps.fetchImpl(`${deps.gatewayBaseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
}

async function probeGateway(deps: ObsDeps, path: string): Promise<GatewayProbe | null> {
  try {
    const res = await gatewayFetch(deps, path);
    if (!res.ok) return { status: 'down', detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: unknown; uptime?: unknown };
    return {
      status: body.status === 'ok' ? 'up' : 'down',
      ...(typeof body.uptime === 'number' ? { uptime: body.uptime } : {}),
    };
  } catch (e) {
    return { status: 'down', detail: truncate(e instanceof Error ? e.message : 'error') };
  }
}

async function probeModels(deps: ObsDeps): Promise<ObsSnapshotDoc['gateway']['models']> {
  try {
    const res = await gatewayFetch(deps, '/v1/models');
    if (!res.ok) return { status: 'down', count: null, names: [] };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const names = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : null))
      .filter((id): id is string => id !== null)
      .slice(0, 100);
    return { status: 'up', count: names.length, names };
  } catch {
    return { status: 'down', count: null, names: [] };
  }
}

async function readCheckpoint(
  path: string,
  nowMs: number,
): Promise<ObsSnapshotDoc['director']['checkpoint']> {
  try {
    const raw = await readFile(path, 'utf8');
    const cp = JSON.parse(raw) as { lastTickAt?: unknown };
    const parsedTick =
      typeof cp.lastTickAt === 'string' && cp.lastTickAt ? Date.parse(cp.lastTickAt) : NaN;
    const lastTickAt = Number.isNaN(parsedTick) ? null : new Date(parsedTick).toISOString();
    const ageMinutes =
      lastTickAt !== null ? Math.max(0, Math.round((nowMs - parsedTick) / 60000)) : null;
    return {
      status: 'up',
      lastTickAt,
      ageMinutes,
      ...(lastTickAt === null ? { detail: 'no valid lastTickAt recorded yet' } : {}),
    };
  } catch {
    return {
      status: 'down',
      lastTickAt: null,
      ageMinutes: null,
      detail: 'checkpoint.json not found',
    };
  }
}

async function readLedgerTail(
  path: string,
): Promise<{ tail: LedgerEventView[]; total: number | null }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { tail: [], total: null };
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries: LedgerEventView[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        at: typeof obj['at'] === 'string' ? obj['at'] : '',
        kind: typeof obj['kind'] === 'string' ? obj['kind'] : 'unknown',
        ...(typeof obj['patchId'] === 'string' ? { patchId: obj['patchId'] } : {}),
        ...(typeof obj['detail'] === 'string' ? { detail: truncate(obj['detail']) } : {}),
      });
    } catch {
      // Skip malformed line (same policy as the Director's own reader).
    }
  }
  return { tail: entries.slice(-LEDGER_TAIL_LINES), total: entries.length };
}

async function checkRag(ragDbPath: string): Promise<{ status: ComponentStatus; detail?: string }> {
  if (!ragDbPath) return { status: 'unconfigured' };
  try {
    await access(ragDbPath);
    return { status: 'up', detail: ragDbPath };
  } catch {
    return { status: 'down', detail: `${ragDbPath} not found` };
  }
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
