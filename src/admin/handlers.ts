/**
 * Admin API route handlers. Every route is zod-validated at the boundary;
 * mutating routes require a valid JWT (requireAuth) and, where noted, the
 * admin role (requireAdmin). The SQL console is admin-only and read-only by
 * construction (see sql.ts). Profile routes act on the JWT subject only.
 */

import type { Logger } from 'pino';

import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors.js';
import type { HttpRequest, Router } from '../common/http.js';
import { sendJson } from '../common/http.js';
import {
  AddColumnRequest,
  ChangePasswordRequest,
  CreateUserRequest,
  LoginRequest,
  QueryRequest,
  UpdateProfileRequest,
  toPublicUser,
} from '../shared/schema.js';
import type { LoginResponse, PublicUser, QueryResponse } from '../shared/schema.js';

import { buildObsSnapshot } from './obs.js';
import type { ObsDeps } from './obs.js';
import { hashPassword, verifyPassword } from './password.js';
import type { RateLimiter } from './rateLimit.js';
import { runUsersQuery } from './sql.js';
import { signToken, verifyToken } from './token.js';
import type { UserStore } from './userStore.js';

export interface AuthContext {
  sub: string;
  role: 'admin' | 'viewer';
}

/** Narrow logger surface the admin handlers need (keeps test fakes simple). */
export type AdminLog = Pick<Logger, 'info' | 'warn' | 'error'>;

/**
 * One precomputed dummy hash so unknown-user logins burn the same scrypt work
 * as known-user logins (timing-side-channel equalizer, see NODEJS_CODE_REVIEW
 * section 4).
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('timing-equalizer-dummy-account');
  return dummyHashPromise;
}

/** Rate-limit bucket per (client IP, username) pair. */
function loginKey(req: HttpRequest, username: string): string {
  const ip = req.socket?.remoteAddress ?? 'unknown';
  return `${ip}:${username.toLowerCase()}`;
}

export interface AdminHandlerDeps {
  store: UserStore;
  storePath: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
  rateLimiter: RateLimiter;
  obsDeps: ObsDeps;
  log: AdminLog;
}

export function registerAdminHandlers(router: Router, deps: AdminHandlerDeps): void {
  const zodToDomain = (e: unknown): DomainError => {
    if (e instanceof DomainError) return e;
    if (e && typeof e === 'object' && 'issues' in e) {
      const issues = (e as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      return new ValidationError('invalid request body', {
        issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return new ValidationError('invalid request body');
  };

  const requireAuth = (req: HttpRequest): AuthContext => {
    const raw = req.headers['authorization'];
    const token =
      typeof raw === 'string' && raw.startsWith('Bearer ')
        ? raw.slice('Bearer '.length).trim() || undefined
        : undefined;
    const claims = token ? verifyToken(token, deps.jwtSecret) : null;
    if (!claims) throw new UnauthorizedError('missing or invalid bearer token');
    return { sub: claims.sub, role: claims.role };
  };

  const requireAdmin = (req: HttpRequest): AuthContext => {
    const auth = requireAuth(req);
    if (auth.role !== 'admin') throw new ForbiddenError('admin role required');
    return auth;
  };

  const currentUser = (sub: string): PublicUser => {
    const user = deps.store.find(sub);
    if (!user) throw new NotFoundError(`user '${sub}'`);
    return toPublicUser(user);
  };

  const persist = async (): Promise<void> => {
    await deps.store.save(deps.storePath);
  };

  // -- auth ------------------------------------------------------------

  router.add('POST', '/api/v1/auth/login', async (req, res) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    const { username, password } = parsed.data;

    const allowed = deps.rateLimiter.allow(loginKey(req, username));
    if (!allowed) throw new RateLimitedError('too many login attempts, try again in a minute');

    const user = deps.store.find(username);
    // Verify against the real hash or a dummy one, so unknown-user responses
    // cost the same scrypt work as known-user ones (no timing enumeration).
    const hash = user ? user.passwordHash : await dummyHash();
    const passwordOk = await verifyPassword(password, hash);
    if (!user || !passwordOk) {
      // Uniform response for unknown user vs wrong password (no enumeration).
      throw new UnauthorizedError('invalid credentials');
    }
    if (!user.active) throw new ForbiddenError('account is disabled');

    const { token, expiresAt } = signToken(
      { sub: user.username, role: user.role },
      { secret: deps.jwtSecret, ttlSeconds: deps.tokenTtlSeconds },
    );
    const body: LoginResponse = {
      token,
      tokenType: 'Bearer',
      expiresAt,
      user: toPublicUser(user),
    };
    deps.log.info({ username: user.username }, 'admin login ok');
    sendJson(res, 200, body);
  });

  router.add('GET', '/api/v1/auth/me', (req, res) => {
    const auth = requireAuth(req);
    sendJson(res, 200, { user: currentUser(auth.sub) });
  });

  router.add('POST', '/api/v1/auth/password', async (req, res) => {
    const auth = requireAuth(req);
    const parsed = ChangePasswordRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    const user = deps.store.find(auth.sub);
    if (!user) throw new NotFoundError(`user '${auth.sub}'`);
    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('current password is incorrect');
    }
    deps.store.setPassword(auth.sub, await hashPassword(parsed.data.newPassword));
    await persist();
    sendJson(res, 200, { user: currentUser(auth.sub) });
  });

  // -- users -----------------------------------------------------------

  router.add('GET', '/api/v1/users', (req, res) => {
    requireAuth(req);
    sendJson(res, 200, { columns: deps.store.columns(), users: deps.store.listPublic() });
  });

  router.add('POST', '/api/v1/users', async (req, res) => {
    requireAdmin(req);
    const parsed = CreateUserRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    const { password, ...rest } = parsed.data;
    const user = {
      ...rest,
      passwordHash: await hashPassword(password),
      active: true,
      createdAt: new Date().toISOString(),
    };
    deps.store.addUser(user);
    await persist();
    deps.log.info({ newUsername: user.username }, 'user created');
    sendJson(res, 201, { user: toPublicUser(user) });
  });

  router.add('POST', '/api/v1/users/columns', async (req, res) => {
    requireAdmin(req);
    const parsed = AddColumnRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    deps.store.addColumn(parsed.data);
    await persist();
    deps.log.info({ column: parsed.data.name }, 'column added');
    sendJson(res, 201, { columns: deps.store.columns(), users: deps.store.listPublic() });
  });

  // -- quasi-SQL console -------------------------------------------------

  router.add('POST', '/api/v1/query', async (req, res) => {
    requireAdmin(req);
    const parsed = QueryRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    // Bind sanitized rows: password hashes never enter the SQL engine, so no
    // query (not even SELECT *) can exfiltrate them.
    const rows = deps.store.users().map(toPublicUser);
    const knownColumns = [
      'username',
      'role',
      'email',
      'displayName',
      'active',
      'createdAt',
      ...deps.store.columns().map((c) => c.name),
    ];
    const result: QueryResponse = await runUsersQuery(parsed.data.sql, rows, knownColumns);
    sendJson(res, 200, result);
  });

  // -- profile -----------------------------------------------------------

  router.add('PATCH', '/api/v1/users/me', async (req, res) => {
    const auth = requireAuth(req);
    const parsed = UpdateProfileRequest.safeParse(req.body);
    if (!parsed.success) throw zodToDomain(parsed.error);
    deps.store.updateProfile(auth.sub, parsed.data);
    await persist();
    sendJson(res, 200, { user: currentUser(auth.sub) });
  });

  // -- observability -------------------------------------------------------

  router.add('GET', '/api/v1/obs/snapshot', async (req, res) => {
    requireAuth(req);
    const snapshot = await buildObsSnapshot(deps.obsDeps);
    sendJson(res, 200, snapshot);
  });
}
