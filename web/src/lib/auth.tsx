import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, getToken, setToken, clearToken } from './api';
import type { User } from './types';
import { analytics } from './analytics';

interface AuthState {
  user: User | null;
  needsSetup: boolean; // fresh instance: zero users → first-run register
  allowRegistration: boolean; // server allows the "Create account" action
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await api<{ needsSetup: boolean; allowRegistration?: boolean }>('/auth/bootstrap');
        if (!cancelled) {
          setNeedsSetup(boot.needsSetup);
          setAllowRegistration(boot.allowRegistration ?? boot.needsSetup);
        }
      } catch {
        /* server down — Login will surface the error */
      }
      const token = getToken();
      if (token) {
        try {
          const me = await api<{ user: User }>('/auth/me');
          if (!cancelled) {
            setUser(me.user);
            analytics.identifyOperator(me.user.id);
          }
        } catch {
          clearToken();
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    setToken(res.token);
    setUser(res.user);
    analytics.identifyOperator(res.user.id);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/auth/register', { method: 'POST', body: { email, password } });
    setToken(res.token);
    setUser(res.user);
    analytics.identifyOperator(res.user.id);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    analytics.reset();
  }, []);

  return (
    <Ctx.Provider value={{ user, needsSetup, allowRegistration, loading, login, register, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
