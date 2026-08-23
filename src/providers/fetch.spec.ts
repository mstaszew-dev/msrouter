import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./stream-check.js', () => ({
  checkStreamContent: vi.fn(),
  isEmptyCompletion: vi.fn(),
}));

import { postChatCompletion, scrubSecrets } from './fetch.js';
import { checkStreamContent, isEmptyCompletion } from './stream-check.js';
import type { AttemptOutcome, ChatRequestBody, ProviderCallResult } from './types.js';

const mockedCheckStream = vi.mocked(checkStreamContent);
const mockedIsEmpty = vi.mocked(isEmptyCompletion);

const BASE_URL = 'https://api.example.com/v1';
const AUTH = 'Bearer sk-test123456';
const KEY_TAG = 'key1:...abc';
const TIMEOUT_MS = 10_000;

function body(overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...overrides,
  };
}

function opts(overrides: Record<string, unknown> = {}) {
  const ac = new AbortController();
  return {
    baseUrl: BASE_URL,
    authorization: AUTH,
    signal: ac.signal,
    timeoutMs: TIMEOUT_MS,
    keyTag: KEY_TAG,
    ...overrides,
  };
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(status: number, payload: unknown) {
  return vi.fn().mockResolvedValue(jsonResponse(status, payload));
}

function fakeFetchError(err: Error) {
  return vi.fn().mockRejectedValue(err);
}

/** Narrow a ProviderCallResult to its OK branch; throws (fails the test) otherwise. */
function assertOk(result: ProviderCallResult): Extract<ProviderCallResult, { kind: 'OK' }> {
  if (result.kind !== 'OK') throw new Error(`expected OK result, got ${result.kind}`);
  return result;
}

/** Narrow a ProviderCallResult to a classified failure (KEY_FAILURE/TRANSIENT/BAD_REQUEST). */
function assertFailure(result: ProviderCallResult): AttemptOutcome {
  if (result.kind === 'OK') throw new Error('expected a failure result, got OK');
  return result;
}

let fetchSpy: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
function lastFetchHeaders(): Record<string, string> {
  return fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockedIsEmpty.mockReset();
  mockedCheckStream.mockReset();
  mockedIsEmpty.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('postChatCompletion', () => {
  describe('successful non-streaming response', () => {
    it('returns OK with parsed response body', async () => {
      const payload = {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());

      expect(result.kind).toBe('OK');
      expect(fetchSpy).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/chat/completions`);
    });

    it('returns OK when JSON parsing fails (raw text response)', async () => {
      fetchSpy = vi.fn().mockResolvedValue(
        new Response('not json at all', { status: 200 }),
      );
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());

      expect(result.kind).toBe('OK');
    });

    it('returns OK when JSON contains an error key that is falsy', async () => {
      const payload = {
        error: null,
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());

      expect(result.kind).toBe('OK');
    });
  });

  describe('200 with error in body', () => {
    it('returns TRANSIENT with upstream error message (string error)', async () => {
      const payload = { error: 'rate limited' };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.message).toContain('rate limited');
    });

    it('returns TRANSIENT with error.message for object errors', async () => {
      const payload = { error: { message: 'quota exceeded', type: 'insufficient_quota' } };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.message).toContain('quota exceeded');
    });

    it('returns TRANSIENT with stringified error for unknown error shapes', async () => {
      const payload = { error: 42 };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.message).toContain('42');
    });
  });

  describe('empty completion', () => {
    it('returns TRANSIENT when isEmptyCompletion is true', async () => {
      const payload = {
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
      };
      fetchSpy = fakeFetch(200, payload);
      globalThis.fetch = fetchSpy;
      mockedIsEmpty.mockReturnValue(true);

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.message).toContain('empty completion');
      expect(mockedIsEmpty).toHaveBeenCalledOnce();
    });
  });

  describe('error responses (classifyAttempt)', () => {
    it('returns KEY_FAILURE for 401', async () => {
      fetchSpy = fakeFetch(401, { error: 'unauthorized' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('KEY_FAILURE');
      expect(outcome.status).toBe(401);
      expect(outcome.message).toContain('unauthorized');
    });

    it('returns KEY_FAILURE for 403', async () => {
      fetchSpy = fakeFetch(403, { error: 'forbidden' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('KEY_FAILURE');
      expect(outcome.status).toBe(403);
    });

    it('returns KEY_FAILURE for 429', async () => {
      fetchSpy = fakeFetch(429, { error: 'rate limit' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('KEY_FAILURE');
      expect(outcome.status).toBe(429);
    });

    it('returns TRANSIENT for 500', async () => {
      fetchSpy = fakeFetch(500, { error: 'internal error' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(500);
    });

    it('returns TRANSIENT for 503', async () => {
      fetchSpy = fakeFetch(503, { error: 'overloaded' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(503);
    });

    it('returns BAD_REQUEST for 400', async () => {
      fetchSpy = fakeFetch(400, { error: 'bad request' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('BAD_REQUEST');
      expect(outcome.status).toBe(400);
    });

    it('returns TRANSIENT for 408', async () => {
      fetchSpy = fakeFetch(408, { error: 'timeout' });
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(408);
    });

    it('appends scrubbed error body to outcome message', async () => {
      fetchSpy = fakeFetch(401, { error: { message: 'key sk-or-v1-abc123def is invalid' } });
      globalThis.fetch = fetchSpy;

      const outcome = assertFailure(await postChatCompletion(body(), opts()));

      expect(outcome.message).toContain('sk-[REDACTED]');
      expect(outcome.message).not.toContain('sk-or-v1-abc123def');
    });
  });

  describe('network errors', () => {
    it('returns TRANSIENT with status 0 for generic fetch error', async () => {
      fetchSpy = fakeFetchError(new Error('connection refused'));
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(0);
      expect(outcome.message).toContain('fetch error:');
      expect(outcome.message).toContain('connection refused');
    });

    it('scrubs secrets from error messages', async () => {
      fetchSpy = fakeFetchError(new Error('auth failed with sk-testkey123'));
      globalThis.fetch = fetchSpy;

      const outcome = assertFailure(await postChatCompletion(body(), opts()));

      expect(outcome.message).not.toContain('sk-testkey123');
      expect(outcome.message).toContain('sk-[REDACTED]');
    });

    it('handles non-Error thrown values', async () => {
      fetchSpy = vi.fn().mockRejectedValue('string error');
      globalThis.fetch = fetchSpy;

      const result = await postChatCompletion(body(), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(0);
      expect(outcome.message).toContain('fetch error:');
      expect(outcome.message).toContain('string error');
    });
  });

  describe('timeout / abort', () => {
    it('returns TRANSIENT when timeout fires', async () => {
      const ac = new AbortController();
      const fetchPromise = postChatCompletion(body(), opts({ signal: ac.signal, timeoutMs: 100 }));

      // Trigger timeout
      vi.advanceTimersByTime(150);

      const result = await fetchPromise;
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(0);
      expect(outcome.message).toContain('fetch error');
    });

    it('returns TRANSIENT when caller signal aborts', async () => {
      const ac = new AbortController();
      const fetchPromise = postChatCompletion(body(), opts({ signal: ac.signal, timeoutMs: 60_000 }));

      // Abort caller signal
      ac.abort();

      const result = await fetchPromise;
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(0);
    });
  });

  describe('streaming responses', () => {
    it('returns OK when checkStreamContent returns ok: true', async () => {
      const streamResponse = new Response('stream data', { status: 200 });
      fetchSpy = fakeFetch(200, {});
      globalThis.fetch = fetchSpy;
      mockedCheckStream.mockResolvedValue({ ok: true, response: streamResponse });

      const result = await postChatCompletion(body({ stream: true }), opts());

      expect(result.kind).toBe('OK');
      expect(assertOk(result).response).toBe(streamResponse);
      expect(mockedCheckStream).toHaveBeenCalledOnce();
    });

    it('returns KEY_FAILURE when checkStreamContent returns ok: false', async () => {
      fetchSpy = fakeFetch(200, {});
      globalThis.fetch = fetchSpy;
      mockedCheckStream.mockResolvedValue({ ok: false, reason: 'no content tokens' });

      const result = await postChatCompletion(body({ stream: true }), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('KEY_FAILURE');
      expect(outcome.status).toBe(200);
      expect(outcome.message).toContain('no content tokens');
    });

    it('uses default message when checkStreamContent reason is undefined', async () => {
      fetchSpy = fakeFetch(200, {});
      globalThis.fetch = fetchSpy;
      // Simulate a malformed stream-check result whose `reason` is missing at
      // runtime, to exercise the default-message fallback in postChatCompletion.
      mockedCheckStream.mockResolvedValue({ ok: false } as { ok: false; reason: string });

      const result = await postChatCompletion(body({ stream: true }), opts());
      const outcome = assertFailure(result);

      expect(outcome.kind).toBe('KEY_FAILURE');
      expect(outcome.message).toContain('stream returned no content');
    });
  });

  describe('headers', () => {
    it('sends content-type: application/json', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body(), opts());

      const headers = lastFetchHeaders();
      expect(headers['content-type']).toBe('application/json');
    });

    it('sends authorization from opts', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body(), opts());

      const headers = lastFetchHeaders();
      expect(headers.authorization).toBe(AUTH);
    });

    it('sends accept: text/event-stream for streaming', async () => {
      fetchSpy = fakeFetch(200, {});
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body({ stream: true }), opts());

      const headers = lastFetchHeaders();
      expect(headers.accept).toBe('text/event-stream');
    });

    it('sends accept: application/json for non-streaming', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body({ stream: false }), opts());

      const headers = lastFetchHeaders();
      expect(headers.accept).toBe('application/json');
    });

    it('passes extra headers through', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;
      const extraHeaders = { 'HTTP-Referer': 'https://example.com', 'X-Title': 'MyApp' };

      await postChatCompletion(body(), opts({ extraHeaders }));

      const headers = lastFetchHeaders();
      expect(headers['HTTP-Referer']).toBe('https://example.com');
      expect(headers['X-Title']).toBe('MyApp');
    });

    it('handles missing extraHeaders gracefully', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body(), opts({ extraHeaders: undefined }));

      const headers = lastFetchHeaders();
      expect(headers['content-type']).toBe('application/json');
    });
  });

  describe('signal propagation', () => {
    it('propagates caller abort to internal fetch', async () => {
      const ac = new AbortController();
      fetchSpy = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );
      globalThis.fetch = fetchSpy;

      const fetchPromise = postChatCompletion(body(), opts({ signal: ac.signal, timeoutMs: 60_000 }));

      ac.abort();

      const result = await fetchPromise;
      const outcome = assertFailure(result);
      expect(outcome.kind).toBe('TRANSIENT');
      expect(outcome.status).toBe(0);
    });
  });

  describe('request body', () => {
    it('serializes the body as JSON', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      const b = body({ model: 'claude-4', temperature: 0.7 });
      await postChatCompletion(b, opts());

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const rawBody: unknown = fetchSpy.mock.calls[0]![1]!.body;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
      const sentBody: Record<string, unknown> = JSON.parse(rawBody as string);
      expect(sentBody.model).toBe('claude-4');
      expect(sentBody.temperature).toBe(0.7);
      expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('uses POST method', async () => {
      fetchSpy = fakeFetch(200, { choices: [] });
      globalThis.fetch = fetchSpy;

      await postChatCompletion(body(), opts());

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(fetchSpy.mock.calls[0]![1]!.method).toBe('POST');
    });
  });
});

describe('scrubSecrets', () => {
  it('scrubs sk- prefixed API keys', () => {
    expect(scrubSecrets('key is sk-abc123def456')).toBe('key is sk-[REDACTED]');
  });

  it('scrubs sk-or- prefixed OpenRouter keys', () => {
    expect(scrubSecrets('using sk-or-v1-abc123def456')).toBe('using sk-[REDACTED]');
  });

  it('scrubs sk-proj- prefixed keys', () => {
    expect(scrubSecrets('value sk-proj-abc123def456 here')).toBe('value sk-[REDACTED] here');
  });

  it('scrubs Bearer tokens', () => {
    expect(scrubSecrets('Authorization: Bearer abc123def456')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('scrubs Bearer tokens case-insensitively', () => {
    expect(scrubSecrets('bearer abc123def456')).toBe('Bearer [REDACTED]');
  });

  it('scrubs JWT tokens (header.payload)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    expect(scrubSecrets(`token: ${jwt}`)).toBe('token: [REDACTED-JWT]');
  });

  it('scrubs multiple secrets in one string', () => {
    const input = 'key sk-abc123def456 and Bearer xyz123abc456';
    const result = scrubSecrets(input);
    expect(result).not.toContain('sk-abc123def456');
    expect(result).not.toContain('xyz123abc456');
  });

  it('passes normal text through unchanged', () => {
    const input = 'Hello, this is a normal message with no secrets.';
    expect(scrubSecrets(input)).toBe(input);
  });

  it('passes short sk- strings through (too short to be a key)', () => {
    expect(scrubSecrets('sk-abc')).toBe('sk-abc');
  });

  it('scrubs keys with dashes and underscores', () => {
    expect(scrubSecrets('sk-abc_def-123456')).toBe('sk-[REDACTED]');
  });
});
