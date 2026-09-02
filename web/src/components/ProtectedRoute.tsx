/**
 * Gate for authenticated routes: render children once the session is known to
 * be valid, show a non-flickering loading state during bootstrap, and bounce
 * anonymous visitors to /login.
 */
import { Navigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status } = useAuth();
  if (status === 'authenticated') {
    return <>{children}</>;
  }
  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500" role="status">
        Restoring session…
      </div>
    );
  }
  return <Navigate to="/login" replace />;
}
