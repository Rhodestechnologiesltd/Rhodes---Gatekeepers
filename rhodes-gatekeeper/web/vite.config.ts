import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * One codebase, two apps:
 *   VITE_TARGET=web     → office web app (reception, managers, admins)  → dist/
 *   VITE_TARGET=mobile  → gate tablet app (security guards, Capacitor)  → dist-mobile/
 *
 * On Android/iOS the tablet app uses Google ML Kit for OCR (on-device). When the tablet build is opened in
 * a normal browser (for demos/testing), it falls back to Tesseract.js, whose assets are served from /ocr/.
 * Native builds (NATIVE=1) leave those ~10 MB of browser-only assets out.
 */
const target = process.env.VITE_TARGET === 'mobile' ? 'mobile' : 'web';
const native = process.env.NATIVE === '1';

const OCR_FILES: Record<string, string> = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'core/tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'core/tesseract-core-relaxedsimd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'lang/eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};
const nm = (p: string) => path.resolve(__dirname, 'node_modules', p);

function browserOcrAssets(): Plugin {
  return {
    name: 'browser-ocr-assets',
    configureServer(server) {
      server.middlewares.use('/ocr', (req, res, next) => {
        const key = (req.url ?? '').replace(/^\//, '').split('?')[0];
        const src = OCR_FILES[key];
        if (!src) return next();
        res.setHeader('Content-Type', key.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        fs.createReadStream(nm(src)).pipe(res);
      });
    },
    generateBundle() {
      if (target !== 'mobile' || native) return;
      for (const [out, src] of Object.entries(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `ocr/${out}`, source: fs.readFileSync(nm(src)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), browserOcrAssets()],
  define: { __APP_TARGET__: JSON.stringify(target) },
  server: {
    host: true,
    port: target === 'mobile' ? 5174 : 5173,
    proxy: target === 'web' ? { '/api': { target: 'http://localhost:8080', changeOrigin: false } } : undefined,
  },
  build: { outDir: target === 'mobile' ? 'dist-mobile' : 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
