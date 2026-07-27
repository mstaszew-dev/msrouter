import { describe, expect, it } from 'vitest';

import { chatCompletionSchema } from './validation.js';

describe('chatCompletionSchema', () => {
  it('accepts a minimal valid request', () => {
    const r = chatCompletionSchema.safeParse({
      model: 'mst/free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(true);
  });

  it('defaults max_tokens to 512 when omitted (room for reasoning models)', () => {
    const r = chatCompletionSchema.safeParse({
      model: 'openrouter/free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.max_tokens).toBe(512);
  });

  it('honors an explicit max_tokens over the default', () => {
    const r = chatCompletionSchema.safeParse({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.max_tokens).toBe(50);
  });

  it('rejects an empty model', () => {
    const r = chatCompletionSchema.safeParse({ model: '', messages: [{ role: 'user' }] });
    expect(r.success).toBe(false);
  });

  it('rejects an empty messages array', () => {
    const r = chatCompletionSchema.safeParse({ model: 'x', messages: [] });
    expect(r.success).toBe(false);
  });

  it('passes through extra provider-specific fields', () => {
    const r = chatCompletionSchema.safeParse({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.5,
      max_tokens: 100,
      custom_field: 'kept',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { custom_field?: string }).custom_field).toBe('kept');
      expect(r.data.stream).toBe(true);
    }
  });
});
