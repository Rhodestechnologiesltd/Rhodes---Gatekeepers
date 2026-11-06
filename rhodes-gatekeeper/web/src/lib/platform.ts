import { Capacitor } from '@capacitor/core';

declare const __APP_TARGET__: 'web' | 'mobile';

/** Which app this bundle is: the office web app or the gate tablet app. */
export const APP_TARGET: 'web' | 'mobile' = __APP_TARGET__;
export const IS_MOBILE_APP = APP_TARGET === 'mobile';
/** True inside the installed Android / iOS app (camera + ML Kit OCR available). */
export const IS_NATIVE = Capacitor.isNativePlatform();
export const PLATFORM = Capacitor.getPlatform() as 'android' | 'ios' | 'web';
export const APP_VERSION = '2.0.0';
