/**
 * stream-check.ts: empty-content detection for streaming and non-streaming
 * chat-completion responses. Extracted from fetch.ts to stay under the
 * 250-line module size budget.
 */

/**
 * Check whether a parsed chat-completion JSON body represents an empty response:
 * HTTP 200, no error, but choices[].message.content is empty/null and
 * finish_reason is not 'stop'. Models like big-pickle return this pattern when
 * they are reasoning-only models that don't generate user-facing text.
 *
 * "Empty" is defined by what the caller receives: NO content AND NO tool calls
 * means the response has no deliverable, regardless of why (even if the message
 * carries reasoning_content - thinking is not an answer). The chain treats
 * EMPTY as "skip to the next provider", distinct from TRANSIENT (provider
 * failure) and from BAD_REQUEST (rejected prompt).
 */
export function isEmptyCompletion(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const obj = json as Record<string, unknown>;
  if ('error' in obj && obj.error) return false;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue;
    const choice = c as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') continue;
    const content = message.content;
    const finishReason = choice.finish_reason;
    // Not empty if content is present and non-empty
    if (typeof content === 'string' && content.length > 0) return false;
    // Not empty if the message carries tool calls (function-call models like
    // local qwen3 return content="" + tool_calls with finish_reason=tool_calls).
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
    // Not empty if finish_reason is 'stop' (model chose to say nothing)
    if (finishReason === 'stop') return false;
  }
  // All choices have empty content, no tool calls, and finish_reason !== 'stop'
  return true;
}

/**
 * Peek at a streaming SSE response for actual content before forwarding.
 * Reads enough of the stream to get the first complete SSE event.
 *
 * Valid responses (return { ok: true }):
 * - Events with text content tokens (delta.content)
 * - Events with tool call deltas (delta.tool_calls) — model used MCP tools
 * - Events that start with content or tool_calls (even if later finish_reason=length)
 *
 * Empty responses (return { ok: false, reason }):
 * - No events at all (stream ended immediately)
 * - Only finish_reason=length with no content AND no tool_calls — e.g. big-pickle
 * - Embedded error field (rate limit reached, etc.) — also KEY_FAILURE so the
 *   provider demotes the triple instead of retrying in place
 */
export async function checkStreamContent(
  res: Response,
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  const reader = res.body?.getReader();
  if (!reader) {
    return { ok: false, reason: 'no response body' };
  }

  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let buffer = '';
  let hasContent = false;
  let hasError = false;

  // Read chunks until we've seen the first complete SSE event or stream ends.
  while (true) {
    const { done, value } = await reader.read();
    if (done && chunks.length === 0) {
      return { ok: false, reason: 'stream ended with no data' };
    }
    if (value) {
      chunks.push(value);
      buffer += decoder.decode(value, { stream: true });
    }
    if (done) break;

    // Check if we have at least one complete SSE event (\n\n).
    if (buffer.includes('\n\n')) {
      const events = buffer.split('\n\n');
      for (const ev of events) {
        if (ev.trim() === '' || ev === '[DONE]') continue;
        for (const line of ev.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

            // Check for embedded error (e.g. rate-limit returned as HTTP 200)
            if (parsed.error) {
              hasError = true;
              break;
            }

            const choices = parsed.choices;
            if (!Array.isArray(choices)) continue;
            for (const c of choices) {
              if (!c || typeof c !== 'object') continue;
              const choice = c as Record<string, unknown>;
              const delta = choice.delta as Record<string, unknown> | undefined;
              if (!delta) continue;

              // Text content — model is generating a response
              const content = delta.content;
              if (typeof content === 'string' && content.length > 0) {
                hasContent = true;
                break;
              }

              // Tool calls — model used MCP tools (no text output is ok)
              const toolCalls = delta.tool_calls;
              if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                hasContent = true; // tool calls are valid content
                break;
              }
            }
            if (hasContent || hasError) break;
          } catch {
            // unparseable event line; skip
          }
        }
        if (hasContent || hasError) break;
      }
      if (hasContent || hasError) break;
    }
  }

  // Reconstruct a single buffer from all chunks read so far.
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const allData = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    allData.set(c, offset);
    offset += c.length;
  }

  if (hasError) {
    // eslint-disable-next-line no-empty
    while (!(await reader.read()).done) {}
    return { ok: false, reason: 'SSE stream contained an error response' };
  }

  if (!hasContent) {
    // eslint-disable-next-line no-empty
    while (!(await reader.read()).done) {}
    return { ok: false, reason: 'SSE stream had no content or tool call tokens' };
  }

  // Build a new stream with the already-read data, then pipe the rest.
  const restStream = new ReadableStream({
    start(controller) {
      controller.enqueue(allData);
      (async () => {
          try {
            while (true) {
              const r = await reader.read();
              if (r.done) break;
              controller.enqueue(r.value);
            }
          } catch {
            // stream terminated by abort/timeout
          } finally {
            try {
              controller.close();
            } catch {
              // controller already closed by consumer disconnect — ignore
            }
          }
      })();
    },
  });

  return {
    ok: true,
    response: new Response(restStream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
  };
}
