import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { setTimezone } from './format';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      setTimezone(m.app.timezone);
      setMe(m);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    await api('/auth/login', { body: { username, password } });
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    setMe(null);
  }, []);

  const can = useCallback((perm: string) => !!me?.permissions.includes(perm), [me]);

  return <Ctx.Provider value={{ me, loading, can, login, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}

/** Subscribe to live visit events (SSE). The callback is debounced; payloads hold IDs only. */
export function useLiveEvents(onEvent: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const es = new EventSource('/api/events', { withCredentials: true });
    const handler = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onEvent, 400);
    };
    es.addEventListener('visit', handler);
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [onEvent, enabled]);
}
