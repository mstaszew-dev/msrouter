/**
 * Tests for the profile page: shows the signed-in user, updates email /
 * display name, and changes the password (with confirmation + server errors).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePage } from './ProfilePage';
import type { AuthContextValue } from '../auth/AuthContext';

const authState = vi.hoisted(() => ({
  current: {
    status: 'authenticated',
    user: {
      username: 'demo',
      role: 'admin' as const,
      email: 'demo@msrouter.local',
      displayName: 'Demo Admin',
      active: true,
      createdAt: '2026-09-01T10:00:00.000Z',
    },
    logout: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>();
  return { ...actual, useAuth: () => authState.current as AuthContextValue };
});

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      updateProfile: vi.fn(),
      changePassword: vi.fn(),
    },
  };
});

import { api } from '../api/client';

beforeEach(() => {
  vi.mocked(api.updateProfile).mockReset();
  vi.mocked(api.changePassword).mockReset();
});

describe('ProfilePage', () => {
  it('shows the current user profile fields', () => {
    render(<ProfilePage />);
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('demo@msrouter.local')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('updates email and refreshes the session', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateProfile).mockResolvedValue({
      ...authState.current.user,
      email: 'new@msrouter.local',
    });
    render(<ProfilePage />);

    await user.clear(screen.getByLabelText(/email/i));
    await user.type(screen.getByLabelText(/email/i), 'new@msrouter.local');
    await user.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() =>
      expect(api.updateProfile).toHaveBeenCalledWith({ email: 'new@msrouter.local' }),
    );
    expect(authState.current.refresh).toHaveBeenCalled();
    expect(screen.getByText(/profile updated/i)).toBeInTheDocument();
  });

  it('changes the password with a matching confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(api.changePassword).mockResolvedValue(authState.current.user);
    render(<ProfilePage />);

    await user.type(screen.getByLabelText(/^current password$/i), 'demo1234');
    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass');
    await user.type(screen.getByLabelText(/confirm new password/i), 'brand-new-pass');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() =>
      expect(api.changePassword).toHaveBeenCalledWith({
        currentPassword: 'demo1234',
        newPassword: 'brand-new-pass',
      }),
    );
    expect(screen.getByText(/password changed/i)).toBeInTheDocument();
  });

  it('refuses mismatched password confirmation without a server call', async () => {
    const user = userEvent.setup();
    render(<ProfilePage />);

    await user.type(screen.getByLabelText(/^current password$/i), 'demo1234');
    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass');
    await user.type(screen.getByLabelText(/confirm new password/i), 'different-pass');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('surfaces a wrong current-password error from the server', async () => {
    const user = userEvent.setup();
    vi.mocked(api.changePassword).mockRejectedValue(new Error('current password is incorrect'));
    render(<ProfilePage />);

    await user.type(screen.getByLabelText(/^current password$/i), 'wrong-pass');
    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass');
    await user.type(screen.getByLabelText(/confirm new password/i), 'brand-new-pass');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
  });
});
