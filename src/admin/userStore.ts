/**
 * The tiny data layer of the web console: a flat JSON file (data/users.json)
 * holding the column defs and user rows. Loaded once at boot and validated
 * with the shared zod schema; every mutation goes through a small domain
 * method and is persisted with an atomic temp-file + rename write, the same
 * pattern msrouter uses for its other JSON files (slack outbox, checkpoint).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { toPublicUser, UsersFile } from '../shared/schema.js';
import type {
  ColumnDef,
  PublicUser,
  UserRecord,
  UsersFile as UsersFileDoc,
} from '../shared/schema.js';

export class UserStore {
  /** Construct from already-validated data; `load()` is the file-backed path. */
  constructor(private doc: UsersFileDoc) {}

  /** Load + validate the users file; a missing or corrupt file is fatal. */
  static async load(path: string): Promise<UserStore> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new NotFoundError('users file');
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new ValidationError('users file is not valid JSON');
    }
    const parsed = UsersFile.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ValidationError('users file failed schema validation', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return new UserStore(parsed.data);
  }

  columns(): ColumnDef[] {
    return this.doc.columns;
  }

  users(): UserRecord[] {
    return this.doc.users;
  }

  listPublic(): PublicUser[] {
    return this.doc.users.map(toPublicUser);
  }

  find(username: string): UserRecord | undefined {
    return this.doc.users.find((u) => u.username === username);
  }

  addUser(user: UserRecord): void {
    if (this.find(user.username)) {
      throw new ConflictError(`user '${user.username}' already exists`);
    }
    this.doc.users.push(user);
  }

  setPassword(username: string, passwordHash: string): void {
    this.findOrThrow(username).passwordHash = passwordHash;
  }

  updateProfile(username: string, patch: { email?: string; displayName?: string }): void {
    const user = this.findOrThrow(username);
    if (patch.email !== undefined) user.email = patch.email;
    if (patch.displayName !== undefined) user.displayName = patch.displayName;
  }

  /**
   * Schema evolution: append the column and backfill every existing row with
   * the default (null when the caller gave none), so SQL over the rows sees a
   * consistent column from the first query.
   */
  addColumn(def: ColumnDef): void {
    if (this.doc.columns.some((c) => c.name === def.name)) {
      throw new ConflictError(`column '${def.name}' already exists`);
    }
    this.doc.columns.push(def);
    const backfill = def.defaultValue === undefined ? null : def.defaultValue;
    for (const u of this.doc.users) {
      (u as Record<string, unknown>)[def.name] = backfill;
    }
  }

  /**
   * Atomic write: JSON to a unique temp file in the same dir, then rename.
   * Concurrent calls are serialized through a promise chain so a slow write
   * can never be overtaken by a newer one that snapshots the same doc (last
   * rename wins would otherwise drop the earlier change on next boot).
   */
  async save(path: string): Promise<void> {
    const run = this.pending.then(() => this.writeAtomically(path));
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private pending: Promise<void> = Promise.resolve();

  private async writeAtomically(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(this.doc, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  private findOrThrow(username: string): UserRecord {
    const user = this.find(username);
    if (!user) throw new NotFoundError(`user '${username}'`);
    return user;
  }
}
