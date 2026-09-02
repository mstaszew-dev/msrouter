/**
 * Dashboard overview: renders the read-only observability snapshot produced by
 * the admin API (gateway health/models, Director checkpoint + ledger tail,
 * Kafka broker probe, Slack and RAG configuration). Polls every 5 seconds;
 * purely observational, it never mutates anything.
 */
import { useEffect, useState } from 'react';

import { api } from '../api/client';
import type { ObsSnapshot } from '@shared/schema';
import { StatusCard } from './StatusCard';

const REFRESH_MS = 5000;

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function formatAge(minutes: number | null): string {
  if (minutes === null) return 'unknown';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function OverviewTab(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ObsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One effect owns the whole polling lifecycle with a local generation
  // counter: a slow snapshot resolving after a newer one is discarded, and
  // in-flight responses after unmount are dropped.
  useEffect(() => {
    let current = 0;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const seq = ++current;
      try {
        const snap = await api.obs();
        if (cancelled || seq !== current) return;
        setSnapshot(snap);
        setError(null);
      } catch (err) {
        if (cancelled || seq !== current) return;
        setError(err instanceof Error ? err.message : 'request failed');
      }
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error && !snapshot) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/40 p-6 text-sm text-red-300">
        Could not load observability data: {error}
      </div>
    );
  }

  if (!snapshot) {
    return <div className="p-6 text-sm text-slate-400">Loading observability data…</div>;
  }

  const { gateway, director, kafka, slack, rag } = snapshot;

  return (
    <div className="space-y-6">
      <p className="text-xs text-slate-500">
        Snapshot {new Date(snapshot.generatedAt).toLocaleTimeString()} - auto-refreshes every 5s
        (read-only)
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatusCard
          title="Gateway"
          status={gateway.live.status}
          value={gateway.live.status === 'up' ? formatUptime(gateway.uptimeSeconds ?? 0) : undefined}
          detail={gateway.ready.detail ?? `live ${gateway.live.status} / ready ${gateway.ready.status}`}
        />
        <StatusCard
          title="Models routed"
          status={gateway.models.status}
          value={gateway.models.count !== null ? String(gateway.models.count) : '0'}
        >
          <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto text-xs text-slate-400">
            {gateway.models.names.map((name) => (
              <li key={name} className="truncate">
                {name}
              </li>
            ))}
          </ul>
        </StatusCard>
        <StatusCard
          title="Director"
          status={director.checkpoint.status}
          value={`last tick ${formatAge(director.checkpoint.ageMinutes)} ago`}
          detail={
            director.ledgerEntries !== null ? `${director.ledgerEntries} entries in ledger` : 'no ledger found'
          }
        />
        <StatusCard
          title="Kafka broker"
          status={kafka.enabled ? kafka.broker.status : 'unconfigured'}
          detail={kafka.enabled ? (kafka.broker.detail ?? 'director-events topic') : 'KAFKA_ENABLED=false'}
        />
        <StatusCard title="Slack" status={slack.status} detail={slack.detail ?? 'approval gate'} />
        <StatusCard title="RAG index" status={rag.status} detail={rag.detail} />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h3 className="text-sm font-medium text-slate-300">Recent Director ledger events</h3>
          <span className="text-xs text-slate-500">append-only ledger.jsonl</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-2 font-medium">Time</th>
              <th className="px-5 py-2 font-medium">Kind</th>
              <th className="px-5 py-2 font-medium">Patch</th>
              <th className="px-5 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {director.ledgerTail
              .slice()
              .reverse()
              .map((event) => (
                <tr key={`${event.at}-${event.kind}`} className="text-slate-300">
                  <td className="whitespace-nowrap px-5 py-2 text-xs text-slate-400">
                    {event.at ? new Date(event.at).toLocaleString() : 'unknown'}
                  </td>
                  <td className="px-5 py-2">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs">{event.kind}</span>
                  </td>
                  <td className="px-5 py-2 text-xs text-slate-400">{event.patchId ?? '-'}</td>
                  <td className="max-w-md truncate px-5 py-2 text-xs text-slate-400">
                    {event.detail ?? '-'}
                  </td>
                </tr>
              ))}
            {director.ledgerTail.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-4 text-center text-xs text-slate-500">
                  No ledger events found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
