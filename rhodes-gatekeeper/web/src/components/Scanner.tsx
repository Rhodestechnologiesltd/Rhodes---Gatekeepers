import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from './ui';
import { IconCamera, IconId } from './icons';

/**
 * Scanner integration for the gate tablet.
 *
 *  - Camera: uses the browser's BarcodeDetector API (available in Chrome on Android). It reads barcode
 *    formats only (PDF417, QR, Code128, Code39, Data Matrix). It does NOT OCR the printed MRZ text.
 *  - Card reader: any reader that acts as a keyboard (USB/Bluetooth HID "keyboard wedge"), including MRZ
 *    document readers. Its output is typed into the capture box and submitted automatically.
 *
 * Both deliver a RAW string to the server, which parses only the fields that are actually present.
 * Which barcode/reader is used on site must be confirmed against real cards before go-live.
 */

type Method = 'camera_barcode' | 'hardware_reader';

interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string; format: string }[]> }
type BarcodeDetectorCtor = { new (opts?: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats(): Promise<string[]> };
const WANTED = ['pdf417', 'qr_code', 'code_128', 'code_39', 'data_matrix'];

export function Scanner({ onScan, busy }: { onScan: (raw: string, method: Method) => void; busy?: boolean }) {
  const hasDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  const [mode, setMode] = useState<'camera' | 'reader'>(hasDetector ? 'camera' : 'reader');

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Scan method">
        <button role="tab" aria-selected={mode === 'camera'} onClick={() => setMode('camera')}>Tablet camera</button>
        <button role="tab" aria-selected={mode === 'reader'} onClick={() => setMode('reader')}>Card reader</button>
      </div>
      {mode === 'camera' ? <CameraScan onScan={(raw) => onScan(raw, 'camera_barcode')} supported={hasDetector} busy={busy} /> : <ReaderCapture onScan={(raw) => onScan(raw, 'hardware_reader')} busy={busy} />}
    </div>
  );
}

function CameraScan({ onScan, supported, busy }: { onScan: (raw: string) => void; supported: boolean; busy?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const doneRef = useRef(false);

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stop, []);

  const start = async () => {
    setError('');
    setState('starting');
    doneRef.current = false;
    try {
      if (!window.isSecureContext) throw new Error('The camera needs a secure (HTTPS) connection.');
      const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const supportedFormats = await Ctor.getSupportedFormats();
      const formats = WANTED.filter((f) => supportedFormats.includes(f));
      if (!formats.length) throw new Error('This device cannot decode the required barcode formats.');
      const detector = new Ctor({ formats });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setState('running');
      const tick = async () => {
        if (doneRef.current || !streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          const hit = codes.find((c) => c.rawValue && c.rawValue.length >= 8);
          if (hit) {
            doneRef.current = true;
            navigator.vibrate?.(80);
            stop();
            setState('idle');
            onScan(hit.rawValue);
            return;
          }
        } catch { /* frame not ready */ }
        window.setTimeout(() => void tick(), 180);
      };
      void tick();
    } catch (e) {
      stop();
      setState('error');
      const err = e as DOMException;
      setError(err.name === 'NotAllowedError' ? 'Camera permission was refused. Allow camera access for this site in the browser settings.' : err.message || 'Could not start the camera.');
    }
  };

  if (!supported) {
    return (
      <Alert tone="warn" title="Camera scanning isn't available on this browser">
        Use Chrome on the Android tablet (over HTTPS), connect a card reader, or enter the details manually.
      </Alert>
    );
  }
  return (
    <div className="stack">
      <div className="camera-box">
        <video ref={videoRef} playsInline muted style={{ display: state === 'running' ? 'block' : 'none' }} />
        {state === 'running' && <div className="camera-frame" aria-hidden />}
        {state !== 'running' && (
          <div className="camera-msg">
            <IconCamera width={48} height={48} />
            <div>Hold the card's barcode inside the frame.</div>
            <Button variant="primary" size="lg" onClick={() => void start()} busy={state === 'starting' || busy}>Start camera</Button>
          </div>
        )}
      </div>
      {state === 'running' && <Button onClick={() => { doneRef.current = true; stop(); setState('idle'); }}>Stop camera</Button>}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

function ReaderCapture({ onScan, busy }: { onScan: (raw: string) => void; busy?: boolean }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { ref.current?.focus(); return () => window.clearTimeout(timer.current); }, []);

  const submit = (v = value) => {
    const raw = v.trim();
    if (raw.length < 8) return;
    onScan(raw);
    setValue('');
  };
  // Readers "type" very fast and may send several lines (MRZ) — submit after a short pause in input.
  const onChange = (v: string) => {
    setValue(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (v.trim().length >= 15) submit(v);
    }, 600);
  };

  return (
    <div className="stack wedge">
      <div className="row"><IconId width={36} height={36} color="var(--teal)" /><div>Tap the box below, then swipe or scan the card with the connected reader.</div></div>
      <div className="field">
        <label htmlFor="wedge">Reader input</label>
        <textarea id="wedge" ref={ref} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} placeholder="Waiting for card reader…" />
      </div>
      <Button onClick={() => submit()} disabled={value.trim().length < 8} busy={busy}>Use this scan</Button>
    </div>
  );
}
