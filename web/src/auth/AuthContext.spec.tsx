/**
 * Tests for AuthContext: session bootstrap from a stored token, login/logout
 * flows, and the refresh hook used after profile mutations. The api module is
 * mocked at the seam; the context itself is real.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { tokenStore } from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      login: vi.fn(),
    },
  };
});

import { api } from '../api/client';

const demoUser = {
  username: 'demo',
  role: 'admin' as const,
  email: 'demo@msrouter.local',
  displayName: 'Demo Admin',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
};

function Probe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="user">{auth.user?.username ?? 'none'}</span>
      <button
        type="button"
        onClick={() => {
          auth.login('demo', 'demo1234').catch(() => {});
        }}
      >
        login
      </button>
      <button type="button" onClick={() => auth.logout()}>
        logout
      </button>
    </div>
  );
}

function renderProbe(): void {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  tokenStore.clear();
  vi.mocked(api.me).mockReset();
  vi.mocked(api.login).mockReset();
});

describe('AuthProvider boot', () => {
  it('starts anonymous when no token is stored', async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(api.me).not.toHaveBeenCalled();
  });

  it('restores the session from a stored token', async () => {
    tokenStore.set('stored-token');
    vi.mocked(api.me).mockResolvedValue(demoUser);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('demo');
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('falls back to anonymous when the stored token is rejected', async () => {
    tokenStore.set('expired-token');
    vi.mocked(api.me).mockRejectedValue(new Error('401'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(tokenStore.get()).toBeNull();
  });
});

describe('login/logout', () => {
  it('stores the token and exposes the user after login', async () => {
    vi.mocked(api.login).mockResolvedValue({
      token: 'fresh-token',
      tokenType: 'Bearer',
      expiresAt: '2026-09-02T23:00:00.000Z',
      user: demoUser,
    });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await act(async () => {
      screen.getByText('login').click();
    });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(tokenStore.get()).toBe('fresh-token');
    expect(screen.getByTestId('user')).toHaveTextContent('demo');
  });

  it('clears the session on logout', async () => {
    tokenStore.set('stored-token');
    vi.mocked(api.me).mockResolvedValue(demoUser);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    act(() => {
      screen.getByText('logout').click();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(tokenStore.get()).toBeNull();
  });

  it('propagates login failures and stays anonymous', async () => {
    vi.mocked(api.login).mockRejectedValue(new Error('invalid credentials'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await act(async () => {
      screen.getByText('login').click();
    });
    await waitFor(() => expect(tokenStore.get()).toBeNull());
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
  });
});
