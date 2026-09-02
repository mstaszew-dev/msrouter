/**
 * The HTTP server. Reads the request body (only for JSON POSTs - streaming
 * requests are also small JSON envelopes), applies correlation id, dispatches
 * to the router, and runs the handler with centralized error handling.
 *
 * Plain node:http (no framework) so SSE can pass straight through.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';

import { errorMessage, toErrorBody } from '../common/errors.js';
import { applyCorrelationId, type HttpRequest, Router, sendJson } from '../common/http.js';

import { registerHandlers } from './handlers.js';
import type { HandlerDeps } from './handlers.js';

export interface ServerOptions extends HandlerDeps {
  port: number;
}

export function createGatewayServer(opts: ServerOptions): Server {
  const router = new Router((_req, res) => sendJson(res, 404, { error: 'not found' }));
  registerHandlers(router, { chain: opts.chain, log: opts.log });

  const server = createServer((incoming, res) => {
    const req = incoming as HttpRequest;
    applyCorrelationId(req, res);

    void (async () => {
      // Read body for POST JSON endpoints. Cap at 10MB to bound memory.
      if (req.method === 'POST') {
        const ok = await readJsonBody(req, res, opts.log);
        if (!ok) return;
      }

      try {
        await router.dispatch(req, res);
      } catch (e) {
        if (!res.headersSent) {
          const { status, body } = toErrorBody(e, req.id);
          opts.log.error({ err: errorMessage(e) }, 'dispatch error');
          sendJson(res, status, body);
        } else {
          opts.log.error({ err: errorMessage(e) }, 'dispatch error after headers sent');
          res.destroy();
        }
      }
    })().catch((e) => {
      opts.log.error({ err: errorMessage(e) }, 'request handler crashed');
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
      } else {
        res.destroy();
      }
    });
  });

  server.listen(opts.port);
  return server;
}

/** Read and JSON-parse the body; reject oversized or malformed payloads. */
async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<boolean> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(c);
    size += c.length;
    if (size > 10 * 1024 * 1024) {
      log.warn({ correlationId: req.id }, 'request body too large');
      sendJson(res, 413, {
        error: { code: 'BAD_REQUEST', message: 'request body too large (max 10MB)' },
      });
      return false;
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      log.warn({ correlationId: req.id }, 'request body is not valid JSON');
      sendJson(res, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'request body is not valid JSON' },
      });
      return false;
    }
  }
  return true;
}
