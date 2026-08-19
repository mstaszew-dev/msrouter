import { execFile, spawn } from 'node:child_process';

import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  kafkaConsume,
  kafkaMonitor,
  kafkaProduce,
  kafkaTail,
  kafkaTopics,
  parseConsumeOutput,
} from './kafka.js';
import type { KafkaOpts } from './kafka.js';

vi.mock('node:child_process', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const kafkaOpts: KafkaOpts = {
  kafkaHome: '/opt/kafka',
  bootstrap: 'localhost:19092',
  log: silent,
};

interface MockChild {
  child: {
    on: ReturnType<typeof vi.fn>;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  handlers: Map<string, (...args: unknown[]) => void>;
}

function mockChild(): MockChild {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      handlers.set(ev, cb);
      return child;
    }),
    stdin: { write: vi.fn(), end: vi.fn() },
  };
  return { child, handlers };
}

function mockExecFileStdout(stdout: string): void {
  vi.mocked(execFile).mockImplementation(((
    _file: unknown,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr: '' });
    return {} as never;
  }) as never);
}

function mockExecFileErrorWithStdout(errMsg: string, stdout: string): void {
  vi.mocked(execFile).mockImplementation(((
    _file: unknown,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const err = new Error(errMsg) as Error & { stdout?: string };
    err.stdout = stdout;
    cb(err);
    return {} as never;
  }) as never);
}

describe('kafka.ts CLI wrapper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('parseConsumeOutput', () => {
    it('parses key\\tvalue lines', () => {
      const raw = 'key-1\t{"text":"hello"}\nkey-2\t{"text":"approve patch-abc"}\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ key: 'key-1', value: '{"text":"hello"}' });
      expect(parsed[1]).toMatchObject({ key: 'key-2', value: '{"text":"approve patch-abc"}' });
    });

    it('handles empty output', () => {
      expect(parseConsumeOutput('')).toEqual([]);
      expect(parseConsumeOutput('\n')).toEqual([]);
    });

    it('handles lines without keys (no tab separator)', () => {
      const raw = '{"no":"key"}\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.key).toBeUndefined();
      expect(parsed[0]!.value).toBe('{"no":"key"}');
    });

    it('handles multiple blank lines between messages', () => {
      const raw = 'k1\tv1\n\n\nk2\tv2\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(2);
    });

    it('handles values with embedded tabs (only first tab is the separator)', () => {
      const raw = 'key-1\tvalue\twith\ttabs\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.key).toBe('key-1');
      expect(parsed[0]!.value).toBe('value\twith\ttabs');
    });
  });

  describe('kafkaProduce', () => {
    it('writes key\\tvalue to stdin and resolves on exit 0', async () => {
      const { child, handlers } = mockChild();
      vi.mocked(spawn).mockReturnValue(child as never);

      let settled = false;
      const p = kafkaProduce('events', 'k1', 'v1', kafkaOpts).then(() => {
        settled = true;
      });
      handlers.get('exit')!(0);
      await p;

      expect(settled).toBe(true);
      expect(child.stdin.write).toHaveBeenCalledWith('k1\tv1\n');
      expect(child.stdin.end).toHaveBeenCalled();
      const [file, args] = vi.mocked(spawn).mock.calls[0]!;
      expect(file).toContain('kafka-console-producer.sh');
      expect(args).toContain('--topic');
      expect(args).toContain('events');
    });

    it('logs and resolves on non-zero exit', async () => {
      const { child, handlers } = mockChild();
      vi.mocked(spawn).mockReturnValue(child as never);

      let settled = false;
      const p = kafkaProduce('events', 'k1', 'v1', kafkaOpts).then(() => {
        settled = true;
      });
      handlers.get('exit')!(1);
      await p;

      expect(settled).toBe(true);
      expect(silent.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1, topic: 'events' }),
        'kafka producer exited non-zero',
      );
    });

    it('logs and resolves on spawn error', async () => {
      const { child, handlers } = mockChild();
      vi.mocked(spawn).mockReturnValue(child as never);

      let settled = false;
      const p = kafkaProduce('events', 'k1', 'v1', kafkaOpts).then(() => {
        settled = true;
      });
      handlers.get('error')!(new Error('ENOENT'));
      await p;

      expect(settled).toBe(true);
      expect(silent.error).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'events' }),
        'kafka produce spawn failed',
      );
    });
  });

  describe('kafkaConsume', () => {
    it('returns parsed messages from stdout', async () => {
      mockExecFileStdout('k1\tv1\nk2\tv2\n');
      const msgs = await kafkaConsume('events', kafkaOpts);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ key: 'k1', value: 'v1' });
      expect(msgs[1]).toMatchObject({ key: 'k2', value: 'v2' });
    });

    it('passes maxMessages, timeoutMs and group args', async () => {
      mockExecFileStdout('');
      await kafkaConsume('events', {
        ...kafkaOpts,
        maxMessages: 42,
        timeoutMs: 7000,
        groupId: 'g1',
      });
      const args = vi.mocked(execFile).mock.calls[0]![1];
      expect(args).toContain('--max-messages');
      expect(args).toContain('42');
      expect(args).toContain('--timeout-ms');
      expect(args).toContain('7000');
      expect(args).toContain('--group');
      expect(args).toContain('g1');
    });

    it('parses stdout captured on a timeout error', async () => {
      mockExecFileErrorWithStdout('timed out', 'k1\tv1\n');
      const msgs = await kafkaConsume('events', kafkaOpts);
      expect(msgs).toEqual([{ key: 'k1', value: 'v1' }]);
    });

    it('returns [] when execFile fails with no stdout', async () => {
      vi.mocked(execFile).mockImplementation(((
        _file: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error('consumer binary missing'));
        return {} as never;
      }) as never);
      const msgs = await kafkaConsume('events', kafkaOpts);
      expect(msgs).toEqual([]);
      expect(silent.debug).toHaveBeenCalled();
    });
  });

  describe('kafkaMonitor', () => {
    it('returns last N messages using --from-beginning and --max-messages 5 by default', async () => {
      mockExecFileStdout('k1\tv1\nk2\tv2\n');
      const msgs = await kafkaMonitor('events', kafkaOpts);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ key: 'k1', value: 'v1' });

      const args = vi.mocked(execFile).mock.calls[0]![1];
      expect(args).toContain('--from-beginning');
      expect(args).toContain('--max-messages');
      expect(args).toContain('5');
      expect(args).toContain('--timeout-ms');
      expect(args).toContain('3000');
    });

    it('honours custom maxMessages and timeoutMs', async () => {
      mockExecFileStdout('');
      await kafkaMonitor('events', { ...kafkaOpts, maxMessages: 10, timeoutMs: 1500 });
      const args = vi.mocked(execFile).mock.calls[0]![1];
      expect(args).toContain('10');
      expect(args).toContain('1500');
    });

    it('parses stdout captured on a timeout error', async () => {
      mockExecFileErrorWithStdout('timed out', 'k1\tv1\n');
      const msgs = await kafkaMonitor('events', kafkaOpts);
      expect(msgs).toEqual([{ key: 'k1', value: 'v1' }]);
    });

    it('returns [] on failure with no stdout', async () => {
      vi.mocked(execFile).mockImplementation(((
        _file: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error('binary missing'));
        return {} as never;
      }) as never);
      const msgs = await kafkaMonitor('events', kafkaOpts);
      expect(msgs).toEqual([]);
    });
  });

  describe('kafkaTopics', () => {
    it('lists topics', async () => {
      mockExecFileStdout('topic-a\ntopic-b\n\n');
      const topics = await kafkaTopics(kafkaOpts);
      expect(topics).toEqual(['topic-a', 'topic-b']);
    });

    it('returns [] on failure', async () => {
      vi.mocked(execFile).mockImplementation(((
        _file: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error('kafka-topics missing'));
        return {} as never;
      }) as never);
      const topics = await kafkaTopics(kafkaOpts);
      expect(topics).toEqual([]);
    });
  });

  describe('kafkaTail', () => {
    it('spawns a streaming consumer with --from-beginning', () => {
      vi.mocked(spawn).mockReturnValue({} as never);
      const result = kafkaTail('events', kafkaOpts);
      void result;
      const [file, args] = vi.mocked(spawn).mock.calls[0]!;
      expect(file).toContain('kafka-console-consumer.sh');
      expect(args).toContain('--topic');
      expect(args).toContain('events');
      expect(args).toContain('--from-beginning');
      expect(args).toContain('--property');
      expect(args).toContain('print.key=true');
    });
  });
});
