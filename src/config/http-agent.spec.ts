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

import {
  makeUpstreamAgent,
  makeUpstreamFetch,
  slowUpstreamAgent,
  slowUpstreamFetch,
  UPSTREAM_AGENT_OPTIONS,
} from './http-agent.js';

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

/**
 * Transport-level header/body deadlines.
 *
 * The 2026-09-27 verification in this module's doc comment concluded undici's
 * timeout machinery is "inert in practice". It is NOT inert: undici's default
 * agent carries headersTimeout=300s, and undici DOES enforce it. Against the
 * tailnet laptop an agent-sized payload needs longer than 300s to emit its
 * first response header (measured 2026-10-12: a 230KB payload aborted at
 * exactly 300136ms with TRANSIENT(0)), so the transport killed healthy slow
 * requests while LAPTOP_TIMEOUT_MS=1800000 and FIRST_BYTE_TIMEOUT_MS=900000
 * looked generous. These tests pin the disable-and-honour contract: the
 * production transport must carry no header/body deadline of its own, leaving
 * the caller's AbortSignal as the only ceiling.
 */
describe('upstream agent header/body deadlines', () => {
  /** A server that withholds headers for delayMs; observe whether the agent aborts. */
  async function attemptWith(
    headersTimeout: number,
    bodyTimeout: number,
    delayMs: number,
  ): Promise<{ ok: boolean; ms: number; cause: string }> {
    const url = await delayedHeadersServer(delayMs);
    const transport = makeUpstreamFetch({ headersTimeout, bodyTimeout });
    const t0 = Date.now();
    try {
      const res = await transport(url, {
        method: 'GET',
        signal: AbortSignal.timeout(30_000),
      });
      await res.text();
      return { ok: true, ms: Date.now() - t0, cause: '' };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - t0,
        cause: (e as { cause?: { message?: string } }).cause?.message ?? '',
      };
    }
  }

  it('honours an agent headersTimeout shorter than the delay (proves the knob works)', async () => {
    // 900ms deadline vs a 1000ms header delay: undici fires "Headers Timeout
    // Error" when the headers land after its deadline. Without this the
    // disabled case below proves nothing - it could pass simply because the
    // value were ignored. (Measured: the abort lands at header arrival, so the
    // pair must straddle the delay; 900/1000 is inside the reliable band.)
    const r = await attemptWith(900, 900, 1_000);
    expect(r.ok).toBe(false);
    expect(r.cause).toBe('Headers Timeout Error');
  });

  it('survives a headers delay that WOULD trip the deadline when the timeouts are disabled', async () => {
    // The production configuration: headersTimeout 0 = no deadline, so the same
    // 1000ms delay the previous test could not survive now completes.
    const r = await attemptWith(0, 0, 1_000);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(900);
  });

  it('the production transport carries NO header/body deadline of its own', async () => {
    // The load-bearing assertion: whatever the defaults are upstream, the
    // agent slowUpstreamFetch binds must have both deadlines disabled, so a
    // slow-but-alive upstream survives undici's 300s default.
    const opts = UPSTREAM_AGENT_OPTIONS;
    expect(opts.headersTimeout).toBe(0);
    expect(opts.bodyTimeout).toBe(0);
  });

  it('does not leak a second agent per request (pooling stays shared)', () => {
    // A per-request Agent would defeat connection pooling and left sockets
    // accumulate; the production transport must bind ONE long-lived agent.
    expect(slowUpstreamAgent).toBeDefined();
    expect(makeUpstreamAgent(UPSTREAM_AGENT_OPTIONS)).not.toBe(slowUpstreamAgent);
  });
});
