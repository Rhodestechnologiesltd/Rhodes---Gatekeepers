import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Rhodes Gatekeeper — gate tablet app (Android + iOS).
 * Build the web bundle first:  npm run build:native   (VITE_TARGET=mobile, NATIVE=1 → dist-mobile/)
 * then:                       npx cap sync
 */
const config: CapacitorConfig = {
  appId: 'mu.rhodes.gatekeeper',
  appName: 'Rhodes Gatekeeper',
  webDir: 'dist-mobile',
  backgroundColor: '#003b4a',
  server: {
    // App pages are served locally from https://localhost (Android) / capacitor://localhost (iOS).
    androidScheme: 'https',
    // Production servers must use HTTPS. Only for development against a LAN server over plain HTTP:
    // cleartext: true,
    cleartext: true,
  },
  // android: { allowMixedContent: false },
  android: { allowMixedContent: true },
  ios: { contentInset: 'never' },
};

export default config;
