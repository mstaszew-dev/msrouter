/**
 * Tests for the protected route wrapper: loading state, redirect to /login
 * when anonymous, render-through when authenticated.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from './ProtectedRoute';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';

vi.mock('../api/client', () => ({
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
  unauthorizedHandler: { set: () => {} },
  api: {},
}));

function renderWithAuth(value: AuthContextValue): void {
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>login page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>protected content</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const base = { login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };

describe('ProtectedRoute', () => {
  it('renders children when authenticated', () => {
    renderWithAuth({ status: 'authenticated', user: null, ...base });
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  it('shows a loading state while the session is restored', () => {
    renderWithAuth({ status: 'loading', user: null, ...base });
    expect(screen.getByText('Restoring session…')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('redirects anonymous visitors to /login', () => {
    renderWithAuth({ status: 'anonymous', user: null, ...base });
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });
});
