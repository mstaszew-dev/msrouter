/**
 * Tests for SingleKeyProvider request shaping: extraBody injection (ZAI
 * thinking toggle) and the basic wiring contract. fetch is the live-network
 * seam and is mocked (same pattern as opencodego.spec).
 */
import type pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postChatCompletion } from './fetch.js';
import { SingleKeyProvider } from './single-key.js';

vi.mock('./fetch.js', () => ({ postChatCompletion: vi.fn() }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const body = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

function makeProvider(extra?: { extraBody?: Record<string, unknown> }) {
  return new SingleKeyProvider(
    {
      id: 'zai',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'key-id.secret',
      defaultModel: 'glm-5.3-flash',
      ...extra,
    },
    1000,
    silent,
  );
}

describe('SingleKeyProvider extraBody (ZAI thinking toggle)', () => {
  beforeEach(() => {
    vi.mocked(postChatCompletion).mockReset();
    vi.mocked(postChatCompletion).mockResolvedValue({
      kind: 'OK',
      response: new Response('{}', { status: 200 }),
    });
  });

  it('merges extraBody into the outbound request body', async () => {
    const p = makeProvider({ extraBody: { thinking: { type: 'disabled' } } });
    await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    expect(postChatCompletion).toHaveBeenCalledTimes(1);
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound).toMatchObject({
      model: 'glm-5.3-flash',
      thinking: { type: 'disabled' },
    });
  });

  it('leaves the body untouched when no extraBody is configured', async () => {
    const p = makeProvider();
    await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound).toEqual({ ...body, model: 'glm-5.3-flash' });
    expect(outbound).not.toHaveProperty('thinking');
  });

  it('extraBody cannot override the resolved model', async () => {
    const p = makeProvider({ extraBody: { model: 'evil-model' } });
    await p.attempt(body, new AbortController().signal, { model: 'glm-5.3-flash' });
    const [outbound] = vi.mocked(postChatCompletion).mock.calls[0]!;
    expect(outbound.model).toBe('glm-5.3-flash');
  });
});
