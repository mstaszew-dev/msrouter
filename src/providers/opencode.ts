/**
 * OpenCode Zen pooled provider. Mirrors OpenRouterProvider's structure but the
 * routing-entry unit is the (model, key) TRIPLE, not just the key. Each model
 * variant (big-pickle, nemotron-3-ultra-free, ...) is tried against each key.
 *
 * Failure handling: a triple that returns KEY_FAILURE (401/402/403/429) is
 * demoted to the back of the queue for the life of the process. No TTL, no
 * persistence, no cooldown. Restart rebuilds the queue from env.
 *
 * Model resolution is NOT done here: the chain passes the already-resolved
 * model id per triple. The provider only supplies the (key, baseUrl) wiring.
 */

import type { Logger } from 'pino';

import { postChatCompletion } from './fetch.js';
import { RotationQueue } from './rotation.js';
import type { AttemptOptions, ChatRequestBody, Provider, ProviderCallResult } from './types.js';

export interface OpenCodeTriple {
  model: string;
  keyIdx: number;
}

export interface OpenCodeProviderConfig {
  keys: readonly string[];
  baseUrl: string;
  /** Model variants, big-pickle first. Order is preserved in the rotation queue. */
  models: readonly string[];
  timeoutMs: number;
  log: Logger;
  extraHeaders?: Record<string, string>;
}

export class OpenCodeProvider implements Provider {
  readonly id = 'opencode';

  private readonly keys: readonly string[];
  private readonly models: readonly string[];
  private readonly queue: RotationQueue<OpenCodeTriple>;

  constructor(private readonly cfg: OpenCodeProviderConfig) {
    this.keys = cfg.keys;
    this.models = cfg.models;
    // Model-major, key-minor: all keys for model0, then all keys for model1, ...
    // So big-pickle is tried on every key before falling through to deepseek.
    const triples: OpenCodeTriple[] = [];
    for (let m = 0; m < this.models.length; m++) {
      for (let k = 0; k < this.keys.length; k++) {
        triples.push({ model: this.models[m]!, keyIdx: k });
      }
    }
    this.queue = new RotationQueue(triples, { log: cfg.log, label: 'opencode' });
  }

  get available(): boolean {
    return this.keys.length > 0;
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get tripleCount(): number {
    return this.models.length * this.keys.length;
  }

  /** White-box: current queue order, for tests and debug. */
  queueSnapshot(): readonly OpenCodeTriple[] {
    return this.queue.snapshot();
  }

  /** White-box (test-only): demote a specific triple. */
  demoteTriple(t: OpenCodeTriple): void {
    this.queue.demote(t);
  }

  async attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: Partial<AttemptOptions> & { tripleIndex?: number },
  ): Promise<ProviderCallResult> {
    if (!this.available) {
      return { kind: 'KEY_FAILURE', status: 0, message: 'opencode: no keys configured' };
    }
    const tripleIdx = opts.tripleIndex ?? 0;
    const triple = this.queue.at(tripleIdx);
    if (!triple) {
      return { kind: 'KEY_FAILURE', status: 0, message: 'opencode: triple index out of range' };
    }
    const key = this.keys[triple.keyIdx];
    if (!key) {
      return { kind: 'KEY_FAILURE', status: 0, message: 'opencode: key missing' };
    }
    const model = opts.model ?? triple.model;
    const tag = `opencode[key${triple.keyIdx + 1}]/${model}`;

    const outbound: ChatRequestBody = { ...body, model };
    this.cfg.log.debug({ provider: this.id, keyTag: tag, model }, 'opencode attempt');
    const res = await postChatCompletion(outbound, {
      baseUrl: this.cfg.baseUrl,
      authorization: `Bearer ${key}`,
      extraHeaders: this.cfg.extraHeaders,
      signal,
      timeoutMs: this.cfg.timeoutMs,
      keyTag: tag,
    });

    if (res.kind === 'KEY_FAILURE') {
      this.queue.demote(triple);
      this.cfg.log.warn(
        { provider: this.id, model, keyIndex: triple.keyIdx + 1, status: res.status },
        'opencode triple demoted to back of queue',
      );
    }
    return res;
  }
}
