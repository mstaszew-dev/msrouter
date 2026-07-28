/**
 * kafka.ts: Kafka CLI wrapper. Shells out to the Kafka binary scripts (no npm
 * Kafka dependency). Each produce spawns a short-lived JVM; each consume does
 * the same with a timeout. Designed for low-frequency Director events.
 *
 * The Kafka home directory and bootstrap server are configurable via opts or
 * env vars (KAFKA_HOME, KAFKA_BOOTSTRAP).
 */

import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

const execFileP = promisify(execFile);

export interface KafkaOpts {
  kafkaHome: string;
  bootstrap: string;
  log: Logger;
}

export interface KafkaMessage {
  key?: string;
  value: string;
  partition?: number;
  offset?: string;
}

/**
 * Produce one message to a Kafka topic. Shells out to kafka-console-producer.sh,
 * pipes the key\tvalue via stdin. Returns on completion; logs errors but does
 * not throw (Kafka is a best-effort visibility layer).
 */
export async function kafkaProduce(
  topic: string,
  key: string,
  value: string,
  opts: KafkaOpts,
): Promise<void> {
  const producerScript = join(opts.kafkaHome, 'bin', 'kafka-console-producer.sh');
  const args = [
    '--topic', topic,
    '--bootstrap-server', opts.bootstrap,
    '--property', 'parse.key=true',
    '--property', 'key.separator=\t',
  ];

  return new Promise<void>((resolve) => {
    const child = spawn(producerScript, args, { stdio: ['pipe', 'ignore', 'ignore'] });

    child.on('error', (e) => {
      opts.log.error({ err: e.message, topic }, 'kafka produce spawn failed');
      resolve();
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        opts.log.warn({ code, topic }, 'kafka producer exited non-zero');
      }
      resolve();
    });

    // Write the key\tvalue\n and close stdin to signal end-of-input.
    child.stdin.write(`${key}\t${value}\n`);
    child.stdin.end();
  });
}

/**
 * Consume messages from a Kafka topic (one-shot). Uses kafka-console-consumer.sh
 * with a timeout. Returns parsed messages.
 */
export async function kafkaConsume(
  topic: string,
  opts: KafkaOpts & { maxMessages?: number; timeoutMs?: number; groupId?: string },
): Promise<KafkaMessage[]> {
  const consumerScript = join(opts.kafkaHome, 'bin', 'kafka-console-consumer.sh');
  const args = [
    '--topic', topic,
    '--bootstrap-server', opts.bootstrap,
    '--property', 'print.key=true',
    '--property', 'key.separator=\t',
    '--max-messages', String(opts.maxMessages ?? 100),
    '--timeout-ms', String(opts.timeoutMs ?? 5000),
    '--group', opts.groupId ?? 'director-consumer',
  ];

  try {
    const { stdout } = await execFileP(consumerScript, args, {
      timeout: (opts.timeoutMs ?? 5000) + 10_000,
      maxBuffer: 1024 * 1024,
    });
    return parseConsumeOutput(stdout);
  } catch (e) {
    // kafka-console-consumer exits non-zero on timeout even if messages were read.
    // Check if stdout was captured in the error.
    const err = e as { stdout?: string };
    if (err.stdout) {
      return parseConsumeOutput(err.stdout);
    }
    opts.log.debug({ err: e instanceof Error ? e.message : String(e), topic }, 'kafka consume failed');
    return [];
  }
}

/** Parse kafka-console-consumer --property print.key=true output. */
export function parseConsumeOutput(raw: string): KafkaMessage[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.map((line) => {
    const sepIdx = line.indexOf('\t');
    if (sepIdx === -1) {
      return { value: line };
    }
    return {
      key: line.slice(0, sepIdx),
      value: line.slice(sepIdx + 1),
    };
  });
}

/** List all Kafka topics. */
export async function kafkaTopics(opts: KafkaOpts): Promise<string[]> {
  const script = join(opts.kafkaHome, 'bin', 'kafka-topics.sh');
  try {
    const { stdout } = await execFileP(script, [
      '--bootstrap-server', opts.bootstrap,
      '--list',
    ], { timeout: 10_000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Streaming tail of a Kafka topic. Returns a child process whose stdout streams
 * messages in real-time. Call .kill() on the returned process to stop.
 */
export function kafkaTail(topic: string, opts: KafkaOpts): ReturnType<typeof spawn> {
  const script = join(opts.kafkaHome, 'bin', 'kafka-console-consumer.sh');
  return spawn(script, [
    '--topic', topic,
    '--bootstrap-server', opts.bootstrap,
    '--from-beginning',
    '--property', 'print.key=true',
    '--property', 'key.separator=\t',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}
