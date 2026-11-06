import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { IS_NATIVE } from '../lib/platform';

export interface Photo {
  /** JPEG, base64 without the data: prefix */
  base64: string;
  /** data URL for <img> previews */
  dataUrl: string;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'application/pdf';
}

const MAX_EDGE = 1800;

/** Resize/re-encode to JPEG so uploads stay ~200–500 KB and OCR has enough detail. */
async function normalise(dataUrl: string): Promise<Photo> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/jpeg', 0.85);
  return { dataUrl: out, base64: out.slice(out.indexOf(',') + 1), width: w, height: h, mime: 'image/jpeg' };
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    input.dataset.rgCapture = '1';
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.oncancel = () => {
      resolve(null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * Take a photo with the tablet camera. Returns null if the guard cancels.
 * In a desktop browser (testing), opens a file picker instead.
 */
export async function takePhoto(): Promise<Photo | null> {
  if (IS_NATIVE) {
    try {
      const p = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.DataUrl,
        quality: 85,
        width: MAX_EDGE,
        correctOrientation: true,
        allowEditing: false,
        saveToGallery: false, // never leave ID photos in the tablet's photo library
      });
      return p.dataUrl ? normalise(p.dataUrl) : null;
    } catch (e) {
      if (/cancel/i.test(String((e as Error)?.message))) return null;
      throw e;
    }
  }
  const f = await pickFile('image/*');
  return f ? normalise(await readAsDataUrl(f)) : null;
}

/** Documents may also be PDFs chosen from the device (e.g. an e-invoice). */
export async function pickDocument(): Promise<Photo | null> {
  const f = await pickFile('image/*,application/pdf');
  if (!f) return null;
  const dataUrl = await readAsDataUrl(f);
  if (f.type === 'application/pdf') return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: 0, height: 0, mime: 'application/pdf' };
  return normalise(dataUrl);
}
