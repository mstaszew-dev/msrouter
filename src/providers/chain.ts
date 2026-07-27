/**
 * Provider chain: routes requests through OpenRouter pool -> OpenAI -> ZAI -> OpenCode.
 * Aliases "mst/free" and "free" walk every provider with default models.
 * Prefix "direct:<provider>/<model>" pins a single provider.
 */
import type { Logger } from 'pino';
import { NoProviderAvailableError } from '../common/errors.js';
import { backoffMs, sleep } from '../common/retry.js';
import { env } from '../config/env.js';
import type { Providers } from './instances.js';
import { withFree } from './openrouter.js';
import type { ChatRequestBody, ProviderCallResult } from './types.js';
/** Extra OpenCode Zen free models tried sequentially in exhaustive walk. */
const EXTRA_OPENCODE_MODELS = [
  ['opencode-nemotron', 'OPENCODE_NEMOTRON_MODEL'] as const,
  ['opencode-deepseek-flash', 'OPENCODE_DEEPSEEK_FLASH_MODEL'] as const,
  ['opencode-mimo', 'OPENCODE_MIMO_MODEL'] as const,
  ['opencode-north-mini-code', 'OPENCODE_NORTH_MINI_CODE_MODEL'] as const,
  ['opencode-laguna', 'OPENCODE_LAGUNA_MODEL'] as const,
  ['opencode-ling', 'OPENCODE_LING_MODEL'] as const,
  ['opencode-qwen', 'OPENCODE_QWEN_MODEL'] as const,
  ['opencode-minimax', 'OPENCODE_MINIMAX_MODEL'] as const,
];
function envModel(key: string): string {
  return env()[key as keyof ReturnType<typeof env>] as string;
}
export interface ChainResult {
  /** Upstream Response to stream/return. */
  response: Response;
  /** Which provider + model served the request (for logging/metrics). */
  servedBy: { provider: string; model: string; keyTag?: string };
}
export class ProviderChain {
  constructor(
    private readonly providers: Providers,
    private readonly log: Logger,
  ) {}
  /**
   * Resolve request across chain. Returns first successful Response,
   * or throws NoProviderAvailableError if all failed.
   */
  async handle(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    const requested = body.model;
    const alias = env().WALK_ALIAS;
    if (alias.includes(requested)) {
      return this.walkAll(body, signal);
    }
    // Explicit model-id short-circuit by prefix.
    const sc = shortCircuit(requested);
    if (sc) return this.runSingle(sc.provider, sc.model, body, signal);
    // Default chain: OpenRouter pool first, then fallbacks with same model.
    return this.runChain(body, signal, { explicitModel: requested });
  }
  /**
   * Exhaustive walk: every OpenRouter key, then OpenAI, ZAI, OpenCode
   * bigpickle, then all extra OpenCode Zen free-model variants.
   */
  private async walkAll(body: ChatRequestBody, signal: AbortSignal): Promise<ChainResult> {
    const or = this.providers.openrouter;
    const orModel = withFree(env().OPENROUTER_MODEL, env().FORCE_FREE);
    const failures: string[] = [];
    if (or.available) {
      for (let i = 0; i < or.keyCount; i++) {
        if (signal.aborted) throw new NoProviderAvailableError('aborted');
        const res = await or.attempt(body, signal, { keyIndex: i, model: orModel });
        const handled = this.consume(res, `openrouter[key${i + 1}]`, orModel, failures);
        if (handled) return handled;
      }
    } else {
      failures.push('openrouter:not-configured');
    }
    // Standard fallback providers
    for (const [id, model] of [
      ['openai', env().OPENAI_MODEL],
      ['zai', env().ZAI_MODEL],
      ['opencode', env().OPENCODE_MODEL],
    ] as const) {
      if (signal.aborted) throw new NoProviderAvailableError('aborted');
      const handled = await this.trySingle(id, model, body, signal, failures);
      if (handled) return handled;
    }
    // Additional OpenCode Zen free models (same API key, different model id)
    const opencodeProvider = this.providers.opencode;
    if (opencodeProvider.available) {
      for (const [label, envKey] of EXTRA_OPENCODE_MODELS) {
        if (signal.aborted) throw new NoProviderAvailableError('aborted');
        const handled = await this.trySingle('opencode', envModel(envKey), body, signal, failures);
        if (handled) return { ...handled, servedBy: { ...handled.servedBy, provider: label } };
      }
    } else {
      failures.push('opencode:not-configured');
    }
    this.log.error({ failures, model: body.model }, 'all providers failed (walk)');
    throw new NoProviderAvailableError(`all providers failed: ${failures.join('; ')}`);
  }
  /** OpenRouter pool first, then OpenAI/ZAI/OpenCode, using explicitModel. */
  private async runChain(
    body: ChatRequestBody,
    signal: AbortSignal,
    opts: { explicitModel: string },
  ): Promise<ChainResult> {
    const or = this.providers.openrouter;
    const orModel = withFree(opts.explicitModel, env().FORCE_FREE);
    const failures: string[] = [];
    if (or.available) {
      for (let i = 0; i < or.keyCount; i++) {
        if (signal.aborted) throw new NoProviderAvailableError('aborted');
        const res = await or.attempt(body, signal, { keyIndex: i, model: orModel });
        const handled = this.consume(res, `openrouter[key${i + 1}]`, orModel, failures);
        if (handled) return handled;
      }
    } else {
      failures.push('openrouter:not-configured');
    }
    // Fallbacks with the same explicit model.
    for (const id of ['openai', 'zai', 'opencode'] as const) {
      if (signal.aborted) throw new NoProviderAvailableError('aborted');
      const handled = await this.trySingle(id, opts.explicitModel, body, signal, failures);
      if (handled) return handled;
    }
    this.log.error({ failures, model: body.model }, 'all providers failed (chain)');
    throw new NoProviderAvailableError(`all providers failed: ${failures.join('; ')}`);
  }
  /** Run ONE single-key provider (short-circuit). */
  private async runSingle(
    id: keyof Providers,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
  ): Promise<ChainResult> {
    const failures: string[] = [];
    const handled = await this.trySingle(id, model, body, signal, failures);
    if (handled) return handled;
    this.log.error({ failures, provider: id, model }, 'short-circuit provider failed');
    throw new NoProviderAvailableError(`${id} failed: ${failures.join('; ')}`);
  }
  /**
   * Attempt a single-key provider with transient retries. Uses `p.id` as the
   * label in consume/failures so logs show the provider's own name (e.g.
   * "opencode-bigpickle") rather than the lookup key.
   */
  private async trySingle(
    id: keyof Providers,
    model: string,
    body: ChatRequestBody,
    signal: AbortSignal,
    failures: string[],
  ): Promise<ChainResult | undefined> {
    const p = this.providers[id];
    if (!p.available) {
      failures.push(`${p.id}:not-configured`);
      return undefined;
    }
    let attempt = 0;
    while (attempt <= env().MAX_TRANSIENT_RETRIES) {
      const res = await p.attempt(body, signal, { model });
      const handled = this.consume(res, p.id, model, failures);
      if (handled) return handled;
      if (res.kind === 'TRANSIENT' && attempt < env().MAX_TRANSIENT_RETRIES) {
        attempt++;
        await sleep(backoffMs(attempt, env().TRANSIENT_BACKOFF_MS));
        continue;
      }
      break;
    }
    return undefined;
  }
  /**
   * Interpret an OpenRouter attempt result. OpenRouter retries are advanced by
   * the caller re-invoking attempt() with the next keyIndex, so here we do NOT
   * retry transient on OpenRouter inside one key (the whole pool is the retry).
   * Returns the ChainResult on OK, else records the failure and returns undefined.
   */
  private consume(
    res: ProviderCallResult,
    label: string,
    model: string,
    failures: string[],
  ): ChainResult | undefined {
    if (res.kind === 'OK') {
      return {
        response: res.response,
        servedBy: { provider: label, model, keyTag: label.includes('[') ? label : undefined },
      };
    }
    failures.push(`${label}:${res.kind}(${res.status})`);
    this.log.debug(
      { provider: label, kind: res.kind, status: res.status, msg: res.message },
      'provider attempt failed',
    );
    return undefined;
  }
}
/** Detect direct:<provider>/<model> prefix to pin a single provider. */
function shortCircuit(
  model: string,
): { provider: keyof Providers; model: string } | null {
  const m = model.toLowerCase();
  if (!m.startsWith('direct:')) return null;
  const rest = model.slice('direct:'.length);
  const restLower = rest.toLowerCase();
  if (restLower.startsWith('openai/')) {
    return { provider: 'openai', model: rest.slice('openai/'.length) };
  }
  if (restLower.startsWith('opencode/')) {
    const modelId = rest.slice('opencode/'.length).toLowerCase();
    // Map specific OpenCode Zen model IDs to their dedicated provider instances
    const providerMap: Record<string, keyof Providers> = {
      'nemotron-3-ultra-free': 'opencodeNemotron',
      'deepseek-v4-flash-free': 'opencodeDeepSeekFlash',
      'mimo-v2.5-free': 'opencodeMiMo',
      'north-mini-code-free': 'opencodeNorthMiniCode',
      'laguna-s-2.1-free': 'opencodeLaguna',
      'ling-3.0-flash-free': 'opencodeLing',
      'qwen3.6-plus-free': 'opencodeQwen',
      'minimax-m3-free': 'opencodeMiniMax',
    };
    const provider = providerMap[modelId];
    if (provider) return { provider, model: modelId };
    // Fallback: use base opencode provider (big-pickle) with the requested model
    return { provider: 'opencode', model: modelId };
  }
  if (restLower.startsWith('zai/') || restLower.startsWith('glm-')) {
    return { provider: 'zai', model: rest };
  }
  return null;
}
