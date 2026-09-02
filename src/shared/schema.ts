/**
 * The single source of truth for every type crossing the admin API boundary or
 * persisted in the users file: request/response DTOs, the users-file document,
 * and the observability snapshot. The admin server validates inputs with these
 * zod schemas at runtime; the web console imports the same schemas for forms
 * and response validation, so the two can never drift.
 *
 * Zod infers the exported TS types (`z.infer`), so there is exactly one
 * declaration per concept - schema and type together.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Users file
// ---------------------------------------------------------------------------

export const USER_ROLES = ['admin', 'viewer'] as const;
export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

export const ColumnType = z.enum(['string', 'number', 'boolean']);
export type ColumnType = z.infer<typeof ColumnType>;

/** Base field names that dynamic columns may never shadow. */
export const RESERVED_USER_FIELDS = [
  'username',
  'passwordHash',
  'role',
  'email',
  'displayName',
  'active',
  'createdAt',
] as const;

const columnName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'must start with a letter and use only letters, digits, _');

/** A dynamic column appended to the users table by the "add column" feature. */
export const ColumnDef = z
  .object({
    name: columnName,
    type: ColumnType,
    /** Value backfilled onto existing rows; must match the column type. */
    defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .superRefine((col, ctx) => {
    if ((RESERVED_USER_FIELDS as readonly string[]).includes(col.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: `'${col.name}' is a reserved base field`,
      });
      return;
    }
    if (col.defaultValue === undefined) return;
    const matches =
      col.type === 'string'
        ? typeof col.defaultValue === 'string'
        : col.type === 'number'
          ? typeof col.defaultValue === 'number'
          : col.defaultValue === null || typeof col.defaultValue === 'boolean';
    if (!matches) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultValue'],
        message: `defaultValue must be of type ${col.type} or null`,
      });
    }
  });
export type ColumnDef = z.infer<typeof ColumnDef>;

/** Any value a dynamic column may hold on a user row. */
const DynamicValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A stored user row: fixed base fields plus flattened dynamic columns
 * (catchall) so `SELECT department FROM ?` sees them as top-level SQL columns.
 */
export const UserRecord = z
  .object({
    username: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, - and _ only'),
    passwordHash: z.string().min(1),
    role: UserRole,
    email: z.string().email(),
    displayName: z.string().min(1).max(64),
    active: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .catchall(DynamicValue);
export type UserRecord = z.infer<typeof UserRecord>;

/** The users flat file on disk (data/users.json). */
export const UsersFile = z.object({
  schemaVersion: z.literal(1),
  /** Dynamic columns beyond the base fields, in table order. */
  columns: z.array(ColumnDef).max(50),
  users: z.array(UserRecord).max(1000),
});
export type UsersFile = z.infer<typeof UsersFile>;

/** API-facing user shape: never carries the password hash. */
export const PublicUser = UserRecord.omit({ passwordHash: true });
export type PublicUser = z.infer<typeof PublicUser>;

export function toPublicUser(u: UserRecord): PublicUser {
  const { passwordHash: _passwordHash, ...pub } = u;
  return pub;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  /** ISO timestamp after which the client must re-authenticate. */
  expiresAt: z.string().datetime(),
  user: PublicUser,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const UpdateProfileRequest = z
  .object({
    email: z.string().email().optional(),
    displayName: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.email !== undefined || v.displayName !== undefined, {
    message: 'at least one of email or displayName is required',
  });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

// ---------------------------------------------------------------------------
// Users admin
// ---------------------------------------------------------------------------

export const CreateUserRequest = z.object({
  username: UserRecord.shape.username,
  password: z.string().min(8).max(128),
  role: UserRole.default('viewer'),
  email: z.string().email(),
  displayName: z.string().min(1).max(64),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const AddColumnRequest = ColumnDef;
export type AddColumnRequest = ColumnDef;

// ---------------------------------------------------------------------------
// Quasi-SQL console
// ---------------------------------------------------------------------------

export const QueryRequest = z.object({
  sql: z.string().min(1).max(4000),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryResponse = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
});
export type QueryResponse = z.infer<typeof QueryResponse>;

// ---------------------------------------------------------------------------
// Observability snapshot (read-only; polling feed for the dashboard)
// ---------------------------------------------------------------------------

export const ComponentStatus = z.enum(['up', 'down', 'unconfigured', 'unknown']);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

const Status = z.object({ status: ComponentStatus, detail: z.string().max(200).optional() });

/** Display projection of a Director ledger entry (ledger.jsonl is append-only). */
export const LedgerEventView = z.object({
  at: z.string(),
  kind: z.string(),
  patchId: z.string().optional(),
  detail: z.string().max(500).optional(),
});
export type LedgerEventView = z.infer<typeof LedgerEventView>;

export const ObsSnapshot = z.object({
  generatedAt: z.string().datetime(),
  gateway: z.object({
    live: Status,
    ready: Status,
    /** Gateway process uptime in seconds; null when unreachable. */
    uptimeSeconds: z.number().nullable(),
    models: z.object({
      status: ComponentStatus,
      count: z.number().nullable(),
      names: z.array(z.string()).max(100),
    }),
  }),
  director: z.object({
    checkpoint: z.object({
      status: ComponentStatus,
      lastTickAt: z.string().nullable(),
      ageMinutes: z.number().nullable(),
      detail: z.string().max(200).optional(),
    }),
    ledgerTail: z.array(LedgerEventView).max(50),
    /** Total ledger entries; null when the ledger file is absent. */
    ledgerEntries: z.number().nullable(),
  }),
  kafka: z.object({
    enabled: z.boolean(),
    broker: Status,
  }),
  slack: Status,
  rag: Status,
});
export type ObsSnapshot = z.infer<typeof ObsSnapshot>;

// ---------------------------------------------------------------------------
// Shared API envelope
// ---------------------------------------------------------------------------

/** Stable error envelope mirrored by common/errors.ts toErrorBody(). */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
