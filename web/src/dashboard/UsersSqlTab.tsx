/**
 * Users & SQL tab: the flat-file users table, the quasi-SQL console
 * (SELECT-only, enforced server-side), schema evolution (add column), and
 * user creation. Mutation forms are admin-only; viewers get a read-only view.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '../api/client';
import type { ColumnDef, ColumnType, PublicUser, UserRole } from '@shared/schema';

const BASE_COLUMNS = ['username', 'role', 'email', 'displayName', 'createdAt'] as const;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'request failed';
}

/** Dynamic column values are scalar-or-null by schema; format defensively. */
function cellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function UsersTable({ columns, users }: { columns: ColumnDef[]; users: PublicUser[] }): React.JSX.Element {
  const dynamic = columns.map((c) => c.name);
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            {BASE_COLUMNS.map((c) => (
              <th key={c} className="px-4 py-2 font-medium">
                {c}
              </th>
            ))}
            {dynamic.map((c) => (
              <th key={c} className="px-4 py-2 font-medium text-cyan-400/80">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {users.map((u) => {
            const row = u as Record<string, unknown>;
            return (
              <tr key={u.username} className="text-slate-300">
                <td className="px-4 py-2 font-medium">{u.username}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      u.role === 'admin' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs">{u.email}</td>
                <td className="px-4 py-2 text-xs">{u.displayName}</td>
                <td className="px-4 py-2 text-xs text-slate-400">{u.createdAt.slice(0, 10)}</td>
                {dynamic.map((c) => (
                  <td key={c} className="px-4 py-2 text-xs text-slate-400">
                    {cellValue(row[c])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500';
const labelClass = 'block text-xs font-medium text-slate-400';
const buttonClass =
  'rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50';

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export function UsersSqlTab({ role }: { role: UserRole }): React.JSX.Element {
  const isAdmin = role === 'admin';
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sql, setSql] = useState('SELECT username, role, department FROM ?');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState<ColumnType>('string');
  const [columnError, setColumnError] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);

  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    email: '',
    displayName: '',
    role: 'viewer' as UserRole,
  });
  const [userError, setUserError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const res = await api.users();
      setColumns(res.columns);
      setUsers(res.users);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function runQuery(): Promise<void> {
    setQuerying(true);
    setQueryError(null);
    try {
      setResult(await api.query(sql));
    } catch (err) {
      setResult(null);
      setQueryError(errorText(err));
    } finally {
      setQuerying(false);
    }
  }

  async function addColumn(): Promise<void> {
    const name = columnName.trim();
    if (!name) return;
    setAddingColumn(true);
    setColumnError(null);
    try {
      const res = await api.addColumn({ name, type: columnType });
      setColumns(res.columns);
      setUsers(res.users);
      setColumnName('');
    } catch (err) {
      setColumnError(errorText(err));
    } finally {
      setAddingColumn(false);
    }
  }

  async function createUser(): Promise<void> {
    setCreating(true);
    setUserError(null);
    try {
      await api.createUser(newUser);
      setNewUser({ username: '', password: '', email: '', displayName: '', role: 'viewer' });
      await loadUsers();
    } catch (err) {
      setUserError(errorText(err));
    } finally {
      setCreating(false);
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/40 p-6 text-sm text-red-300">
        Could not load users: {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <UsersTable columns={columns} users={users} />

      {isAdmin ? (
        <>
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h3 className="text-sm font-medium text-slate-300">SQL console (read-only)</h3>
            <p className="mt-1 text-xs text-slate-500">
              Quasi-SQL over the users array via AlaSQL. Only single SELECT ... FROM ? statements
              are allowed; writes go through the forms below.
            </p>
            <textarea
              aria-label="SQL query"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={3}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-cyan-500"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void runQuery()}
                disabled={querying}
                className={buttonClass}
              >
                {querying ? 'Running…' : 'Run query'}
              </button>
              {result && (
                <span className="text-xs text-slate-400">
                  {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {queryError && (
              <div role="alert" className="mt-3 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
                {queryError}
              </div>
            )}
            {result && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      {result.columns.map((c) => (
                        <th key={c} className="px-3 py-1.5 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {result.rows.map((row, i) => (
                      <tr key={i} className="text-slate-300">
                        {result.columns.map((c) => (
                          <td key={c} className="px-3 py-1.5">
                            {cellValue(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void addColumn();
              }}
              className="rounded-xl border border-slate-800 bg-slate-900 p-5"
            >
              <h3 className="text-sm font-medium text-slate-300">Add column</h3>
              <p className="mt-1 text-xs text-slate-500">
                Extends the users flat-file schema; existing rows are backfilled with the default.
              </p>
              <label htmlFor="column-name" className={`${labelClass} mt-3`}>
                Column name
              </label>
              <input
                id="column-name"
                aria-label="column name"
                value={columnName}
                onChange={(e) => setColumnName(e.target.value)}
                placeholder="e.g. team"
                className={`${inputClass} mt-1`}
              />
              <label htmlFor="column-type" className={`${labelClass} mt-3`}>
                Column type
              </label>
              <select
                id="column-type"
                aria-label="column type"
                value={columnType}
                onChange={(e) => setColumnType(e.target.value as ColumnType)}
                className={`${inputClass} mt-1`}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              {columnError && (
                <div role="alert" className="mt-2 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
                  {columnError}
                </div>
              )}
              <button type="submit" disabled={addingColumn || !columnName.trim()} className={`${buttonClass} mt-3`}>
                {addingColumn ? 'Adding…' : 'Add column'}
              </button>
            </form>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createUser();
              }}
              className="rounded-xl border border-slate-800 bg-slate-900 p-5"
            >
              <h3 className="text-sm font-medium text-slate-300">Create user</h3>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="new-username" className={labelClass}>
                    New username
                  </label>
                  <input
                    id="new-username"
                    aria-label="new username"
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="new-password" className={labelClass}>
                    New password
                  </label>
                  <input
                    id="new-password"
                    aria-label="new password"
                    type="password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="new-email" className={labelClass}>
                    New email
                  </label>
                  <input
                    id="new-email"
                    aria-label="new email"
                    type="email"
                    value={newUser.email}
                    onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="display-name" className={labelClass}>
                    Display name
                  </label>
                  <input
                    id="display-name"
                    aria-label="display name"
                    value={newUser.displayName}
                    onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="new-role" className={labelClass}>
                    Role
                  </label>
                  <select
                    id="new-role"
                    aria-label="role"
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
                    className={`${inputClass} mt-1`}
                  >
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                  </select>
                </div>
              </div>
              {userError && (
                <div role="alert" className="mt-2 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
                  {userError}
                </div>
              )}
              <button
                type="submit"
                disabled={
                  creating ||
                  !newUser.username ||
                  newUser.password.length < 8 ||
                  !newUser.email ||
                  !newUser.displayName
                }
                className={`${buttonClass} mt-3`}
              >
                {creating ? 'Creating…' : 'Create user'}
              </button>
            </form>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          Read-only access: the SQL console, column management, and user creation require the admin
          role.
        </div>
      )}
    </div>
  );
}
