import type { Photo } from '../camera';
import { IconCamera } from '../../components/icons';

/** Big tap target that shows the captured photo, or a camera prompt. */
export function PhotoSlot({ label, hint, photo, busy, onTake, onRemove, required }: {
  label: string;
  hint?: string;
  photo?: Photo | null;
  busy?: boolean;
  onTake: () => void;
  onRemove?: () => void;
  required?: boolean;
}) {
  return (
    <div className={`photo-slot ${photo ? 'has-photo' : ''}`}>
      <button type="button" className="photo-slot-btn" onClick={onTake} disabled={busy} aria-label={photo ? `Retake: ${label}` : `Take photo: ${label}`}>
        {photo ? (
          photo.mime === 'application/pdf' ? <span className="pdf-chip">PDF</span> : <img src={photo.dataUrl} alt="" />
        ) : (
          <span className="photo-slot-empty"><IconCamera width={40} height={40} /><span>{hint ?? 'Tap to take photo'}</span></span>
        )}
        {busy && <span className="photo-slot-busy"><span className="spinner" /> Reading…</span>}
      </button>
      <div className="photo-slot-label">
        <span>{label}{required && <span className="req"> *</span>}</span>
        {photo && !busy && (
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onTake}>Retake</button>
            {onRemove && <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>}
          </span>
        )}
      </div>
    </div>
  );
}
