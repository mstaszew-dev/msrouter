/**
 * Gateway HTTP handlers. Wires the provider chain to the OpenAI/OpenRouter
 * surface:
 *   POST /api/v1/chat/completions  -> validate, route via chain, stream/return
 *   GET  /api/v1/models            -> list the gateway's virtual models
 *   GET  /health/live | /health/ready
 *
 * Idempotency (Idempotency-Key header) is delegated to ./idempotency.ts.
 */

import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import type { Logger } from 'pino';

import { DomainError, errorMessage, toErrorBody, ValidationError } from '../common/errors.js';
import type { HttpRequest, Router } from '../common/http.js';
import { sendJson } from '../common/http.js';
import { env, config } from '../config/env.js';
import { type ProviderChain } from '../providers/chain.js';
import { scrubSecrets } from '../providers/fetch.js';
import type { ChatRequestBody } from '../providers/types.js';

import { beginIdem, dropIdem, idempotencyHit, storeIdemResult } from './idempotency.js';
import { createGraphqlHandler } from './graphql.js';
import { pipeSseStream } from './stream.js';
import { chatCompletionSchema } from './validation.js';

export interface HandlerDeps {
  chain: ProviderChain;
  log: Logger;
}

export function registerHandlers(router: Router, deps: HandlerDeps): void {
  const { chain, log } = deps;

  const chat = (req: HttpRequest, res: ServerResponse) => handleChat(req, res, chain, log);
  // Serve BOTH the OpenAI-standard path (/v1/...) and the original (/api/v1/...)
  // so the gateway is a drop-in for any OpenAI/OpenRouter client. Many clients
  // (openai SDK, OpenClaw openai-completions, Continue) hardcode /v1.
  router.add('POST', '/v1/chat/completions', chat);
  router.add('POST', '/api/v1/chat/completions', chat);
  router.add('GET', '/v1/models', (_req, res) => handleModels(res));
  router.add('GET', '/api/v1/models', (_req, res) => handleModels(res));
  router.add('GET', '/health/live', (_req, res) =>
    sendJson(res, 200, { status: 'ok', uptime: process.uptime() }),
  );
  // GraphQL endpoint (models/health queries + completion mutation).
  router.add('POST', '/graphql', createGraphqlHandler(chain, log));
  router.add('GET', '/health/ready', (_req, res) =>
    sendJson(res, 200, { status: 'ok', providers: 'see /metrics' }),
  );
}

async function handleChat(
  req: HttpRequest,
  res: ServerResponse,
  chain: ProviderChain,
  log: Logger,
): Promise<void> {
  if (!checkGatewayAuth(req, res, log)) return;

  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(
      res,
      req,
      new ValidationError('invalid request body', {
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      }),
      log,
    );
    return;
  }
  const body = parsed.data as ChatRequestBody;
  // Forbearing default: if the client sent a model the gateway does not
  // recognize (not the alias, not a direct: prefix, not a configured
  // per-provider default), rewrite it to the walk alias (mst/free). This keeps
  // clients that send a placeholder/generic model id working through the full
  // pool + fallback, instead of 4xx'ing or passing a bogus id upstream.
  body.model = resolveModel(body.model);

  // Idempotency (non-streaming only): serve cached value / await in-flight.
  const idemKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
  if (idemKey && !body.stream) {
    if (await idempotencyHit(idemKey, res)) return;
  }

  // Per-request abort: cancel upstream when the client disconnects.
  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const idem = beginIdem(idemKey, body.stream);

  try {
    const result = await chain.handle(body, ac.signal);

    if (body.stream) {
      log.info(
        { correlationId: req.id, servedBy: result.servedBy, stream: true },
        'chat completion streaming',
      );
      await pipeSseStream({ upstream: result.response, res, signal: ac.signal });
      return;
    }

    const text = await result.response.text();
    const status = result.response.status;
    const json = parseUpstreamJson(text);
    log.info({ correlationId: req.id, servedBy: result.servedBy, status }, 'chat completion ok');
    if (idem) storeIdemResult(idem, status, json);
    sendJson(res, status, json);
  } catch (e) {
    // Abort (client disconnect) or real failure: drop the idem entry so the
    // next attempt runs fresh, then either end quietly or surface the error.
    dropIdem(idemKey);
    idem?.reject(e);
    if (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendError(res, req, e, log);
  }
}

/** Optional bearer-token gateway auth. Returns false if it already responded. */
function checkGatewayAuth(req: HttpRequest, res: ServerResponse, log: Logger): boolean {
  const token = env().GATEWAY_TOKEN;
  if (!token) return true;
  const auth = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
  if (constantTimeEqual(auth, `Bearer ${token}`)) return true;
  sendError(res, req, new ValidationError('invalid gateway token'), log);
  return false;
}

/** Parse upstream text as JSON; on failure, scrub + wrap so no secret leaks. */
function parseUpstreamJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Scrub the raw upstream text before returning it to the client; upstream
    // error bodies can echo request secrets (NODEJS_CODE_REVIEW.md section 4).
    return { error: 'upstream returned non-JSON', raw: scrubSecrets(text.slice(0, 500)) };
  }
}

/**
 * Constant-time string compare so the gateway token check has no timing or
 * length oracle. NODEJS_CODE_REVIEW.md section 4 (auth, secrets).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still compare to keep the timing roughly constant; the result is false.
    timingSafeEqual(Buffer.from(b), Buffer.from(b));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Resolve the requested model. A known model (a walk alias, a `direct:` prefix,
 * or one of the configured per-provider defaults) is passed through unchanged.
 * An UNKNOWN model is rewritten to the first walk alias (e.g. `mst/free`) so
 * the request flows through the full pool + fallback instead of failing or
 * sending a bogus id upstream. This makes the gateway forgiving for clients
 * that send a placeholder or generic model id.
 */
export function resolveModel(requested: string): string {
  const cfg = env();
  if (cfg.WALK_ALIAS.includes(requested)) return requested;
  if (requested.toLowerCase().startsWith('direct:')) return requested;
  const known = new Set([
    cfg.OPENROUTER_MODEL,
    cfg.OPENAI_MODEL,
    cfg.ZAI_MODEL,
    cfg.OPENCODE_MODEL,
  ]);
  if (known.has(requested)) return requested;
  // Unknown: default to the alias walk.
  return cfg.WALK_ALIAS[0] ?? 'mst/free';
}

/** The gateway's virtual models (OpenAI/OpenRouter-compatible shape).
 *  Shared by GET /v1/models and the GraphQL `models` query. */
export function buildModelList(): Array<{ id: string; object: string; owned_by: string }> {
  const cfg = env();
  const data: Array<{ id: string; object: string; owned_by: string }> = [
    ...cfg.WALK_ALIAS.map((alias) => ({ id: alias, object: 'model', owned_by: 'msrouter' })),
    { id: cfg.OPENROUTER_MODEL, object: 'model', owned_by: 'openrouter' },
  ];
  if (cfg.OPENAI_API_KEY) data.push({ id: cfg.OPENAI_MODEL, object: 'model', owned_by: 'openai' });
  if (cfg.ZAI_API_KEY) data.push({ id: cfg.ZAI_MODEL, object: 'model', owned_by: 'zai' });
  if (config().opencodeKeys.length > 0) {
    data.push({ id: cfg.OPENCODE_MODEL, object: 'model', owned_by: 'opencode-bigpickle' });
    data.push({ id: cfg.OPENCODE_NEMOTRON_MODEL, object: 'model', owned_by: 'opencode-nemotron' });
    data.push({ id: cfg.OPENCODE_DEEPSEEK_FLASH_MODEL, object: 'model', owned_by: 'opencode-deepseek-flash' });
    data.push({ id: cfg.OPENCODE_MIMO_MODEL, object: 'model', owned_by: 'opencode-mimo' });
    data.push({ id: cfg.OPENCODE_NORTH_MINI_CODE_MODEL, object: 'model', owned_by: 'opencode-north-mini-code' });
    data.push({ id: cfg.OPENCODE_LAGUNA_MODEL, object: 'model', owned_by: 'opencode-laguna' });
    data.push({ id: cfg.OPENCODE_LING_MODEL, object: 'model', owned_by: 'opencode-ling' });
    data.push({ id: cfg.OPENCODE_QWEN_MODEL, object: 'model', owned_by: 'opencode-qwen' });
    data.push({ id: cfg.OPENCODE_MINIMAX_MODEL, object: 'model', owned_by: 'opencode-minimax' });
  }
  return data;
}

/** List the gateway's virtual models (OpenAI/OpenRouter-compatible shape). */
function handleModels(res: ServerResponse): void {
  sendJson(res, 200, { object: 'list', data: buildModelList() });
}

/** Centralized error response: maps DomainError subclasses to status + body. */
function sendError(res: ServerResponse, req: HttpRequest, e: unknown, log: Logger): void {
  const { status, body } = toErrorBody(e, req.id);
  if (e instanceof DomainError) {
    log.warn({ err: errorMessage(e), code: body.error.code }, 'domain error');
  } else {
    log.error({ err: errorMessage(e) }, 'unexpected error');
  }
  sendJson(res, status, body);
}
