/**
 * Upstream LLM HTTP transport: the npm `undici` package's own fetch, bound to
 * a dedicated Agent whose response-header and body deadlines are disabled.
 *
 * Why not Node's core global fetch: core fetch aborts a request whose
 * response headers have not arrived within its built-in 300s default -
 * the exact mechanism behind the 5m00s tailnet aborts - and that default
 * is not configurable from user code on current Node.
 *
 * Why a dedicated undici Agent: undici's timeout machinery is NOT inert
 * (corrected 2026-10-12; the 2026-09-27 note below was wrong). Agent ships
 * `headersTimeout: 300_000` and `bodyTimeout: 300_000` and enforces them:
 * a request whose headers take longer is aborted with "Headers Timeout
 * Error". The tailnet laptop holds headers back for the entire prefill, and
 * an agent-sized payload needs longer than 300s (measured: a 230KB payload
 * aborted at exactly 300136ms and surfaced as `laptop:TRANSIENT(0)`), so the
 * default agent killed healthy slow requests while LAPTOP_TIMEOUT_MS (30 min)
 * and FIRST_BYTE_TIMEOUT_MS (15 min) looked generous. Binding 0 for both
 * leaves the caller's AbortSignal as the only ceiling, which is exactly what
 * postChatCompletion wants: its per-provider timeoutMs is the real bound.
 *
 * --- superseded 2026-09-27 note (kept for the audit trail) ---
 * "Verified ... neither Client-level headersTimeout/bodyTimeout options, per-
 * request options, nor any dispatcher binding aborts a pending request."
 * http-agent.spec.ts now pins the true behaviour: the knob IS honoured, and
 * the production agent must carry 0 for both.
 * --- end superseded note ---
 *
 * Accepted trade-off: with both deadlines disabled there is no idle watchdog
 * mid-stream; a headers-then-silence stall hangs until the downstream client
 * disconnects (gateway handlers abort on `req.on('close')`, so a real caller
 * is never stranded). Policy (2026-09-27): a slow answer beats no answer, so
 * this is preferred over a transport that aborts healthy slow requests.
 */
import { Agent, fetch as undiciFetch } from 'undici';

/** Signature of the transport postChatCompletion uses for upstream calls. */
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Header/body deadlines, in ms. `0` means "no deadline" in undici. */
export interface UpstreamAgentOptions {
  headersTimeout?: number;
  bodyTimeout?: number;
}

/**
 * Both deadlines disabled: the caller's AbortSignal is the only ceiling.
 * Exported so the configuration is assertable in tests (the whole bug was an
 * invisible upstream default, so the fix must be visible here).
 */
export const UPSTREAM_AGENT_OPTIONS: Readonly<Required<UpstreamAgentOptions>> = Object.freeze({
  headersTimeout: 0,
  bodyTimeout: 0,
});

/** Build a fresh agent. Long-lived and shared; never one per request. */
export function makeUpstreamAgent(opts: UpstreamAgentOptions): Agent {
  return new Agent(opts);
}

/** The single transport agent every upstream call shares. */
export const slowUpstreamAgent: Agent = makeUpstreamAgent(UPSTREAM_AGENT_OPTIONS);

/**
 * Bind an upstream transport to its OWN long-lived agent. A per-request agent
 * would defeat connection pooling and leak sockets, so the production object
 * is built once and shared; this factory exists so tests can build a transport
 * with a short deadline and prove the knob is honoured.
 */
export function makeUpstreamFetch(opts: UpstreamAgentOptions): UpstreamFetch {
  const agent = makeUpstreamAgent(opts);
  return (url, init) =>
    undiciFetch(url, {
      ...init,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/** Production upstream transport (npm undici fetch; see module doc). */
export const slowUpstreamFetch: UpstreamFetch = makeUpstreamFetch(UPSTREAM_AGENT_OPTIONS);
