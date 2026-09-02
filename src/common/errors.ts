/**
 * Domain error hierarchy + stable HTTP error envelope. The gateway's central
 * error handler maps these to responses; stack traces never leak to clients.
 * See NODEJS_CODE_REVIEW.md section 3.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'NO_PROVIDER_AVAILABLE'
  | 'INTERNAL_ERROR';

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends DomainError {
  constructor(what = 'resource') {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message = 'Conflict') {
    super(message, 'CONFLICT', 409);
  }
}

export class RateLimitedError extends DomainError {
  constructor(
    message = 'Too many attempts',
    public readonly retryAfterSeconds = 60,
  ) {
    super(message, 'RATE_LIMITED', 429, { retryAfterSeconds });
  }
}

export class BadRequestError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BAD_REQUEST', 400, details);
  }
}

export class NoProviderAvailableError extends DomainError {
  constructor(message = 'All providers failed') {
    super(message, 'NO_PROVIDER_AVAILABLE', 502);
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    correlationId?: string;
    details?: unknown;
  };
}

export function toErrorBody(
  e: unknown,
  correlationId?: string,
): { status: number; body: ErrorBody } {
  if (e instanceof DomainError) {
    return {
      status: e.statusCode,
      body: {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
          ...(correlationId ? { correlationId } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        ...(correlationId ? { correlationId } : {}),
      },
    },
  };
}

/** Safe message extraction from an unknown caught value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'unknown error';
  }
}
