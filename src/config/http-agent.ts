/**
 * Upstream LLM HTTP transport: the npm `undici` package's own fetch.
 *
 * Why not Node's core global fetch: core fetch aborts a request whose
 * response headers have not arrived within its built-in 300s default -
 * the exact mechanism behind the 5m00s tailnet aborts - and that default
 * is not configurable from user code on current Node.
 *
 * Why npm undici 8 is the right transport here: its response-header/body
 * timeout machinery is inert in practice. Verified 2026-09-27 against
 * delayed-header local servers (sandboxed and not): neither Client-level
 * `headersTimeout`/`bodyTimeout` options, per-request options, nor any
 * dispatcher binding (init.dispatcher, npm setGlobalDispatcher) aborts a
 * pending request. So a slow upstream is bounded ONLY by the caller's
 * AbortSignal - exactly what postChatCompletion wants: the per-provider
 * timeoutMs is the ceiling, and endpoints that hold response headers back
 * for the whole prefill (tailnet Ollama, minutes at ~20 tok/s) survive.
 * http-agent.spec.ts pins the no-premature-abort behavior end-to-end.
 *
 * Accepted trade-off: there is equally no idle watchdog mid-stream; a
 * headers-then-silence stall hangs until the downstream client disconnects.
 * Policy (2026-09-27): a slow answer beats no answer, so this is preferred
 * over a transport that aborts healthy slow requests.
 */
import { fetch as undiciFetch } from 'undici';

/** Signature of the transport postChatCompletion uses for upstream calls. */
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Production upstream transport (npm undici fetch; see module doc). */
export const slowUpstreamFetch: UpstreamFetch = (url, init) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
