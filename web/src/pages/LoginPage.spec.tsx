/**
 * Tests for the login page: field rendering, submit flow, error surfacing,
 * pending state, and navigation on success.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { LoginPage } from './LoginPage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: {} };
});

const base = { refresh: vi.fn() };
const noop = vi.fn();

function renderLogin(loginMock: (u: string, p: string) => Promise<void>): void {
  const value = {
    status: 'anonymous',
    user: null,
    login: loginMock,
    logout: noop,
    ...base,
  } as AuthContextValue;
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>dashboard reached</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('LoginPage', () => {
  it('renders username and password fields with a demo-credentials hint', () => {
    renderLogin(vi.fn());
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByText(/demo \/ demo1234/i)).toBeInTheDocument();
  });

  it('submits the entered credentials and lands on the dashboard', async () => {
    const user = userEvent.setup();
    const loginMock = vi.fn().mockResolvedValue(undefined);
    renderLogin(loginMock);

    await user.type(screen.getByLabelText(/username/i), 'demo');
    await user.type(screen.getByLabelText(/password/i), 'demo1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText('dashboard reached')).toBeInTheDocument());
    expect(loginMock).toHaveBeenCalledWith('demo', 'demo1234');
  });

  it('shows the server error message on failed login', async () => {
    const user = userEvent.setup();
    renderLogin(vi.fn().mockRejectedValue(new Error('invalid credentials')));
    await user.type(screen.getByLabelText(/username/i), 'demo');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid credentials'));
    expect(screen.getByLabelText(/username/i)).toHaveValue('demo');
  });

  it('disables the submit button while a login is in flight', async () => {
    const user = userEvent.setup();
    let resolveLogin: () => void = () => {};
    renderLogin(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    await user.type(screen.getByLabelText(/username/i), 'demo');
    await user.type(screen.getByLabelText(/password/i), 'demo1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    resolveLogin();
  });
});
