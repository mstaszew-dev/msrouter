/**
 * Login page: username/password form backed by AuthContext.login, error
 * surfacing (invalid credentials, rate limiting, disabled accounts), a
 * disabled in-flight state, and a hint with the committed demo accounts.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function LoginPage(): React.JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !pending;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'RATE_LIMITED'
          ? 'Too many attempts. Wait a minute and try again.'
          : err instanceof Error
            ? err.message
            : 'login failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">msrouter console</h1>
          <p className="mt-2 text-sm text-slate-400">
            Local LLM gateway: dashboard, users, and architecture docs
          </p>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-lg"
        >
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-300"
            >
              {error}
            </div>
          )}

          <label htmlFor="username" className="block text-sm font-medium text-slate-300">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-cyan-500"
          />

          <label htmlFor="password" className="mt-4 block text-sm font-medium text-slate-300">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-cyan-500"
          />

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-6 w-full rounded-lg bg-cyan-600 px-4 py-2 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="mt-6 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
            <p className="font-medium text-slate-300">Demo accounts</p>
            <p className="mt-1">admin: demo / demo1234</p>
            <p>read-only: viewer / viewer1234</p>
          </div>
        </form>
      </div>
    </div>
  );
}
