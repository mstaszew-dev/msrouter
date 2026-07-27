/**
 * SSE streaming pass-through. When the upstream Response is a stream, we pipe
 * its ReadableStream straight to the node:http ServerResponse without buffering,
 * honoring the OpenAI/OpenRouter text/event-stream framing and terminating with
 * `data: [DONE]`. This keeps latency low and memory bounded.
 *
 * Error handling: if the upstream errors AFTER we sent 200/headers, we cannot
 * change the status; instead we emit an SSE error event and end cleanly so the
 * client is not left hanging. Backpressure is raced against client disconnect.
 *
 * See NODEJS_CODE_REVIEW.md section 2 (streams over buffers) + section 3.
 */

import type { ServerResponse } from 'node:http';

export interface StreamOptions {
  /** The upstream streaming Response. */
  upstream: Response;
  res: ServerResponse;
  /** Caller aborts this when the client disconnects, so we stop pulling. */
  signal: AbortSignal;
}

/** Pipe the upstream SSE stream to the client response. Resolves when done. */
export async function pipeSseStream(opts: StreamOptions): Promise<void> {
  const { upstream, res, signal } = opts;
  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const reader = body.getReader();
  const onClose = () => {
    void reader.cancel().catch(() => undefined);
  };
  res.on('close', onClose);
  signal.addEventListener('abort', onClose, { once: true });

  try {
    // Manual pump: read chunks and write them through (bytes verbatim, so SSE
    // framing is preserved). Errors after headers are handled below.
    for (;;) {
      const readResult = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (readResult.done) break;
      const chunk = readResult.value;
      if (chunk) {
        if (!res.write(chunk)) {
          // Backpressure: wait for drain, OR abort if the client disconnected
          // (otherwise the drain promise never resolves -> hung request).
          await Promise.race([
            new Promise<void>((r) => res.once('drain', () => r())),
            new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
            new Promise<void>((r) => res.once('close', () => r())),
          ]);
          if (signal.aborted || res.destroyed || res.writableEnded) break;
        }
      }
    }
  } catch {
    // Upstream errored mid-stream (after 200). We can't change the status now;
    // emit an SSE error frame so the client knows the stream ended badly.
    if (!res.destroyed && !res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ error: 'upstream stream interrupted' })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {
        // ignore write failures on a dying socket
      }
    }
  } finally {
    res.off('close', onClose);
    signal.removeEventListener('abort', onClose);
    if (!res.writableEnded) res.end();
  }
}
