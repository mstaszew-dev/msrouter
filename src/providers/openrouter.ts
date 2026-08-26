/**
 * OpenRouter provider. Pools OPENROUTER_KEY1..N and rotates across them on a
 * per-key failure (401/402/429/403). Each `attempt()` call hits ONE key at
 * `keyIndex`; the chain calls `attempt()` again to advance to the next key.
 *
 * Key health queue: when a key fails (KEY_FAILURE), it is demoted to the back
 * of the queue. Subsequent requests try healthier keys first, so a rate-limited
 * key isn't re-tried first on every request. There is NO cooldown timer: a
 * failure is transient (more so than any fixed timeout), and a demoted key
 * naturally returns to the front after every other key is tried once
 * (round-robin). This keeps the queue logic strictly FIFO-on-failure with no
 * time-based churn.
 *
 * The queue is now backed by the shared RotationQueue primitive so OpenRouter,
 * OpenCode, and the chain-level inter-provider walk all share one demote-to-back
 * contract and one set of tests.
 *
 * Model resolution is NOT done here: the chain passes the already-resolved
 * model id (an explicit id with optional `:free`, or this provider's default
 * when the client sent an alias). This keeps the provider a thin upstream
 * caller and puts alias/default policy in one place (the chain).
 */

import type { Logger } from 'pino';

import { postChatCompletion } from './fetch.js';
import { RotationQueue } from './rotation.js';
import type { AttemptOptions, ChatRequestBody, Provider, ProviderCallResult } from './types.js';

export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter';

  /** Raw-index queue; demote-to-back on KEY_FAILURE. In-memory, no TTL. */
  private readonly keyOrder: RotationQueue<number>;

  constructor(
    private readonly keys: readonly string[],
    private readonly timeoutMs: number,
    private readonly log: Logger,
    /** Optional per-process referer/title for OpenRouter rankings. */
    private readonly referer = 'msrouter',
    private readonly title = 'msrouter',
  ) {
    // Start in numeric order.
    this.keyOrder = new RotationQueue(
      keys.map((_, idx) => idx),
      { log, label: 'openrouter' },
    );
  }

  get available(): boolean {
    return this.keys.length > 0;
  }

  /** Number of keys (the chain iterates attempt() up to this many times). */
  get keyCount(): number {
    return this.keys.length;
  }

  /** White-box view for tests: current queue order as raw key indices. */
  get queueSnapshot(): readonly number[] {
    return this.keyOrder.snapshot();
  }

  /**
   * White-box (test/admin): demote a specific raw key index to the back of the
   * queue. This is the same operation `attempt()` performs internally when a
   * key returns KEY_FAILURE. Exposed so tests can drive the queue without
   * stubbing the fetch layer, and so an admin endpoint could force-demote a
   * known-bad key.
   */
  demoteKey(rawIdx: number): void {
    this.keyOrder.demote(rawIdx);
  }

  /**
   * Attempt with the key at position `keyIndex` in the HEALTH queue (not the
   * raw numeric index). The chain passes 0,1,2,... and we map each to the
   * healthiest currently-eligible key. On KEY_FAILURE, the underlying key is
   * demoted to the back so the next request skips it.
   */
  async attempt(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: AttemptOptions,
  ): Promise<ProviderCallResult> {
    if (!this.available) {
      return {
        kind: 'KEY_FAILURE',
        status: 0,
        message: 'openrouter: no keys configured',
      };
    }
    const logicalIndex = opts.keyIndex ?? 0;
    const rawIdx = this.keyOrder.at(logicalIndex);
    if (rawIdx === undefined) {
      return { kind: 'KEY_FAILURE', status: 0, message: 'openrouter: key index out of range' };
    }
    const key = this.keys[rawIdx];
    if (!key) {
      return { kind: 'KEY_FAILURE', status: 0, message: 'openrouter: key missing' };
    }
    const tag = keyTag(key, rawIdx);

    const outbound: ChatRequestBody = { ...body, model: opts.model };
    this.log.debug({ provider: this.id, keyTag: tag, model: opts.model }, 'openrouter attempt');
    const res = await postChatCompletion(outbound, {
      baseUrl: 'https://openrouter.ai/api/v1',
      authorization: `Bearer ${key}`,
      extraHeaders: { 'http-referer': this.referer, 'x-title': this.title },
      signal,
      timeoutMs: this.timeoutMs,
      keyTag: tag,
    });

    // Demote on KEY_FAILURE so the next request tries a healthier key first.
    if (res.kind === 'KEY_FAILURE') {
      this.keyOrder.demote(rawIdx);
      this.log.warn(
        { provider: this.id, keyIndex: rawIdx + 1, status: res.status },
        'openrouter key demoted to back of queue',
      );
    }
    return res;
  }
}

/** Append ":free" to a model id unless it already carries a variant suffix or is
 * a model/router that should NOT be suffixed. The OpenRouter auto-routers
 * (`openrouter/free`, `openrouter/auto`) select among upstream models
 * themselves; appending `:free` would corrupt them into a non-existent model.
 */
export function withFree(model: string, force: boolean): string {
  if (!force) return model;
  if (model.includes(':')) return model;
  if (model === 'openrouter/free' || model === 'openrouter/auto') return model;
  return `${model}:free`;
}

/** Redacted key tag for logs: "key3:...last4". Never logs the full key. */
export function keyTag(key: string, idx: number): string {
  const tail = key.length > 4 ? key.slice(-4) : '****';
  return `key${idx + 1}:...${tail}`;
}
