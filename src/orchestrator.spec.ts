import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Env } from './config/env.js';
import { env } from './config/env.js';
import { DirectorLoop } from './director/index.js';
import { SlackPoller } from './director/slack-poller.js';
import { NullSurface, SlackSurface } from './director/surface.js';
import type { DirectorRunResult } from './director/types.js';
import { startOrchestrator } from './orchestrator.js';

vi.mock('./config/env.js', () => ({ env: vi.fn() }));
vi.mock('./director/index.js', () => ({ DirectorLoop: vi.fn() }));
vi.mock('./director/slack-poller.js', () => ({ SlackPoller: vi.fn() }));
vi.mock('./director/surface.js', () => ({ NullSurface: vi.fn(), SlackSurface: vi.fn() }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const runResult: DirectorRunResult = {
  observed: 1,
  classifications: 0,
  proposed: 0,
  applied: 0,
  reason: 'done',
};

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_BOT_TOKEN: undefined,
    SLACK_CHANNEL: undefined,
    SLACK_WEBHOOK: undefined,
    KAFKA_POLL_INTERVAL_SECONDS: 30,
    DIRECTOR_INTERVAL_MINUTES: 5,
    DIRECTOR_OPENCLAW_WORKSPACE: '/campaign',
    DIRECTOR_LEDGER: '',
    ...overrides,
  } as unknown as Env;
}

function mockDirectorLoop(): { runOnce: ReturnType<typeof vi.fn> } {
  const runOnce = vi.fn(async (_signal: AbortSignal) => runResult);
  vi.mocked(DirectorLoop).mockImplementation(() => ({ runOnce }) as never);
  return { runOnce };
}

function mockPoller(): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const start = vi.fn();
  const stop = vi.fn();
  vi.mocked(SlackPoller).mockImplementation(() => ({ start, stop }) as never);
  return { start, stop };
}

describe('startOrchestrator', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: ReturnType<typeof vi.spyOn<any, 'exit'>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env).mockReturnValue(baseEnv());
    vi.mocked(NullSurface).mockImplementation(() => ({}) as never);
    vi.mocked(SlackSurface).mockImplementation(() => ({}) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('starts the Director scheduler with NullSurface when Slack is not configured', () => {
    mockDirectorLoop();
    const handles = startOrchestrator({ chain: {} as never, log: silent });

    expect(NullSurface).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerPath: '/campaign/director/ledger.jsonl' }),
    );
    expect(SlackSurface).not.toHaveBeenCalled();
    expect(silent.info).toHaveBeenCalledWith('Using NullSurface (Slack not configured)');

    const loopOpts = vi.mocked(DirectorLoop).mock.calls[0]![0];
    expect(loopOpts.checkpointPath).toBe('/campaign/director/checkpoint.json');
    expect(loopOpts.surface).toBeDefined();
    expect(silent.info).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalMinutes: 5,
        ledgerPath: '/campaign/director/ledger.jsonl',
      }),
      'Director scheduler started',
    );

    handles.shutdown();
    expect(silent.info).toHaveBeenCalledWith('Shutting down orchestrator...');
  });

  it('uses SlackSurface and starts the poller when Slack token and channel are set', () => {
    vi.mocked(env).mockReturnValue(baseEnv({ SLACK_BOT_TOKEN: 'xoxb-t', SLACK_CHANNEL: 'C1' }));
    mockDirectorLoop();
    const poller = mockPoller();
    const handles = startOrchestrator({ chain: {} as never, log: silent });

    expect(SlackPoller).toHaveBeenCalledWith('xoxb-t', 'C1', 30, silent);
    expect(SlackSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        slackBotToken: 'xoxb-t',
        slackChannel: 'C1',
        slackPoller: expect.anything() as never,
      }),
    );
    expect(silent.info).toHaveBeenCalledWith('Using Slack surface for Director');
    expect(poller.start).toHaveBeenCalled();

    handles.shutdown();
    expect(poller.stop).toHaveBeenCalled();
  });

  it('uses SlackSurface (no poller) when only a webhook is configured', () => {
    vi.mocked(env).mockReturnValue(baseEnv({ SLACK_WEBHOOK: 'https://hooks.slack.test/x' }));
    mockDirectorLoop();
    mockPoller();
    startOrchestrator({ chain: {} as never, log: silent });

    expect(SlackSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        slackWebhook: 'https://hooks.slack.test/x',
        slackPoller: undefined,
      }),
    );
    expect(SlackPoller).not.toHaveBeenCalled();
  });

  it('disables the Director when DIRECTOR_INTERVAL_MINUTES is negative', () => {
    vi.mocked(env).mockReturnValue(baseEnv({ DIRECTOR_INTERVAL_MINUTES: -1 }));
    const { runOnce } = mockDirectorLoop();
    const handles = startOrchestrator({ chain: {} as never, log: silent });

    expect(silent.info).toHaveBeenCalledWith('Director disabled (DIRECTOR_INTERVAL_MINUTES<0)');
    expect(runOnce).not.toHaveBeenCalled();
    expect(handles.shutdown).toBeDefined();
    handles.shutdown();
  });

  it('logs and skips a tick while the previous run is still in progress', async () => {
    vi.useFakeTimers();
    let release: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runOnce = vi.fn(async () => {
      await pending;
      return runResult;
    });
    vi.mocked(DirectorLoop).mockImplementation(() => ({ runOnce }) as never);

    const handles = startOrchestrator({ chain: {} as never, log: silent });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(silent.warn).toHaveBeenCalledWith(
      'previous Director run still in progress; skipping tick',
    );

    release!();
    handles.shutdown();
    vi.useRealTimers();
    await Promise.resolve();
  });
});
