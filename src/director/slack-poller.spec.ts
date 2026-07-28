import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { SlackPoller } from './slack-poller.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('SlackPoller', () => {
  it('starts with empty queue', () => {
    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    expect(p.queueSize).toBe(0);
    expect(p.latestTs).toBeUndefined();
  });

  it('drain returns empty when no messages polled yet', () => {
    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    expect(p.drain()).toEqual([]);
    expect(p.queueSize).toBe(0);
  });

  it('setLastTs sets the cursor', () => {
    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    p.setLastTs('1000.5');
    expect(p.latestTs).toBe('1000.5');
  });

  it('drain clears the queue', () => {
    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    // Simulate queue having messages
    (p as unknown as { queue: unknown[] }).queue = [
      { text: 'approve p1', ts: '2000.0' },
      { text: 'hello', ts: '2000.1' },
    ];
    const msgs = p.drain();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.text).toBe('approve p1');
    expect(p.queueSize).toBe(0);
  });

  it('polls Slack API and fills queue (mocked fetch)', async () => {
    const mockMessages = {
      ok: true,
      messages: [
        { text: 'approve patch-abc', ts: '3000.0', user: 'U123' },
        { text: 'some chat message', ts: '3000.1', user: 'U456' },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    // Trigger one poll manually
    await (p as unknown as { poll: () => Promise<void> }).poll();

    expect(p.queueSize).toBe(2);
    expect(p.latestTs).toBe('3000.1');

    const msgs = p.drain();
    expect(msgs[0]!.text).toBe('approve patch-abc');
    expect(msgs[0]!.user).toBe('U123');

    // Verify the URL had channel param
    const callUrl = typeof fetchSpy.mock.calls[0]?.[0] === 'string'
      ? fetchSpy.mock.calls[0][0]
      : '';
    expect(callUrl).toContain('channel=C123');

    fetchSpy.mockRestore();
  });

  it('respects lastTs for dedup (passes oldest param)', async () => {
    const mockMessages = { ok: true, messages: [] };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    p.setLastTs('2999.0');
    await (p as unknown as { poll: () => Promise<void> }).poll();

    const callUrl = typeof fetchSpy.mock.calls[0]?.[0] === 'string'
      ? fetchSpy.mock.calls[0][0]
      : '';
    expect(callUrl).toContain('oldest=2999.0');

    fetchSpy.mockRestore();
  });

  it('handles API error gracefully (no crash, no messages)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    await (p as unknown as { poll: () => Promise<void> }).poll();

    expect(p.queueSize).toBe(0);
    expect(silent.warn).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('handles network error gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    await (p as unknown as { poll: () => Promise<void> }).poll();

    expect(p.queueSize).toBe(0);
    expect(silent.error).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('start/stop manages the timer', () => {
    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    p.start();
    // Timer should be set
    expect((p as unknown as { timer: unknown }).timer).toBeDefined();
    p.stop();
    expect((p as unknown as { timer: unknown }).timer).toBeUndefined();
  });

  it('skips messages without text or ts', async () => {
    const mockMessages = {
      ok: true,
      messages: [
        { text: 'valid', ts: '4000.0' },
        { text: '', ts: '4000.1' }, // no text
        { text: 'no-ts' }, // no ts
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMessages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const p = new SlackPoller('xoxb-test', 'C123', 999, silent);
    await (p as unknown as { poll: () => Promise<void> }).poll();

    expect(p.queueSize).toBe(1); // only the valid message
    fetchSpy.mockRestore();
  });
});
