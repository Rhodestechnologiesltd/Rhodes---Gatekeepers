import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, configureApi, setUnauthorizedHandler } from '../lib/api';
import { setTimezone } from '../lib/format';
import { APP_VERSION, PLATFORM } from '../lib/platform';
import type { Me } from '../lib/types';
import { secureStore } from './storage';
import { startUploadLoop } from './uploads';

interface Device { serverUrl: string; deviceId: string; deviceSecret: string; deviceName: string }
type Stage = 'loading' | 'enroll' | 'login' | 'ready';

interface Session {
  stage: Stage;
  me: Me | null;
  device: Device | null;
  can: (p: string) => boolean;
  enroll: (serverUrl: string, code: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  forgetDevice: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);
export const DEFAULT_SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

export function normaliseServerUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

export function MobileSessionProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [device, setDevice] = useState<Device | null>(null);

  const loadMe = useCallback(async () => {
    const m = await api<Me>('/auth/me');
    setTimezone(m.app.timezone);
    setMe(m);
    setStage('ready');
    startUploadLoop();
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void secureStore.remove('token');
      configureApi({ token: null });
      setMe(null);
      setStage('login');
    });
    void (async () => {
      const raw = await secureStore.get('device');
      const d = raw ? (JSON.parse(raw) as Device) : null;
      if (!d) return setStage('enroll');
      setDevice(d);
      configureApi({ baseUrl: d.serverUrl });
      const token = await secureStore.get('token');
      if (!token) return setStage('login');
      configureApi({ token });
      try {
        await loadMe();
      } catch {
        configureApi({ token: null });
        setStage('login');
      }
    })();
  }, [loadMe]);

  const enroll = useCallback(async (serverUrl: string, code: string) => {
    const url = normaliseServerUrl(serverUrl);
    configureApi({ baseUrl: url, token: null });
    const r = await api<{ deviceId: string; deviceSecret: string; deviceName: string }>('/device/enroll', {
      body: { code, platform: PLATFORM, appVersion: APP_VERSION },
    });
    const d: Device = { serverUrl: url, deviceId: r.deviceId, deviceSecret: r.deviceSecret, deviceName: r.deviceName };
    await secureStore.set('device', JSON.stringify(d));
    setDevice(d);
    setStage('login');
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    if (!device) throw new Error('Tablet is not enrolled');
    const r = await api<{ token: string }>('/auth/mobile/login', {
      body: { username, password },
      headers: { 'X-Device-Id': device.deviceId, 'X-Device-Secret': device.deviceSecret },
    });
    configureApi({ token: r.token });
    await secureStore.set('token', r.token);
    await loadMe();
  }, [device, loadMe]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    await secureStore.remove('token');
    configureApi({ token: null });
    setMe(null);
    setStage('login');
  }, []);

  const forgetDevice = useCallback(async () => {
    await secureStore.remove('token');
    await secureStore.remove('device');
    configureApi({ token: null, baseUrl: '' });
    setDevice(null);
    setMe(null);
    setStage('enroll');
  }, []);

  const can = useCallback((p: string) => !!me?.permissions.includes(p), [me]);
  return <Ctx.Provider value={{ stage, me, device, can, enroll, login, logout, forgetDevice }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}
