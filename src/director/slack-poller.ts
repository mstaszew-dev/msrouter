/**
 * slack-poller.ts: In-process Slack poller. Runs on its own interval (default 30s),
 * polls conversations.history on the configured channel, and fills an in-memory
 * queue of messages. The Director's pollSlackMessages drains the queue on each tick.
 *
 * Replaces the standalone director-kafka-poller.ts process.
 */

import type { Logger } from 'pino';

export interface SlackMessage {
  text: string;
  ts: string;
  user?: string;
}

export class SlackPoller {
  private queue: SlackMessage[] = [];
  private lastTs: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    private readonly botToken: string,
    private readonly channel: string,
    private readonly intervalSec: number,
    private readonly log: Logger,
  ) {}

  /** Start polling. Runs immediately + on interval. */
  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalSec * 1000);
    this.log.info(
      { channel: this.channel, intervalSec: this.intervalSec },
      'Slack poller started',
    );
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Drain all queued messages. Returns them and clears the queue. */
  drain(): SlackMessage[] {
    const msgs = this.queue;
    this.queue = [];
    return msgs;
  }

  /** Current queue size (for tests/debug). */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Get the latest ts seen (for checkpoint persistence). */
  get latestTs(): string | undefined {
    return this.lastTs;
  }

  /** Set the starting ts (e.g. from checkpoint on restart). */
  setLastTs(ts: string | undefined): void {
    this.lastTs = ts;
  }

  /** Poll Slack for new messages since lastTs. */
  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const params = new URLSearchParams({ channel: this.channel, limit: '20' });
      if (this.lastTs) params.set('oldest', this.lastTs);
      const res = await fetch(
        `https://slack.com/api/conversations.history?${params.toString()}`,
        { headers: { Authorization: `Bearer ${this.botToken}` } },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        messages?: Array<{ text?: string; ts?: string; user?: string }>;
        error?: string;
      };
      if (!data.ok || !data.messages) {
        this.log.warn({ error: data.error }, 'Slack poll failed');
        return;
      }

      let count = 0;
      for (const msg of data.messages) {
        if (!msg.ts || !msg.text) continue;
        if (!this.lastTs || msg.ts > this.lastTs) this.lastTs = msg.ts;
        this.queue.push({ text: msg.text, ts: msg.ts, user: msg.user });
        count++;
      }
      if (count > 0) {
        this.log.info({ count, queueSize: this.queue.length, lastTs: this.lastTs }, 'Slack poll: new messages');
      }
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Slack poll failed (transient, will retry)');
    } finally {
      this.busy = false;
    }
  }
}
