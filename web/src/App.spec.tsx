/**
 * App-level routing integration tests (no route stubs): session redirect for
 * protected pages, public about page, login flow end-to-end through the real
 * AuthProvider with a mocked API seam, and logout.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

const state = vi.hoisted(() => {
  const tokenStore = {
    v: null as string | null,
    get() {
      return this.v;
    },
    set(t: string) {
      this.v = t;
    },
    clear() {
      this.v = null;
    },
  };
  return { tokenStore, api: { login: vi.fn(), me: vi.fn() } };
});

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>();
  return {
    ...actual,
    tokenStore: state.tokenStore,
    api: state.api,
  };
});

function renderAt(entries: string[]): void {
  render(
    <MemoryRouter initialEntries={entries}>
      <App />
    </MemoryRouter>,
  );
}

const demoUser = {
  username: 'demo',
  role: 'admin',
  email: 'demo@msrouter.local',
  displayName: 'Demo Admin',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
};

beforeEach(() => {
  state.tokenStore.clear();
  state.api.login.mockReset();
  state.api.me.mockReset();
});

describe('App routing', () => {
  it('redirects anonymous visitors from / to /login', async () => {
    renderAt(['/']);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'msrouter console' })).toBeInTheDocument());
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
  });

  it('serves the public about page without authentication', async () => {
    renderAt(['/about']);
    expect(await screen.findByRole('heading', { name: 'What msrouter is' })).toBeInTheDocument();
  });

  it('logs in through the UI and reaches the dashboard, then logs out', async () => {
    const user = userEvent.setup();
    state.api.login.mockResolvedValue({
      token: 'tok',
      tokenType: 'Bearer',
      expiresAt: '2026-09-02T23:00:00.000Z',
      user: demoUser,
    });
    renderAt(['/login']);

    await user.type(await screen.findByLabelText(/username/i), 'demo');
    await user.type(screen.getByLabelText(/password/i), 'demo1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(state.tokenStore.get()).toBeNull();
  });

  it('restores an existing session straight into the dashboard', async () => {
    state.tokenStore.set('stored');
    state.api.me.mockResolvedValue(demoUser);
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
