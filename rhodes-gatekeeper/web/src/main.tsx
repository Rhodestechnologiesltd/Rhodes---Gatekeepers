import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
declare const __APP_TARGET__: 'web' | 'mobile';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

// Each build loads only its own app: the gate tablet app, or the office web app.
// __APP_TARGET__ is replaced at build time, so the other app is left out of the bundle entirely.
if (__APP_TARGET__ === 'mobile') {
  void import('./mobile/MobileApp').then(({ MobileApp }) => root.render(<StrictMode><MobileApp /></StrictMode>));
} else {
  void import('./App').then(({ App }) => root.render(<StrictMode><App /></StrictMode>));
}
