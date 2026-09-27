/**
 * Integration test for the upstream LLM transport: a real local HTTP server
 * that withholds response headers, proving the production transport does
 * not prematurely abort a slow-headers request.
 *
 * Background (2026-09-27): Node's core fetch aborts requests whose headers
 * have not arrived after its built-in 300s default; the tailnet Ollama
 * endpoint holds headers back for the entire prefill. The npm undici
 * transport in http-agent.ts does not enforce that timeout (verified; see
 * module doc) - this test pins that behavior so an undici upgrade that
 * starts enforcing it fails loudly here instead of silently killing slow
 * upstreams again.
 *
 * Binds a real 127.0.0.1 socket; no external network is touched.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { slowUpstreamFetch } from './http-agent.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A server that sends response headers + body only after delayMs. */
function delayedHeadersServer(delayMs: number): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, delayMs);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/v1/chat/completions`);
    });
  });
}

describe('upstream fetch transport (slow-headers, integration)', () => {
  it('does NOT abort when headers arrive after 500ms; the caller signal is the only ceiling', async () => {
    const url = await delayedHeadersServer(500);
    const res = await slowUpstreamFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });

  it('still honors the caller AbortSignal as the hard ceiling', async () => {
    const url = await delayedHeadersServer(2_000);
    await expect(
      slowUpstreamFetch(url, { method: 'GET', signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow();
  });
});
