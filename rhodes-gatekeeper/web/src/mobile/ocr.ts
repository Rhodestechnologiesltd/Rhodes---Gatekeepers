import { CapacitorPluginMlKitTextRecognition } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';
import { IS_NATIVE } from '../lib/platform';

/**
 * Text recognition on the tablet.
 *  - Android / iOS app: Google ML Kit, fully on-device (images are not sent to any OCR service).
 *  - Browser (demo/testing): Tesseract.js running locally in the page, assets served from /ocr/.
 * Returns plain text with one line per detected line. The server turns it into suggested fields.
 */
type Worker = { recognize: (img: string) => Promise<{ data: { text: string } }> };
let tesseract: Promise<Worker> | null = null;

async function browserWorker(): Promise<Worker> {
  if (!tesseract) {
    tesseract = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = `${window.location.origin}/ocr`;
      return (await createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: `${base}/core`,
        langPath: `${base}/lang`,
        gzip: true,
      })) as unknown as Worker;
    })();
  }
  return tesseract;
}

export async function recognizeText(jpegBase64: string): Promise<string> {
  if (IS_NATIVE) {
    const r = await CapacitorPluginMlKitTextRecognition.detectText({ base64Image: jpegBase64 });
    // Rebuild text line by line (ML Kit groups into blocks), which suits the MRZ and label: value layouts.
    const lines = r.blocks.flatMap((b) => b.lines.map((l) => l.text));
    return lines.length ? lines.join('\n') : r.text;
  }
  const w = await browserWorker();
  const { data } = await w.recognize(`data:image/jpeg;base64,${jpegBase64}`);
  return data.text;
}

/** Warm up the browser engine while the guard is still choosing a visit type. */
export function preloadOcr() {
  if (!IS_NATIVE) void browserWorker().catch(() => undefined);
}
