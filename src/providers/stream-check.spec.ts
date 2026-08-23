import { describe, expect, it } from 'vitest';

import { checkStreamContent, isEmptyCompletion } from './stream-check.js';

describe('isEmptyCompletion', () => {
  it('returns true for empty content with finish_reason=length', () => {
    const json = {
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    };
    expect(isEmptyCompletion(json)).toBe(true);
  });

  it('returns true for null content with finish_reason=length', () => {
    const json = {
      choices: [{ message: { content: null }, finish_reason: 'length' }],
    };
    expect(isEmptyCompletion(json)).toBe(true);
  });

  it('returns false when content is non-empty', () => {
    const json = {
      choices: [{ message: { content: 'hello' }, finish_reason: 'length' }],
    };
    expect(isEmptyCompletion(json)).toBe(false);
  });

  it('returns false when finish_reason is stop (model chose to say nothing)', () => {
    const json = {
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    };
    expect(isEmptyCompletion(json)).toBe(false);
  });

  it('returns false when the message carries tool_calls (empty content, finish_reason=tool_calls)', () => {
    // qwen3 (local ollama) returns content="" + tool_calls for function calls;
    // a tool-calling model must NOT be treated as an empty completion.
    const json = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    expect(isEmptyCompletion(json)).toBe(false);
  });

  it('returns true for empty content with finish_reason=length and no tool_calls', () => {
    const json = {
      choices: [
        {
          message: { content: '', tool_calls: [] },
          finish_reason: 'length',
        },
      ],
    };
    expect(isEmptyCompletion(json)).toBe(true);
  });

  it('returns true when only reasoning_content is present (no content, no tool calls - still no deliverable)', () => {
    const json = {
      choices: [
        {
          message: { content: '', tool_calls: [], reasoning_content: 'Let me think about 2+2...' },
          finish_reason: 'length',
        },
      ],
    };
    expect(isEmptyCompletion(json)).toBe(true);
  });

  it('returns false when reasoning_content is present AND content is present', () => {
    const json = {
      choices: [
        {
          message: { content: '4', tool_calls: [], reasoning_content: 'Let me think...' },
          finish_reason: 'stop',
        },
      ],
    };
    expect(isEmptyCompletion(json)).toBe(false);
  });

  it('returns false when error field is present', () => {
    const json = {
      error: { message: 'rate limit' },
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    };
    expect(isEmptyCompletion(json)).toBe(false);
  });

  it('returns false when choices array is empty', () => {
    expect(isEmptyCompletion({ choices: [] })).toBe(false);
  });

  it('returns false when choices is missing', () => {
    expect(isEmptyCompletion({})).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(isEmptyCompletion(null)).toBe(false);
    expect(isEmptyCompletion('string')).toBe(false);
    expect(isEmptyCompletion(42)).toBe(false);
  });

  it('treats malformed choice entries as empty (skip and keep scanning)', () => {
    // null choice entry
    expect(isEmptyCompletion({ choices: [null, { message: { content: 'x' } }] })).toBe(false);
    // choice without a message object
    expect(isEmptyCompletion({ choices: [{ finish_reason: 'length' }] })).toBe(true);
    // non-object message
    expect(isEmptyCompletion({ choices: [{ message: 'oops', finish_reason: 'length' }] })).toBe(
      true,
    );
    // falsy error field does not count as an error response
    expect(
      isEmptyCompletion({ error: null, choices: [{ message: { content: '' }, finish_reason: 'x' }] }),
    ).toBe(true);
  });
});

describe('checkStreamContent', () => {
  /** Build a mock SSE Response from data lines. */
  function mockSseResponse(dataLines: string[]): Response {
    const sseText = dataLines.map((d) => `data: ${d}`).join('\n\n') + '\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it('returns ok=true for stream with text content delta', async () => {
    const res = mockSseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'hello world' } }] }),
    ]);
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(true);
  });

  it('returns ok=true for stream with tool_calls delta (no text)', async () => {
    const res = mockSseResponse([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'navigate' } }] } }],
      }),
    ]);
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false for stream with empty content and finish_reason=length', async () => {
    const res = mockSseResponse([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    ]);
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for stream with embedded error', async () => {
    const res = mockSseResponse([
      JSON.stringify({ error: { message: 'rate limit exceeded' } }),
    ]);
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for empty stream (no data)', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when response has no body', async () => {
    const res = new Response(null, { status: 200 });
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(false);
  });

  it('skips unparseable SSE event lines (JSON.parse throws)', async () => {
    // Line 128: catch block when JSON.parse fails on a data: line
    const encoder = new TextEncoder();
    const sseText = 'data: {not valid json}\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'real content' } }] }) + '\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const result = await checkStreamContent(res);
    expect(result.ok).toBe(true);
  });

  it('skips non-data SSE lines, [DONE], and events without usable choices', async () => {
    const encoder = new TextEncoder();
    const junk = [
      'event: ping', // not a data: line -> skipped
      'data: [DONE]', // explicit done marker -> skipped
      'data: {"nope":1}', // no choices array -> skipped
      'data: {"choices":"bad"}', // non-array choices -> skipped
      'data: ' + JSON.stringify({ choices: [{ finish_reason: null }] }), // no delta -> skipped
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'real' } }] }),
    ].join('\n\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(junk + '\n\n'));
        controller.close();
      },
    });
    const result = await checkStreamContent(new Response(stream, { status: 200 }));
    expect(result.ok).toBe(true);
  });

  it('swallows the close race when the consumer cancels while the pump is draining', async () => {
    const encoder = new TextEncoder();
    let srcController!: ReadableStreamDefaultController<Uint8Array>;
    const firstEvent =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        srcController = controller;
        controller.enqueue(encoder.encode(firstEvent));
        // Keep the source open; the tail arrives only after the consumer acts.
      },
    });
    const result = await checkStreamContent(new Response(source, { status: 200 }));
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
    expect(result.response.status).toBe(200);

    // Consume the buffered prefix, then cancel before the tail is pumped.
    const reader = result.response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain('"content":"hi"');
    await reader.cancel();

    // The pump now enqueues into a canceled stream: its enqueue throws, and
    // the finally-block close() throws again - both must be swallowed.
    srcController.enqueue(encoder.encode('tail-data'));
    srcController.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
