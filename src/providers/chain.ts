/**
 * Provider chain with adaptive flat-sequence rotation.
 *
 * On construction, builds ONE flat ordered list of Candidate triples
 * `<model, provider, keyIndex>` (delegated to chain-candidates.ts) and wraps it
 * in a CandidateQueue. Every `handle()` call iterates the queue from the front:
 *   - OK       -> return the response.
 *   - KEY_FAILURE (401/402/403/429) -> demote this candidate to the back, try next.
 *   - TRANSIENT (5xx/408/425)      -> backoff-retry in place up to MAX_TRANSIENT_RETRIES.
 *   - BAD_REQUEST (other 4xx)      -> skip to next candidate (do not demote).
 *
 * Demotion is permanent for the life of the process (no TTL, in-memory only).
 * Restart rebuilds the queue from env in the original declared order.
 *
 * Aliases "mst/free" and "free" walk the SAME candidate list using each
 * candidate's provider-default model. Prefix "direct:<provider>/<model>" pins a
 * single provider and disables fallback.
 */

import type { Logger } from 'pino';

import { NoProviderAvailableError } from '../common/errors.js';
import { backoffMs, sleep } from '../common/retry.js';
import { env } from '../config/env.js';

import {
  buildCandidateList,
  shortCircuit,
  type Candidate,
  type ChainProvider,
} from './chain-candidates.js';
import type { Providers } from './instances.js';
import { withFree } from './openrouter.js';
import { CandidateQueue } from './rotation.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';

// Re-export so existing imports of `Candidate` from './chain.js' keep working.
export type { Candidate } from './chain-candidates.js';

export interface ChainResult {
  response: Response;
  servedBy: { provider: string; model: string; keyTag?: string };
}

export class ProviderChain {
  private readonly queue: CandidateQueue<Candidate>;

  constructor(
    private readonly providers: Providers,
    private readonly log: Logger,
  ) {
    this.queue = new CandidateQueue(buildCandidateList(providers), { log, label: 'chain' });
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

  /** Walk every candidate using each provider's default model. */
  private async walkAll(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    return this.iterate(body, signal, {});
  }

  /** Walk every candidate using the client's explicit model. */
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
      const res = await this.tryCandidate(
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
    for (const candidate of order) {
      if (signal.aborted) throw new NoProviderAvailableError('aborted');
      // Pass model separately so tryCandidate demotes the ORIGINAL candidate
      // reference (spreading here would break identity and silently no-op demote).
      const model = opts.explicitModel ?? candidate.model;
      const res = await this.tryCandidate(candidate, model, body, signal, failures, {
        demoteOnKeyFailure: true,
      });
      if (res) return res;
    }
    this.log.error({ failures, model: body.model }, 'all candidates failed');
    throw new NoProviderAvailableError(`all candidates failed: ${failures.join('; ')}`);
  }

  /** Attempt one candidate with TRANSIENT retry-in-place. On KEY_FAILURE
   *  (when demoteOnKeyFailure), demote the candidate to the back of the queue.
   *  `candidate` MUST be the original queue reference for demotion to work. */
  private async tryCandidate(
    candidate: Candidate,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
    failures: string[],
    behavior: { demoteOnKeyFailure: boolean },
  ): Promise<ChainResult | undefined> {
    const p = this.providers[candidate.provider];
    if (!p.available) {
      failures.push(`${candidate.label}:not-configured`);
      return undefined;
    }
    let attempt = 0;
    while (attempt <= env().MAX_TRANSIENT_RETRIES) {
      if (signal.aborted) return undefined;
      const res: ProviderCallResult = await this.callProvider(candidate, model, body, signal);
      if (res.kind === 'OK') {
        return { response: res.response, servedBy: { provider: candidate.label, model } };
      }
      failures.push(`${candidate.label}:${res.kind}(${res.status})`);
      this.log.debug(
        { provider: candidate.label, kind: res.kind, status: res.status, msg: res.message },
        'candidate attempt failed',
      );
      if (res.kind === 'TRANSIENT' && attempt < env().MAX_TRANSIENT_RETRIES) {
        attempt++;
        await sleep(backoffMs(attempt, env().TRANSIENT_BACKOFF_MS));
        continue;
      }
      if (res.kind === 'KEY_FAILURE' && behavior.demoteOnKeyFailure) {
        this.queue.demote(candidate);
      }
      break;
    }
    return undefined;
  }

  /** Dispatch one attempt to the right provider with the right opts shape. */
  private async callProvider(
    candidate: Candidate,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
  ): Promise<ProviderCallResult> {
    const p = this.providers[candidate.provider];
    if (candidate.provider === 'openrouter') {
      return p.attempt(body, signal, { model, keyIndex: candidate.attemptIndex });
    }
    if (candidate.provider === 'opencode') {
      return p.attempt(body, signal, { model, tripleIndex: candidate.attemptIndex });
    }
    return p.attempt(body, signal, { model });
  }

  /** Count OpenCode triples whose model matches (for direct:opencode/<model>). */
  private opencodeTripleCountForModel(model: string): number {
    return this.providers.opencode.queueSnapshot().filter((t) => t.model === model).length;
  }

  /** White-box: current candidate queue order (for tests/debug). */
  queueSnapshot(): readonly Candidate[] {
    return this.queue.snapshot();
  }

  /** White-box (test-only): demote a specific candidate. */
  demoteCandidate(c: Candidate): void {
    this.queue.demote(c);
  }
}
