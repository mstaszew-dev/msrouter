/**
 * Tests for the dashboard overview: renders the observability snapshot as
 * status cards + a ledger tail table, auto-refreshes every 5 seconds, and
 * degrades gracefully when the snapshot cannot be loaded.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { OverviewTab } from './OverviewTab';
import type { ObsSnapshot } from '@shared/schema';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: { ...actual.api, obs: vi.fn() } };
});

import { api } from '../api/client';

const snapshot: ObsSnapshot = {
  generatedAt: '2026-09-02T21:00:00.000Z',
  gateway: {
    live: { status: 'up' },
    ready: { status: 'up' },
    uptimeSeconds: 3661,
    models: { status: 'up', count: 3, names: ['mst/free', 'qwen3.5:2b', 'big-pickle'] },
  },
  director: {
    checkpoint: { status: 'up', lastTickAt: '2026-09-02T20:57:00.000Z', ageMinutes: 3 },
    ledgerTail: [
      { at: '2026-09-02T19:47:17.215Z', kind: 'observation', detail: 'submitted=1382 target=2000' },
      { at: '2026-09-02T18:47:00.000Z', kind: 'applied', patchId: 'p-1' },
    ],
    ledgerEntries: 142,
  },
  kafka: { enabled: true, broker: { status: 'up', detail: 'localhost:19092' } },
  slack: { status: 'unconfigured' },
  rag: { status: 'up', detail: 'index.db' },
};

beforeEach(() => {
  vi.mocked(api.obs).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OverviewTab', () => {
  it('renders gateway, director, and infra cards from the snapshot', async () => {
    vi.mocked(api.obs).mockResolvedValue(snapshot);
    render(<OverviewTab />);

    await waitFor(() => expect(screen.getByText('1h 1m')).toBeInTheDocument()); // 3661s formatted
    expect(screen.getByText('3')).toBeInTheDocument(); // model count
    expect(screen.getByText(/last tick 3 min ago/)).toBeInTheDocument(); // checkpoint age
    expect(screen.getByText(/localhost:19092/)).toBeInTheDocument();
    expect(screen.getByText(/unconfigured/i)).toBeInTheDocument(); // slack
  });

  it('lists recent ledger events', async () => {
    vi.mocked(api.obs).mockResolvedValue(snapshot);
    render(<OverviewTab />);
    await waitFor(() => expect(screen.getByText(/submitted=1382/)).toBeInTheDocument());
    expect(screen.getByText('applied')).toBeInTheDocument();
    expect(screen.getByText(/142 entries/)).toBeInTheDocument();
  });

  it('shows model names in the gateway card', async () => {
    vi.mocked(api.obs).mockResolvedValue(snapshot);
    render(<OverviewTab />);
    await waitFor(() => expect(screen.getByText(/mst\/free/)).toBeInTheDocument());
  });

  it('auto-refreshes every 5 seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(api.obs).mockResolvedValue(snapshot);
    render(<OverviewTab />);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.obs)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(api.obs)).toHaveBeenCalledTimes(3);
  });

  it('shows an error message when the snapshot cannot be loaded', async () => {
    vi.mocked(api.obs).mockRejectedValue(new Error('network down'));
    render(<OverviewTab />);
    await waitFor(() =>
      expect(screen.getByText(/could not load observability data/i)).toBeInTheDocument(),
    );
  });
});
