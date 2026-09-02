/**
 * Tests for the flat-file user store: the "tiny data layer" of the console.
 * data/users.json is the single persistence unit - validated with the shared
 * zod schema on load, mutated through small domain methods, and written back
 * atomically (temp file + rename) like the rest of msrouter's JSON files.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, DomainError, ValidationError } from '../common/errors.js';
import type { ColumnDef, UsersFile } from '../shared/schema.js';

import { UserStore } from './userStore.js';

const demoUser: UsersFile['users'][number] = {
  username: 'demo',
  passwordHash: 'scrypt$16384$8$1$aa$bb',
  role: 'admin',
  email: 'demo@example.com',
  displayName: 'Demo User',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
};

const viewerUser: UsersFile['users'][number] = {
  username: 'viewer',
  passwordHash: 'scrypt$16384$8$1$cc$dd',
  role: 'viewer',
  email: 'viewer@example.com',
  displayName: 'Viewer',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
};

const seedDoc: UsersFile = {
  schemaVersion: 1,
  columns: [],
  users: [demoUser, viewerUser],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'users-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seedPath(): string {
  return join(dir, 'users.json');
}

async function writeSeed(doc: unknown = seedDoc): Promise<string> {
  const p = seedPath();
  await writeFile(p, JSON.stringify(doc, null, 2), 'utf8');
  return p;
}

describe('UserStore.load', () => {
  it('loads and validates a users file', async () => {
    const p = await writeSeed();
    const store = await UserStore.load(p);
    expect(store.find('demo')?.displayName).toBe('Demo User');
    expect(store.users()).toHaveLength(2);
  });

  it('throws NotFoundError when the file does not exist', async () => {
    const err = await UserStore.load(join(dir, 'missing.json')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).statusCode).toBe(404);
  });

  it('throws ValidationError on corrupt JSON', async () => {
    const p = seedPath();
    await writeFile(p, '{not json', 'utf8');
    const err = await UserStore.load(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when a record violates the schema', async () => {
    const p = await writeSeed({
      schemaVersion: 1,
      columns: [],
      users: [{ ...demoUser, role: 'superuser' }],
    });
    const err = await UserStore.load(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
  });
});

describe('UserStore.save', () => {
  it('writes the document atomically and leaves no temp files', async () => {
    const p = await writeSeed();
    const store = await UserStore.load(p);
    store.updateProfile('demo', { displayName: 'Renamed' });
    await store.save(p);
    const reloaded = await UserStore.load(p);
    expect(reloaded.find('demo')?.displayName).toBe('Renamed');
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('creates missing parent directories', async () => {
    const p = join(dir, 'nested', 'deeper', 'users.json');
    const store = new UserStore(seedDoc);
    await store.save(p);
    expect((await UserStore.load(p)).users()).toHaveLength(2);
  });
});

describe('addUser / setPassword / updateProfile', () => {
  it('adds a user and rejects duplicates', async () => {
    const store = new UserStore(seedDoc);
    store.addUser({
      ...demoUser,
      username: 'newbie',
      email: 'newbie@example.com',
      role: 'viewer',
      displayName: 'New Bie',
    });
    expect(store.users()).toHaveLength(3);
    expect(() =>
      store.addUser({
        ...demoUser,
        username: 'newbie',
        email: 'again@example.com',
        displayName: 'Dup',
      }),
    ).toThrow(ConflictError);
  });

  it('sets a new password hash for an existing user', () => {
    const store = new UserStore(seedDoc);
    store.setPassword('demo', 'scrypt$16384$8$1$ff$ee');
    expect(store.find('demo')?.passwordHash).toBe('scrypt$16384$8$1$ff$ee');
  });

  it('throws NotFoundError for unknown users', () => {
    const store = new UserStore(seedDoc);
    expect(() => store.setPassword('ghost', 'x')).toThrow(DomainError);
    expect(() => store.updateProfile('ghost', { displayName: 'x' })).toThrow(DomainError);
  });

  it('updates profile fields selectively', () => {
    const store = new UserStore(seedDoc);
    store.updateProfile('demo', { email: 'new@example.com' });
    const demo = store.find('demo');
    expect(demo?.email).toBe('new@example.com');
    expect(demo?.displayName).toBe('Demo User');
  });
});

describe('addColumn', () => {
  it('backfills the default value onto existing rows and persists', async () => {
    const p = await writeSeed();
    const store = await UserStore.load(p);
    const def: ColumnDef = { name: 'department', type: 'string', defaultValue: 'general' };
    store.addColumn(def);
    expect(store.find('demo')?.['department']).toBe('general');
    await store.save(p);
    const reloaded = await UserStore.load(p);
    expect(reloaded.columns()).toContainEqual(def);
    expect(reloaded.find('viewer')?.['department']).toBe('general');
  });

  it('backfills null when no default is given', () => {
    const store = new UserStore(seedDoc);
    store.addColumn({ name: 'level', type: 'number' });
    expect(store.find('demo')?.['level']).toBeNull();
  });

  it('rejects a duplicate column name', () => {
    const store = new UserStore(seedDoc);
    store.addColumn({ name: 'team', type: 'string', defaultValue: 'core' });
    expect(() => store.addColumn({ name: 'team', type: 'string' })).toThrow(ConflictError);
  });
});
