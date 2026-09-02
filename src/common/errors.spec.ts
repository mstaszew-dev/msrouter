import { describe, expect, it } from 'vitest';

import {
  BadRequestError,
  ConflictError,
  DomainError,
  errorMessage,
  ForbiddenError,
  NoProviderAvailableError,
  NotFoundError,
  RateLimitedError,
  toErrorBody,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

describe('toErrorBody', () => {
  it('maps a DomainError to its status + code', () => {
    const { status, body } = toErrorBody(new BadRequestError('bad'), 'cid-1');
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('bad');
    expect(body.error.correlationId).toBe('cid-1');
  });

  it('maps each subclass to its canonical status', () => {
    expect(toErrorBody(new ValidationError('x')).status).toBe(400);
    expect(toErrorBody(new UnauthorizedError()).status).toBe(401);
    expect(toErrorBody(new ForbiddenError()).status).toBe(403);
    expect(toErrorBody(new NotFoundError('user')).status).toBe(404);
    expect(toErrorBody(new ConflictError('exists')).status).toBe(409);
    expect(toErrorBody(new RateLimitedError()).status).toBe(429);
    expect(toErrorBody(new NoProviderAvailableError()).status).toBe(502);
  });

  it('maps the new admin codes to stable error codes', () => {
    expect(toErrorBody(new ForbiddenError('no')).body.error.code).toBe('FORBIDDEN');
    expect(toErrorBody(new NotFoundError('user')).body.error.code).toBe('NOT_FOUND');
    expect(toErrorBody(new ConflictError('dup')).body.error.code).toBe('CONFLICT');
    expect(toErrorBody(new RateLimitedError()).body.error.code).toBe('RATE_LIMITED');
  });

  it('rate limit error carries a retry-after hint', () => {
    const e = new RateLimitedError('Too many attempts', 45);
    expect(e.retryAfterSeconds).toBe(45);
    const { body } = toErrorBody(e);
    expect(body.error.details).toEqual({ retryAfterSeconds: 45 });
  });

  it('attaches details when present', () => {
    const { body } = toErrorBody(new ValidationError('x', { field: 'model' }));
    expect(body.error.details).toEqual({ field: 'model' });
  });

  it('maps unknown errors to 500 INTERNAL_ERROR', () => {
    const { status, body } = toErrorBody(new Error('boom'), 'cid-2');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.correlationId).toBe('cid-2');
  });

  it('preserves DomainError subclass instances', () => {
    const e = new BadRequestError('x');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('BAD_REQUEST');
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a plain string as-is', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
  });

  it('JSON-serializes non-string, non-Error values', () => {
    expect(errorMessage({ reason: 'quota' })).toBe('{"reason":"quota"}');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });

  it("returns 'unknown error' when JSON serialization fails (circular ref)", () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(errorMessage(circular)).toBe('unknown error');
  });
});
