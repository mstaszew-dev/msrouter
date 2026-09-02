/**
 * API client for the admin console. A thin fetch wrapper that:
 *   - attaches the JWT from localStorage to every request,
 *   - normalizes the server's `{ error: { code, message } }` envelope into
 *     ApiError,
 *   - treats any 401 as "session expired": clears the token and fires the
 *     unauthorized hook (wired to logout by AuthContext),
 *   - validates responses against the shared zod schema, so a backend
 *     contract break fails loudly instead of rendering garbage.
 * The shared schema is the single source of truth imported from the backend
 * package (`@shared/schema`).
 */
import { z } from 'zod';

import {
  AddColumnRequest,
  ChangePasswordRequest,
  ColumnDef,
  CreateUserRequest,
  LoginRequest,
  LoginResponse,
  ObsSnapshot,
  PublicUser,
  QueryResponse,
  UpdateProfileRequest,
} from '@shared/schema';
import type {
  ObsSnapshot as ObsSnapshotT,
  PublicUser as PublicUserT,
  QueryResponse as QueryResponseT,
} from '@shared/schema';

const TOKEN_KEY = 'msrouter.admin.token';

export const tokenStore = {
  get(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/** Hook fired when any request comes back 401 (session expired). */
export const unauthorizedHandler: { set(fn: (() => void) | null): void } = {
  set(fn: (() => void) | null): void {
    handler = fn;
  },
};

let handler: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : 'network error');
  }

  if (res.status === 401) {
    tokenStore.clear();
    handler?.();
  }

  let payload: unknown = undefined;
  try {
    payload = await res.json();
  } catch {
    if (res.ok) throw new ApiError(res.status, 'BAD_RESPONSE', 'response is not valid JSON');
  }

  if (!res.ok) {
    const envelope = z
      .object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() })
      .safeParse(payload);
    if (envelope.success) {
      throw new ApiError(res.status, envelope.data.error.code, envelope.data.error.message);
    }
    throw new ApiError(res.status, 'BAD_RESPONSE', `request failed with HTTP ${res.status}`);
  }

  return payload as T;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(0, 'CONTRACT_VIOLATION', 'server response did not match the API schema');
  }
  return parsed.data;
}

export const api = {
  async login(username: string, password: string): Promise<z.infer<typeof LoginResponse>> {
    const body = LoginRequest.parse({ username, password });
    const res = await request<unknown>('/api/v1/auth/login', { method: 'POST', body });
    return parse(LoginResponse, res);
  },

  async me(): Promise<PublicUserT> {
    const res = await request<{ user: unknown }>('/api/v1/auth/me');
    return parse(PublicUser, res.user);
  },

  async users(): Promise<{ columns: ColumnDef[]; users: PublicUserT[] }> {
    const res = await request<unknown>('/api/v1/users');
    const parsed = parse(
      z.object({ columns: z.array(ColumnDef), users: z.array(PublicUser) }),
      res,
    );
    return { columns: parsed.columns, users: parsed.users };
  },

  async createUser(input: z.infer<typeof CreateUserRequest>): Promise<PublicUserT> {
    const body = CreateUserRequest.parse(input);
    const res = await request<{ user: unknown }>('/api/v1/users', { method: 'POST', body });
    return parse(PublicUser, res.user);
  },

  async addColumn(input: z.infer<typeof AddColumnRequest>): Promise<{ columns: ColumnDef[]; users: PublicUserT[] }> {
    const body = AddColumnRequest.parse(input);
    const res = await request<unknown>('/api/v1/users/columns', { method: 'POST', body });
    const parsed = parse(
      z.object({ columns: z.array(ColumnDef), users: z.array(PublicUser) }),
      res,
    );
    return { columns: parsed.columns, users: parsed.users };
  },

  async query(sql: string): Promise<QueryResponseT> {
    const res = await request<unknown>('/api/v1/query', {
      method: 'POST',
      body: { sql },
    });
    return parse(QueryResponse, res);
  },

  async obs(): Promise<ObsSnapshotT> {
    const res = await request<unknown>('/api/v1/obs/snapshot');
    return parse(ObsSnapshot, res);
  },

  async updateProfile(input: z.infer<typeof UpdateProfileRequest>): Promise<PublicUserT> {
    const body = UpdateProfileRequest.parse(input);
    const res = await request<{ user: unknown }>('/api/v1/users/me', { method: 'PATCH', body });
    return parse(PublicUser, res.user);
  },

  async changePassword(input: z.infer<typeof ChangePasswordRequest>): Promise<PublicUserT> {
    const body = ChangePasswordRequest.parse(input);
    const res = await request<{ user: unknown }>('/api/v1/auth/password', { method: 'POST', body });
    return parse(PublicUser, res.user);
  },
};
