/**
 * Regenerate the demo users file (data/users.json). Idempotent: overwrites the
 * file with fresh scrypt hashes for the two documented demo accounts.
 *
 *   npx tsx scripts/seed-users.ts [password] [viewerPassword]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { hashPassword } from '../src/admin/password.js';
import { UsersFile } from '../src/shared/schema.js';

async function main(): Promise<void> {
  const adminPassword = process.argv[2] ?? 'demo1234';
  const viewerPassword = process.argv[3] ?? 'viewer1234';
  const outPath = resolve(process.argv[4] ?? 'data/users.json');

  const now = new Date().toISOString();
  const [adminHash, viewerHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(viewerPassword),
  ]);

  const doc = UsersFile.parse({
    schemaVersion: 1,
    columns: [
      { name: 'department', type: 'string', defaultValue: 'general' },
      { name: 'logins', type: 'number', defaultValue: 0 },
    ],
    users: [
      {
        username: 'demo',
        passwordHash: adminHash,
        role: 'admin',
        email: 'demo@msrouter.local',
        displayName: 'Demo Admin',
        active: true,
        createdAt: now,
        department: 'platform',
        logins: 0,
      },
      {
        username: 'viewer',
        passwordHash: viewerHash,
        role: 'viewer',
        email: 'viewer@msrouter.local',
        displayName: 'Read-only Viewer',
        active: true,
        createdAt: now,
        department: 'support',
        logins: 0,
      },
    ],
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  // CLI bootstrap output; console.log is the right tool here (repo no-console
  // allows warn/error, but this is a one-shot script, not app code).
  // eslint-disable-next-line no-console
  console.log(`seeded ${outPath} (demo/${adminPassword}, viewer/${viewerPassword})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
