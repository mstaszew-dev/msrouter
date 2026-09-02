/**
 * The admin console HTTP server: same framework-free style as the gateway
 * (node:http + common/http Router), plus:
 *   - JWT auth on the API routes (see handlers.ts)
 *   - security headers on every response
 *   - static SPA serving from the built web console (web/dist) with an
 *     index.html fallback for client-side routes and a traversal guard
 *
 * This server is intentionally separate from the gateway process and never
 * touches routing/provider logic.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { errorMessage, NotFoundError, toErrorBody } from '../common/errors.js';
import { applyCorrelationId, type HttpRequest, Router, sendJson } from '../common/http.js';

import { registerAdminHandlers, type AdminHandlerDeps } from './handlers.js';
import { RateLimiter } from './rateLimit.js';

export interface AdminServerOptions extends Omit<AdminHandlerDeps, 'rateLimiter'> {
  /** Injected by tests; a default 5-attempts-per-minute limiter is used otherwise. */
  rateLimiter?: RateLimiter;
  /** Directory containing the built web console (index.html); optional. */
  webDistDir?: string;
}

const MAX_BODY_BYTES = 1024 * 1024; // admin payloads are tiny; 1MB is generous

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createAdminServer(opts: AdminServerOptions): Server {
  const router = new Router((_req, res) =>
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } }),
  );
  registerAdminHandlers(router, {
    ...opts,
    rateLimiter: opts.rateLimiter ?? new RateLimiter({ maxAttempts: 5, windowMs: 60_000 }),
  });

  const webRoot = opts.webDistDir ? resolve(opts.webDistDir) : undefined;

  const server = createServer((incoming, res) => {
    const req = incoming as HttpRequest;
    applyCorrelationId(req, res);
    applySecurityHeaders(res, undefined);

    void (async () => {
      if (['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) {
        const ok = await readJsonBody(req, res);
        if (!ok) return;
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/api/')) {
          await router.dispatch(req, res);
        } else if (req.method === 'GET' || req.method === 'HEAD') {
          await serveStatic(req, res, url.pathname, webRoot);
        } else {
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
        }
      } catch (e) {
        if (!res.headersSent) {
          const { status, body } = toErrorBody(e, req.id);
          if (status >= 500) {
            opts.log.error({ err: errorMessage(e), correlationId: req.id }, 'admin request failed');
          } else {
            opts.log.warn(
              { err: errorMessage(e), correlationId: req.id },
              'admin request rejected',
            );
          }
          sendJson(res, status, body);
        } else {
          res.destroy();
        }
      }
    })().catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'internal error' },
        });
      } else {
        res.destroy();
      }
    });
  });

  return server;
}

async function readJsonBody(req: HttpRequest, res: ServerResponse): Promise<boolean> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(c);
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      res.setHeader('connection', 'close'); // body undrained: do not reuse socket
      sendJson(res, 413, {
        error: { code: 'BAD_REQUEST', message: 'request body too large' },
      });
      return false;
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'request body is not valid JSON' },
      });
      return false;
    }
  }
  return true;
}

/** Security headers applied to every static and API response. */
function applySecurityHeaders(res: ServerResponse, contentType: string | undefined): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  if (contentType?.startsWith('text/html')) {
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
  }
}

async function serveStatic(
  req: HttpRequest,
  res: ServerResponse,
  pathname: string,
  webRoot: string | undefined,
): Promise<void> {
  if (!webRoot) {
    throw new NotFoundError('static content (WEB_DIST not configured)');
  }
  // Only path segments up to the first dot-containing segment map to files;
  // extensionless paths are client-side routes and fall back to index.html.
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = resolve(webRoot, normalize(relative));
  if (!candidate.startsWith(webRoot + sep) && candidate !== webRoot) {
    sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'bad path' } });
    return;
  }
  let filePath: string | undefined;
  if (relative === '') {
    filePath = join(webRoot, 'index.html');
  } else {
    try {
      const st = await stat(candidate);
      if (st.isFile()) filePath = candidate;
    } catch {
      // not a file: fall through to SPA fallback
    }
    filePath ??= join(webRoot, 'index.html');
  }

  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch {
    throw new NotFoundError('static content');
  }
  const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  applySecurityHeaders(res, contentType);
  res.writeHead(200, { 'content-type': contentType, 'content-length': content.length });
  res.end(req.method === 'HEAD' ? undefined : content);
}
