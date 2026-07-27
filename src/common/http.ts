/**
 * Minimal HTTP helpers around node:http. Provides:
 *   - a typed Router with method+path matching
 *   - JSON send helpers
 *   - request-id (correlation id) propagation
 *
 * Kept framework-free so SSE streaming can pass straight through without a
 * middleware chain buffering the body.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type Handler = (req: HttpRequest, res: ServerResponse) => void | Promise<void>;

export interface HttpRequest extends IncomingMessage {
  id: string;
  params: Record<string, string>;
  /** Parsed JSON body (only for non-streaming JSON requests). */
  body?: unknown;
}

export interface Route {
  method: string;
  /** Path pattern; `:seg` captures into req.params. */
  pattern: string;
  handler: Handler;
}

const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Read or mint a correlation id and echo it on the response. */
export function applyCorrelationId(req: HttpRequest, res: ServerResponse): void {
  const incoming = (req.headers[CORRELATION_ID_HEADER] as string | undefined)?.trim();
  const id = incoming && incoming.length <= 128 ? incoming : cryptoRandomId();
  req.id = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
}

function cryptoRandomId(): string {
  // crypto.randomUUID is available on Node >= 14.17 (global).
  return (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.() ?? randFallback();
}

function randFallback(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Match a path against a `:seg` pattern; returns params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    const actual = ap[i]!;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(actual);
    } else if (seg !== actual) {
      return null;
    }
  }
  return params;
}

export class Router {
  private routes: Route[] = [];
  private notFound: Handler;

  constructor(notFound: Handler = (_req, res) => sendJson(res, 404, { error: 'not found' })) {
    this.notFound = notFound;
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  /** Resolve the handler + params for a method+pathname. */
  resolve(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const params = matchPath(route.pattern, pathname);
      if (params) {
        return { route, params };
      }
    }
    return null;
  }

  getRoutes(): readonly Route[] {
    return this.routes;
  }

  dispatch(req: HttpRequest, res: ServerResponse): Promise<void> | void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = this.resolve(req.method ?? 'GET', url.pathname);
    if (!matched) {
      return this.notFound(req, res);
    }
    req.params = matched.params;
    return matched.route.handler(req, res);
  }
}

export type { Server };
