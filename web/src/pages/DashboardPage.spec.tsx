/**
 * Tests for the dashboard shell: tab switching between the observability
 * overview and the users/SQL console. Child tabs are stubbed - the shell only
 * owns the tab state and role wiring.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DashboardPage } from './DashboardPage';

vi.mock('../dashboard/OverviewTab', () => ({
  OverviewTab: () => <div>overview panel</div>,
}));

vi.mock('../dashboard/UsersSqlTab', () => ({
  UsersSqlTab: ({ role }: { role: string }) => <div>users panel ({role})</div>,
}));

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      status: 'authenticated',
      user: {
        username: 'demo',
        role: 'admin',
        email: 'demo@msrouter.local',
        displayName: 'Demo Admin',
        active: true,
        createdAt: '2026-09-01T10:00:00.000Z',
      },
      login: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    }),
  };
});

describe('DashboardPage', () => {
  it('renders the overview tab by default', () => {
    render(<DashboardPage />);
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('overview panel')).toBeInTheDocument();
  });

  it('switches to the users & SQL tab', async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByRole('tab', { name: /users & sql/i }));
    expect(screen.getByRole('tab', { name: /users & sql/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('users panel (admin)')).toBeInTheDocument();
    expect(screen.queryByText('overview panel')).not.toBeInTheDocument();
  });
});
