/**
 * Provider chain with adaptive flat-sequence rotation.
 *
 * On construction, builds ONE flat ordered list of RoutingEntry triples
 * `<model, provider, keyIndex>` (delegated to chain-routing.ts) and wraps it in
 * a RotationQueue. Every `handle()` call iterates the queue from the front:
 *   - OK       -> return the response.
 *   - KEY_FAILURE (401/402/403/429) -> demote to back; 429 also PARKS the
 *     entry for RATE_LIMIT_COOLDOWN_MS (walks skip parked entries, so a
 *     rate-limit storm does not re-hammer every limited key per request).
 *   - TRANSIENT (5xx/408/425)      -> backoff-retry in place up to MAX_TRANSIENT_RETRIES.
 *   - BAD_REQUEST (other 4xx)      -> skip to next entry (do not demote).
 *
 * Demotion/parking is in-memory only; restart rebuilds from env order.
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
  isProviderDefaultModel,
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
  private readonly consecutiveSuccesses = new Map<string, number>();
  private readonly successDemoteLimit: number;

  constructor(
    private readonly providers: Providers,
    private readonly log: Logger,
  ) {
    this.queue = new RotationQueue(buildRoutingEntries(providers), { log, label: 'chain' });
    // zod guarantees SUCCESS_DEMOTE_LIMIT (coerced int, default 5).
    this.successDemoteLimit = env().SUCCESS_DEMOTE_LIMIT;
  }

  async handle(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    const requested = body.model;
    if (env().WALK_ALIAS.includes(requested)) return this.iterate(body, signal, {});
    const sc = shortCircuit(requested);
    if (sc) return this.runSingle(sc.provider, sc.model, body, signal);
    const explicit = isProviderDefaultModel(requested)
      ? requested
      : withFree(requested, env().FORCE_FREE);
    return this.iterate(body, signal, { explicitModel: explicit });
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

  /** Core flat-queue iteration, shared by the alias walk and the explicit-
   *  model path. First pass walks ELIGIBLE entries only (429-parked ones
   *  skip their cooldown; see park()); if it fails while entries were
   *  parked, a second pass retries the parked remainder so a hopeless-but-
   *  never-parked entry (401 key, unavailable provider) cannot defeat the
   *  fallback and a parked entry that has recovered is still reachable. */
  private async iterate(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: { explicitModel?: string },
  ): Promise<ChainResult> {
    const failures: string[] = [];
    const pass = async (entries: readonly RoutingEntry[]): Promise<ChainResult | undefined> => {
      for (const entry of entries) {
        if (signal.aborted) throw new NoProviderAvailableError('aborted');
        const res = await this.tryEntry(entry, opts.explicitModel ?? entry.model, body, signal, failures, {
          demoteOnKeyFailure: true,
        });
        if (res) return res;
      }
      return undefined;
    };
    const order = this.queue.eligible();
    const served =
      (await pass(order)) ??
      (order.length < this.queue.length
        ? await pass(this.queue.snapshot().filter((e) => !order.includes(e)))
        : undefined);
    if (served) return served;
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
        // resolvedModel: the provider may resolve an alias (LM Studio -> GGUF).
        const resolvedModel = res.resolvedModel ?? model;
        const servedByModel =
          entry.provider === 'openrouter' ? `${resolvedModel}[key${entry.attemptIndex + 1}]` : resolvedModel;
        // Consecutive-success demotion: the weak local tail rotates to the
        // back at SUCCESS_DEMOTE_LIMIT so it never monopolizes the chain.
        const count = (this.consecutiveSuccesses.get(entry.label) ?? 0) + 1;
        this.consecutiveSuccesses.set(entry.label, count);
        // Weak local tail (local/lmstudio/laptop): "always works", so it must
        // never accumulate preference - rotate to the back at the limit.
        const isLocal =
          entry.provider === 'lmstudio' || entry.provider === 'local' || entry.provider === 'laptop';
        if (isLocal && count >= this.successDemoteLimit) {
          this.queue.demote(entry);
          this.consecutiveSuccesses.set(entry.label, 0);
          this.log.warn(
            { provider: entry.label, successes: count, label: 'chain' },
            'local provider demoted after consecutive successes',
          );
        }
        return { response: res.response, servedBy: { provider: entry.label, model: servedByModel } };
      }
      failures.push(`${entry.label}:${res.kind}(${res.status})`);
      const badReq = res.kind === 'BAD_REQUEST';
      this.log[badReq ? 'info' : 'debug'](
        { provider: entry.label, kind: res.kind, status: res.status, msg: res.message },
        badReq ? 'routing entry skipped (bad request)' : 'routing entry attempt failed',
      );
      this.consecutiveSuccesses.set(entry.label, 0); // reset on any failure
      if (res.kind === 'TRANSIENT' && attempt < env().MAX_TRANSIENT_RETRIES) {
        attempt++;
        await sleep(backoffMs(attempt, env().TRANSIENT_BACKOFF_MS));
        continue;
      }
      // KEY_FAILURE demotes when configured; BAD_REQUEST and (per the original
      // semantics) empty-completion TRANSIENT responses fall through to skip
      // this entry and try the next one.
      if (res.kind === 'KEY_FAILURE' && behavior.demoteOnKeyFailure) {
        this.queue.demote(entry);
        this.log.warn(
          { provider: entry.label, label: 'chain', status: res.status },
          'chain entry demoted to back of queue',
        );
        // 429 also parks the entry for the cooldown window (RATE_LIMIT_
        // COOLDOWN_MS): a demoted-only entry is retried on the very next
        // request, which re-hammered the whole limited pool each request
        // (2-8 min walks, 2026-09-08). Non-429 key failures (401/402/403)
        // demote only: a bad key is not cooling down.
        if (res.status === 429 && env().RATE_LIMIT_COOLDOWN_MS > 0) {
          this.queue.park(entry, env().RATE_LIMIT_COOLDOWN_MS, `429 (${entry.label})`);
        }
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
