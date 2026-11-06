import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { IS_NATIVE } from '../lib/platform';

/**
 * Small key/value store for the tablet's server address, device credentials and session token.
 * Native: iOS Keychain / Android Keystore. Browser (demo/testing only): localStorage.
 */
const PREFIX = 'rg.';

export const secureStore = {
  async get(key: string): Promise<string | null> {
    try {
      if (IS_NATIVE) return (await SecureStorage.getItem(PREFIX + key)) ?? null;
      return window.localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    try {
      if (IS_NATIVE) await SecureStorage.setItem(PREFIX + key, value);
      else window.localStorage.setItem(PREFIX + key, value);
    } catch {
      /* storage unavailable — the app still works for this session */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      if (IS_NATIVE) await SecureStorage.removeItem(PREFIX + key);
      else window.localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};
