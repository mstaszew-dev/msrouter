/**
 * Boundary tests for the shared zod schema. This module is the single source
 * of truth for API + persisted types: the admin server validates request
 * bodies and the users file with it, and the web console imports the same
 * schemas to validate responses and forms.
 */
import { describe, expect, it } from 'vitest';

import {
  AddColumnRequest,
  ChangePasswordRequest,
  CreateUserRequest,
  LoginRequest,
  ObsSnapshot,
  PublicUser,
  QueryRequest,
  UserRecord,
  UsersFile,
  toPublicUser,
} from './schema.js';

const validUser = {
  username: 'demo',
  passwordHash: 'scrypt$16384$8$1$abcd$ef01',
  role: 'admin',
  email: 'demo@example.com',
  displayName: 'Demo User',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  // dynamic column value (flattened so SQL sees it as a top-level column)
  department: 'platform',
};

describe('UserRecord', () => {
  it('accepts a valid user with dynamic columns', () => {
    const u = UserRecord.parse(validUser);
    expect(u.username).toBe('demo');
    expect((u as Record<string, unknown>)['department']).toBe('platform');
  });

  it('rejects dynamic values that are not string|number|boolean|null', () => {
    expect(UserRecord.safeParse({ ...validUser, department: { nested: true } }).success).toBe(
      false,
    );
  });

  it('rejects a bad username (uppercase, too short)', () => {
    expect(UserRecord.safeParse({ ...validUser, username: 'Demo' }).success).toBe(false);
    expect(UserRecord.safeParse({ ...validUser, username: 'ab' }).success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(UserRecord.safeParse({ ...validUser, role: 'root' }).success).toBe(false);
  });

  it('rejects a malformed email or timestamp', () => {
    expect(UserRecord.safeParse({ ...validUser, email: 'nope' }).success).toBe(false);
    expect(UserRecord.safeParse({ ...validUser, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('UsersFile', () => {
  it('accepts a valid file with columns and users', () => {
    const file = {
      schemaVersion: 1,
      columns: [{ name: 'department', type: 'string', defaultValue: 'general' }],
      users: [validUser],
    };
    const parsed = UsersFile.parse(file);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.columns[0]?.name).toBe('department');
  });

  it('rejects a wrong schemaVersion or missing users array', () => {
    expect(UsersFile.safeParse({ schemaVersion: 2, columns: [], users: [] }).success).toBe(false);
    expect(UsersFile.safeParse({ schemaVersion: 1, columns: [] }).success).toBe(false);
  });
});

describe('toPublicUser', () => {
  it('strips the password hash from the serialized output', () => {
    const u = UserRecord.parse(validUser);
    const pub = toPublicUser(u);
    expect(JSON.stringify(pub)).not.toContain('scrypt$');
    expect(pub.username).toBe('demo');
    // PublicUser schema must also accept its own output (response validation).
    expect(PublicUser.parse(pub).username).toBe('demo');
  });
});

describe('LoginRequest', () => {
  it('rejects empty credentials', () => {
    expect(LoginRequest.safeParse({ username: '', password: 'x' }).success).toBe(false);
    expect(LoginRequest.safeParse({ username: 'demo', password: '' }).success).toBe(false);
  });
});

describe('ChangePasswordRequest', () => {
  it('requires a new password of at least 8 chars', () => {
    expect(
      ChangePasswordRequest.safeParse({ currentPassword: 'demo1234', newPassword: 'short' })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordRequest.safeParse({ currentPassword: 'demo1234', newPassword: 'newpass123' })
        .success,
    ).toBe(true);
  });
});

describe('CreateUserRequest', () => {
  it('defaults role to viewer and requires a strong-enough password', () => {
    const parsed = CreateUserRequest.parse({
      username: 'newbie',
      password: 'longenough1',
      email: 'n@example.com',
      displayName: 'New Bie',
    });
    expect(parsed.role).toBe('viewer');
    expect(
      CreateUserRequest.safeParse({
        username: 'newbie',
        password: 'short',
        email: 'n@example.com',
        displayName: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('AddColumnRequest', () => {
  it('accepts a valid dynamic column', () => {
    const parsed = AddColumnRequest.parse({ name: 'team', type: 'string', defaultValue: 'core' });
    expect(parsed.name).toBe('team');
  });

  it('rejects invalid column names', () => {
    expect(AddColumnRequest.safeParse({ name: '1bad', type: 'string' }).success).toBe(false);
    expect(AddColumnRequest.safeParse({ name: 'has space', type: 'string' }).success).toBe(false);
  });

  it('rejects reserved base-field names', () => {
    expect(AddColumnRequest.safeParse({ name: 'username', type: 'string' }).success).toBe(false);
    expect(AddColumnRequest.safeParse({ name: 'passwordHash', type: 'string' }).success).toBe(
      false,
    );
  });

  it('requires defaultValue to match the column type', () => {
    expect(
      AddColumnRequest.safeParse({ name: 'level', type: 'number', defaultValue: 'high' }).success,
    ).toBe(false);
    expect(
      AddColumnRequest.safeParse({ name: 'level', type: 'number', defaultValue: 3 }).success,
    ).toBe(true);
    expect(
      AddColumnRequest.safeParse({ name: 'oncall', type: 'boolean', defaultValue: 'yes' }).success,
    ).toBe(false);
    expect(
      AddColumnRequest.safeParse({ name: 'oncall', type: 'boolean', defaultValue: null }).success,
    ).toBe(true);
  });
});

describe('QueryRequest', () => {
  it('rejects empty or oversized SQL', () => {
    expect(QueryRequest.safeParse({ sql: '' }).success).toBe(false);
    expect(QueryRequest.safeParse({ sql: 'SELECT 1'.padEnd(4001, ' ') }).success).toBe(false);
    expect(QueryRequest.safeParse({ sql: 'SELECT 1' }).success).toBe(true);
  });
});

describe('ObsSnapshot', () => {
  it('parses a realistic snapshot payload', () => {
    const snapshot = {
      generatedAt: '2026-09-02T21:00:00.000Z',
      gateway: {
        live: { status: 'up' },
        ready: { status: 'up' },
        uptimeSeconds: 3600,
        models: { status: 'up', count: 2, names: ['vendor/a', 'vendor/b'] },
      },
      director: {
        checkpoint: {
          status: 'up',
          lastTickAt: '2026-09-02T20:59:00.000Z',
          ageMinutes: 1,
        },
        ledgerTail: [
          { at: '2026-09-02T19:47:17.215Z', kind: 'observation', detail: 'submitted=1382' },
        ],
        ledgerEntries: 142,
      },
      kafka: { enabled: true, broker: { status: 'up', detail: 'localhost:19092' } },
      slack: { status: 'unconfigured' },
      rag: { status: 'down', detail: 'index.db not found' },
    };
    const parsed = ObsSnapshot.parse(snapshot);
    expect(parsed.gateway.models.count).toBe(2);
    expect(parsed.director.ledgerTail[0]?.kind).toBe('observation');
  });

  it('rejects an unknown component status', () => {
    expect(
      ObsSnapshot.safeParse({
        generatedAt: '2026-09-02T21:00:00.000Z',
        gateway: {
          live: { status: 'wat' },
          ready: { status: 'down' },
          uptimeSeconds: null,
          models: { status: 'down', count: null, names: [] },
        },
        director: {
          checkpoint: { status: 'down', lastTickAt: null, ageMinutes: null },
          ledgerTail: [],
          ledgerEntries: null,
        },
        kafka: { enabled: false, broker: { status: 'down' } },
        slack: { status: 'unconfigured' },
        rag: { status: 'unconfigured' },
      }).success,
    ).toBe(false);
  });
});
