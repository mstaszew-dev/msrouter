/**
 * Provider chain with adaptive flat-sequence rotation.
 *
 * On construction, builds ONE flat ordered list of RoutingEntry triples
 * `<model, provider, keyIndex>` (delegated to chain-routing.ts) and wraps it in
 * a RotationQueue. Every `handle()` call iterates the queue from the front:
 *   - OK       -> return the response.
 *   - KEY_FAILURE (401/402/403/429) -> demote this entry to the back, try next.
 *   - TRANSIENT (5xx/408/425)      -> backoff-retry in place up to MAX_TRANSIENT_RETRIES.
 *   - BAD_REQUEST (other 4xx)      -> skip to next entry (do not demote).
 *
 * Demotion is permanent for the life of the process (no TTL, in-memory only).
 * Restart rebuilds the queue from env in the original declared order.
 *
 * Aliases "mst/free" and "free" walk the SAME entry list using each entry's
 * provider-default model. Prefix "direct:<provider>/<model>" pins a single
 * provider and disables fallback.
 */

import type { Logger } from 'pino';

import { NoProviderAvailableError } from '../common/errors.js';
import { backoffMs, sleep } from '../common/retry.js';
import { env } from '../config/env.js';

import {
  buildRoutingEntries,
  shortCircuit,
  type ChainProvider,
  type RoutingEntry,
} from './chain-routing.js';
import type { Providers } from './instances.js';
import { withFree } from './openrouter.js';
import { RotationQueue } from './rotation.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';

// Re-export so existing imports of `RoutingEntry` from './chain.js' work.
export type { RoutingEntry } from './chain-routing.js';

export interface ChainResult {
  response: Response;
  servedBy: { provider: string; model: string; keyTag?: string };
}

export class ProviderChain {
  private readonly queue: RotationQueue<RoutingEntry>;

  constructor(
    private readonly providers: Providers,
    private readonly log: Logger,
  ) {
    this.queue = new RotationQueue(buildRoutingEntries(providers), { log, label: 'chain' });
  }

  async handle(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    const requested = body.model;
    if (env().WALK_ALIAS.includes(requested)) {
      return this.walkAll(body, signal);
    }
    const sc = shortCircuit(requested);
    if (sc) return this.runSingle(sc.provider, sc.model, body, signal);
    return this.runChain(body, signal, { explicitModel: requested });
  }

  /** Walk every entry using each provider's default model. */
  private async walkAll(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    return this.iterate(body, signal, {});
  }

  /** Walk every entry using the client's explicit model. */
  private async runChain(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: { explicitModel: string },
  ): Promise<ChainResult> {
    return this.iterate(body, signal, {
      explicitModel: withFree(opts.explicitModel, env().FORCE_FREE),
    });
  }

  /** Single provider pin (direct:). No fallback. */
  private async runSingle(
    provider: ChainProvider,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
  ): Promise<ChainResult> {
    const p = this.providers[provider];
    if (!p.available) {
      throw new NoProviderAvailableError(`${provider}: not configured`);
    }
    const failures: string[] = [];
    // For openrouter direct, iterate keys; for opencode direct, iterate triples
    // matching the model; for single-key providers, one attempt with retries.
    const maxIdx =
      provider === 'openrouter'
        ? this.providers.openrouter.keyCount
        : provider === 'opencode'
          ? Math.max(1, this.opencodeTripleCountForModel(model))
          : 1;
    for (let i = 0; i < maxIdx; i++) {
      if (signal.aborted) throw new NoProviderAvailableError('aborted');
      const res = await this.tryEntry(
        { provider, label: p.id, model, attemptIndex: i },
        model,
        body,
        signal,
        failures,
        { demoteOnKeyFailure: false },
      );
      if (res) return res;
    }
    throw new NoProviderAvailableError(`${provider} failed: ${failures.join('; ')}`);
  }

  /** Core flat-queue iteration, shared by walkAll and runChain. */
  private async iterate(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: { explicitModel?: string },
  ): Promise<ChainResult> {
    const failures: string[] = [];
    const order = this.queue.snapshot();
    for (const entry of order) {
      if (signal.aborted) throw new NoProviderAvailableError('aborted');
      // Pass model separately so tryEntry demotes the ORIGINAL entry reference
      // (spreading here would break identity and silently no-op demote).
      const model = opts.explicitModel ?? entry.model;
      const res = await this.tryEntry(entry, model, body, signal, failures, {
        demoteOnKeyFailure: true,
      });
      if (res) return res;
    }
    this.log.error({ failures, model: body.model }, 'all routing entries failed');
    throw new NoProviderAvailableError(`all routing entries failed: ${failures.join('; ')}`);
  }

  /** Attempt one entry with TRANSIENT retry-in-place. On KEY_FAILURE
   *  (when demoteOnKeyFailure), demote the entry to the back of the queue.
   *  `entry` MUST be the original queue reference for demotion to work. */
  private async tryEntry(
    entry: RoutingEntry,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
    failures: string[],
    behavior: { demoteOnKeyFailure: boolean },
  ): Promise<ChainResult | undefined> {
    const p = this.providers[entry.provider];
    if (!p.available) {
      failures.push(`${entry.label}:not-configured`);
      return undefined;
    }
    let attempt = 0;
    while (attempt <= env().MAX_TRANSIENT_RETRIES) {
      if (signal.aborted) return undefined;
      const res: ProviderCallResult = await this.callProvider(entry, model, body, signal);
      if (res.kind === 'OK') {
        // For openrouter, include the key index in the model field for log uniformity
        // (opencode shows the triple's model; openrouter shows default model + key index)
        const servedByModel =
          entry.provider === 'openrouter' ? `${model}[key${entry.attemptIndex + 1}]` : model;
        return { response: res.response, servedBy: { provider: entry.label, model: servedByModel } };
      }
      failures.push(`${entry.label}:${res.kind}(${res.status})`);
      this.log.debug(
        { provider: entry.label, kind: res.kind, status: res.status, msg: res.message },
        'routing entry attempt failed',
      );
      if (res.kind === 'TRANSIENT' && attempt < env().MAX_TRANSIENT_RETRIES) {
        attempt++;
        await sleep(backoffMs(attempt, env().TRANSIENT_BACKOFF_MS));
        continue;
      }
      if (res.kind === 'KEY_FAILURE' && behavior.demoteOnKeyFailure) {
        this.queue.demote(entry);
        this.log.warn(
          { provider: entry.label, label: 'chain', status: res.status },
          'chain entry demoted to back of queue',
        );
      }
      break;
    }
    return undefined;
  }

  /** Dispatch one attempt to the right provider with the right opts shape. */
  private async callProvider(
    entry: RoutingEntry,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
  ): Promise<ProviderCallResult> {
    const p = this.providers[entry.provider];
    if (entry.provider === 'openrouter') {
      return p.attempt(body, signal, { model, keyIndex: entry.attemptIndex });
    }
    if (entry.provider === 'opencode') {
      return p.attempt(body, signal, { model, tripleIndex: entry.attemptIndex });
    }
    return p.attempt(body, signal, { model });
  }

  /** Count OpenCode triples whose model matches (for direct:opencode/<model>). */
  private opencodeTripleCountForModel(model: string): number {
    return this.providers.opencode.queueSnapshot().filter((t) => t.model === model).length;
  }

  /** White-box: current routing-entry queue order (for tests/debug). */
  queueSnapshot(): readonly RoutingEntry[] {
    return this.queue.snapshot();
  }

  /** White-box (test-only): demote a specific entry. */
  demoteEntry(e: RoutingEntry): void {
    this.queue.demote(e);
  }
}
