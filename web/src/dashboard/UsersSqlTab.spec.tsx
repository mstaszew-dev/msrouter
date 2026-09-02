/**
 * Tests for the Users & SQL tab: users table rendering, the quasi-SQL console
 * (read-only queries + error surfacing), the add-column schema evolution form,
 * user creation, and read-only mode for the viewer role.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsersSqlTab } from './UsersSqlTab';
import type { ColumnDef, PublicUser } from '@shared/schema';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      users: vi.fn(),
      query: vi.fn(),
      addColumn: vi.fn(),
      createUser: vi.fn(),
    },
  };
});

import { api } from '../api/client';

const department: ColumnDef = { name: 'department', type: 'string', defaultValue: 'general' };

const demo: PublicUser = {
  username: 'demo',
  role: 'admin',
  email: 'demo@msrouter.local',
  displayName: 'Demo Admin',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  department: 'platform',
  logins: 0,
};

const viewer: PublicUser = {
  username: 'viewer',
  role: 'viewer',
  email: 'viewer@msrouter.local',
  displayName: 'Read-only Viewer',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  department: 'support',
  logins: 0,
};

beforeEach(() => {
  vi.mocked(api.users).mockReset().mockResolvedValue({
    columns: [department],
    users: [demo, viewer],
  });
  vi.mocked(api.query).mockReset();
  vi.mocked(api.addColumn).mockReset();
  vi.mocked(api.createUser).mockReset();
});

describe('users table', () => {
  it('loads users and shows base + dynamic columns', async () => {
    render(<UsersSqlTab role="admin" />);
    await waitFor(() => expect(screen.getByText('demo')).toBeInTheDocument());
    expect(screen.getAllByText('viewer').length).toBeGreaterThan(0);
    expect(screen.getByText('platform')).toBeInTheDocument();
    expect(screen.getByText('support')).toBeInTheDocument();
    expect(screen.getByText('demo@msrouter.local')).toBeInTheDocument();
    expect(api.users).toHaveBeenCalledTimes(1);
  });
});

describe('SQL console', () => {
  it('runs a query and renders the result table', async () => {
    const user = userEvent.setup();
    vi.mocked(api.query).mockResolvedValue({
      columns: ['username', 'department'],
      rows: [{ username: 'demo', department: 'platform' }],
      rowCount: 1,
    });
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    const textarea = screen.getByLabelText(/sql query/i);
    await user.clear(textarea);
    await user.type(textarea, 'SELECT username, department FROM ?');
    await user.click(screen.getByRole('button', { name: /run query/i }));

    await waitFor(() => expect(screen.getByText(/1 row/)).toBeInTheDocument());
    expect(screen.getAllByText('platform').length).toBeGreaterThan(0);
    expect(api.query).toHaveBeenCalledWith('SELECT username, department FROM ?');
  });

  it('surfaces the server error when a write statement is rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(api.query).mockRejectedValue(
      new Error('only a single read-only SELECT ... FROM ? statement is allowed'),
    );
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    await user.click(screen.getByRole('button', { name: /run query/i }));
    await waitFor(() =>
      expect(screen.getByText(/only a single read-only select/i, { exact: false })).toBeInTheDocument(),
    );
  });
});

describe('add column', () => {
  it('adds a column and refreshes the table', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addColumn).mockResolvedValue({
      columns: [department, { name: 'team', type: 'string', defaultValue: 'core' }],
      users: [demo, viewer],
    });
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    await user.type(screen.getByLabelText(/^column name$/i), 'team');
    await user.click(screen.getByRole('button', { name: /^add column$/i }));

    await waitFor(() => expect(api.addColumn).toHaveBeenCalledWith({ name: 'team', type: 'string' }));
  });

  it('passes the chosen column type through', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addColumn).mockResolvedValue({
      columns: [department, { name: 'level', type: 'number' }],
      users: [demo, viewer],
    });
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    await user.type(screen.getByLabelText(/^column name$/i), 'level');
    await user.selectOptions(screen.getByLabelText(/^column type$/i), 'number');
    await user.click(screen.getByRole('button', { name: /^add column$/i }));

    await waitFor(() => expect(api.addColumn).toHaveBeenCalledWith({ name: 'level', type: 'number' }));
  });

  it('shows a validation error for a rejected column name', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addColumn).mockRejectedValue(new Error("'username' is a reserved base field"));
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    await user.type(screen.getByLabelText(/^column name$/i), 'username');
    await user.click(screen.getByRole('button', { name: /^add column$/i }));
    await waitFor(() => expect(screen.getByText(/reserved base field/i)).toBeInTheDocument());
  });
});

describe('create user', () => {
  it('creates a user through the form', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createUser).mockResolvedValue({
      ...demo,
      username: 'newbie',
      email: 'newbie@msrouter.local',
      displayName: 'New Bie',
      role: 'viewer',
    });
    render(<UsersSqlTab role="admin" />);
    await screen.findByText('demo');

    await user.type(screen.getByLabelText(/^new username$/i), 'newbie');
    await user.type(screen.getByLabelText(/^new password$/i), 'longenough1');
    await user.type(screen.getByLabelText(/^new email$/i), 'newbie@msrouter.local');
    await user.type(screen.getByLabelText(/^display name$/i), 'New Bie');
    await user.click(screen.getByRole('button', { name: /^create user$/i }));

    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        username: 'newbie',
        password: 'longenough1',
        role: 'viewer',
        email: 'newbie@msrouter.local',
        displayName: 'New Bie',
      }),
    );
  });
});

describe('viewer role (read-only)', () => {
  it('hides the SQL console and mutation forms', async () => {
    render(<UsersSqlTab role="viewer" />);
    await screen.findByText('demo');
    expect(screen.queryByLabelText(/sql query/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^column name$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^new username$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
  });
});
