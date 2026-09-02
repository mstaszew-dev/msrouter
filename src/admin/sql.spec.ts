/**
 * Tests for the quasi-SQL console engine. Users run free-form SQL against the
 * bound users array (`FROM ?`); the engine parser-verifies the statement is a
 * single read-only SELECT: no INTO (file/table writes), no non-param FROM
 * sources (alasql can read files via FROM CSV(...)), no multi-statements.
 * Enforcement is AST-based, not regex-based, so string literals containing
 * ';' or 'INTO' cannot smuggle anything past the guard.
 */
import { describe, expect, it } from 'vitest';

import { QueryResponse } from '../shared/schema.js';

import { runUsersQuery } from './sql.js';

const users = [
  { username: 'demo', role: 'admin', active: true, department: 'platform', logins: 12 },
  { username: 'viewer', role: 'viewer', active: true, department: 'support', logins: 3 },
  { username: 'old', role: 'viewer', active: false, department: null, logins: 0 },
];

describe('runUsersQuery', () => {
  it('runs a SELECT over the bound users array', async () => {
    const res = await runUsersQuery('SELECT username, role FROM ? WHERE active = true', users, [
      'username',
      'role',
      'active',
      'department',
      'logins',
    ]);
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([
      { username: 'demo', role: 'admin' },
      { username: 'viewer', role: 'viewer' },
    ]);
    expect(res.columns).toEqual(['username', 'role']);
    expect(QueryResponse.parse(res)).toBeTruthy();
  });

  it('supports aggregations and ORDER BY', async () => {
    const res = await runUsersQuery(
      'SELECT department, COUNT(*) AS n FROM ? GROUP BY department ORDER BY n DESC',
      users,
      ['department', 'logins'],
    );
    expect(res.rows[0]).toEqual({ department: 'platform', n: 1 });
    expect(res.rowCount).toBe(3);
  });

  it('reports columns from the query even with zero rows', async () => {
    const res = await runUsersQuery('SELECT username FROM ? WHERE active = false AND 1=0', users, [
      'username',
    ]);
    expect(res.rowCount).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.columns).toEqual(['username']);
  });

  it('falls back to known columns for SELECT * with an empty table', async () => {
    const res = await runUsersQuery('SELECT * FROM ?', [], ['username', 'role']);
    expect(res.columns).toEqual(['username', 'role']);
    expect(res.rowCount).toBe(0);
  });

  it('rejects non-SELECT statements (UPDATE, DELETE, INSERT, DROP)', async () => {
    await expect(runUsersQuery("UPDATE ? SET role = 'admin'", users, ['role'])).rejects.toThrow(
      /SELECT/,
    );
    await expect(runUsersQuery('DELETE FROM ? WHERE 1=1', users, ['role'])).rejects.toThrow(
      /SELECT/,
    );
    await expect(runUsersQuery('INSERT INTO x VALUES (1)', users, [])).rejects.toThrow(/SELECT/);
    await expect(runUsersQuery('DROP TABLE x', users, [])).rejects.toThrow(/SELECT/);
  });

  it('rejects multiple statements, including via trailing semicolons', async () => {
    await expect(runUsersQuery('SELECT 1; SELECT 2', users, [])).rejects.toThrow(/SELECT/);
    await expect(
      runUsersQuery('SELECT * FROM ?; DROP TABLE users --', users, ['username']),
    ).rejects.toThrow(/SELECT/);
  });

  it('rejects SELECT INTO (file or table sink)', async () => {
    await expect(runUsersQuery("SELECT * INTO CSV('evil.csv') FROM ?", users, [])).rejects.toThrow(
      /SELECT/,
    );
    await expect(runUsersQuery('SELECT * INTO out FROM ?', users, [])).rejects.toThrow(/SELECT/);
  });

  it('rejects FROM function sources (file reads like FROM CSV(...))', async () => {
    await expect(runUsersQuery("SELECT * FROM CSV('secret.csv')", users, [])).rejects.toThrow(
      /SELECT/,
    );
  });

  it('rejects subqueries and nested non-param sources anywhere in the statement', async () => {
    await expect(runUsersQuery('SELECT (SELECT 1) AS x FROM ?', users, [])).rejects.toThrow(
      /SELECT/,
    );
    await expect(
      runUsersQuery(
        "SELECT * FROM ? WHERE username IN (SELECT [0] FROM TXT('/etc/passwd'))",
        users,
        ['username'],
      ),
    ).rejects.toThrow(/SELECT/);
    await expect(
      runUsersQuery(
        "SELECT * FROM ? WHERE username IN (SELECT username FROM CSV('x.csv'))",
        users,
        ['username'],
      ),
    ).rejects.toThrow(/SELECT/);
  });

  it('rejects malformed SQL with a validation error', async () => {
    await expect(runUsersQuery('SELEC * FRMO ?', users, [])).rejects.toThrow();
  });

  it('preserves the users array (read-only execution)', async () => {
    const before = JSON.stringify(users);
    await runUsersQuery('SELECT * FROM ?', users, ['username']);
    expect(JSON.stringify(users)).toBe(before);
  });
});
