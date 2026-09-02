/**
 * Client-side auth session: JWT persistence (localStorage) + the current user
 * profile. Bootstrap restores a stored token via /auth/me so reloads keep the
 * session; a rejected token is dropped and the app falls back to anonymous.
 * Nothing here inspects the token payload - the server is the only authority.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, tokenStore } from '../api/client';
import type { PublicUser } from '@shared/schema';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: PublicUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** Re-fetch the current user (after profile mutations). */
  refresh: () => Promise<void>;
}

/** Exported for tests that need to inject a specific session state. */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = tokenStore.get();
    if (!token) {
      setStatus('anonymous');
      return;
    }
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        tokenStore.clear();
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    tokenStore.set(res.token);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refresh = useCallback(async () => {
    setUser(await api.me());
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, refresh }),
    [status, user, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
