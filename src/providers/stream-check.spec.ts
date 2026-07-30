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
    const encoder = new TextEncoder();
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
});
