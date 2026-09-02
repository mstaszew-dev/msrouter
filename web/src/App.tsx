/**
 * App root: wires the router, the auth session, and the shared layout. Public
 * pages (login, about) share the nav with protected ones (dashboard,
 * profile); protected routes render through ProtectedRoute.
 */
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';

import { useAuth } from './auth/AuthContext';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AboutPage } from './pages/AboutPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';

function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();

  const authed = status === 'authenticated';

  function handleLogout(): void {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <nav className="border-b border-slate-800 bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-bold tracking-tight text-slate-100">
              msrouter<span className="text-cyan-400"> console</span>
            </Link>
            <div className="flex items-center gap-1 text-sm">
              <NavTab to="/" label="Dashboard" visible={authed} />
              <NavTab to="/profile" label="Profile" visible={authed} />
              <NavTab to="/about" label="About" visible />
            </div>
          </div>
          {authed ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="hidden text-slate-400 sm:inline">
                {user?.displayName} ({user?.role})
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-cyan-500"
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <footer className="border-t border-slate-800/60 py-4 text-center text-xs text-slate-600">
        msrouter: local LLM gateway and Director - MIT -{' '}
        <a
          href="https://github.com/mstaszew-dev/msrouter"
          className="hover:text-slate-400"
          target="_blank"
          rel="noreferrer"
        >
          github.com/mstaszew-dev/msrouter
        </a>
      </footer>
    </div>
  );
}

function NavTab({ to, label, visible }: { to: string; label: string; visible: boolean }): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Link
      to={to}
      className="rounded-md px-3 py-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
    >
      {label}
    </Link>
  );
}

export function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route element={<Shell />}>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfilePage />
              </ProtectedRoute>
            }
          />
        </Route>
        <Route element={<Shell />}>
          <Route path="/about" element={<AboutPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

/** Authed users have no business on the login page; bounce to the dashboard. */
function PublicOnly({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status } = useAuth();
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Shell(): React.JSX.Element {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
