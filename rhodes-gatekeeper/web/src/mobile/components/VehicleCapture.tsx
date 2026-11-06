import { useState } from 'react';
import { api, uuid } from '../../lib/api';
import type { PlateSuggestion } from '../../lib/types';
import { Alert, Button, Card, Select, TextInput } from '../../components/ui';
import { pickDocument, takePhoto, type Photo } from '../camera';
import { recognizeText } from '../ocr';
import { PhotoSlot } from './PhotoSlot';
import { IS_NATIVE } from '../../lib/platform';

export interface DocDraft { key: string; kind: 'po' | 'invoice' | 'document'; number: string; photo: Photo; ocrText: string }
export interface VehicleDraft {
  plate: string;
  platePhotos: Photo[];
  direction: 'delivery' | 'collection';
  docs: DocDraft[];
}
export const emptyVehicle = (): VehicleDraft => ({ plate: '', platePhotos: [], direction: 'delivery', docs: [] });

export function VehicleCapture({ v, onChange, isDelivery, requirePlatePhoto, requireDocument, errors }: {
  v: VehicleDraft;
  onChange: (v: VehicleDraft) => void;
  isDelivery: boolean;
  requirePlatePhoto: boolean;
  requireDocument: boolean;
  errors: Record<string, string>;
}) {
  const [readingPlate, setReadingPlate] = useState(false);
  const [readingDoc, setReadingDoc] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PlateSuggestion[]>([]);
  const [error, setError] = useState('');

  const addPlatePhoto = async () => {
    setError('');
    const photo = await takePhoto().catch((e) => { setError(String(e?.message ?? e)); return null; });
    if (!photo) return;
    const next = { ...v, platePhotos: [...v.platePhotos, photo] };
    onChange(next);
    setReadingPlate(true);
    try {
      const text = await recognizeText(photo.base64);
      const r = await api<{ suggestions: PlateSuggestion[] }>('/scan/parse-plate', { body: { text } });
      setSuggestions(r.suggestions);
      if (!next.plate && r.suggestions[0]) onChange({ ...next, plate: r.suggestions[0].plate });
    } catch {
      setError('Could not read the plate automatically — type it below.');
    } finally {
      setReadingPlate(false);
    }
  };

  const addDoc = async (kind: DocDraft['kind'], fromFile = false) => {
    setError('');
    const photo = await (fromFile ? pickDocument() : takePhoto()).catch((e) => { setError(String(e?.message ?? e)); return null; });
    if (!photo) return;
    const key = uuid();
    const doc: DocDraft = { key, kind, number: '', photo, ocrText: '' };
    const docs = [...v.docs, doc];
    onChange({ ...v, docs });
    if (photo.mime !== 'image/jpeg') return;
    setReadingDoc(key);
    try {
      const text = await recognizeText(photo.base64);
      const r = await api<{ poNumber?: string; invoiceNumber?: string; kind?: 'po' | 'invoice' }>('/scan/parse-document', { body: { text } });
      const number = kind === 'invoice' ? r.invoiceNumber ?? r.poNumber : r.poNumber ?? r.invoiceNumber;
      onChange({ ...v, docs: docs.map((d) => (d.key === key ? { ...d, ocrText: text.slice(0, 20000), number: number ?? '' } : d)) });
    } catch {
      /* number can be typed */
    } finally {
      setReadingDoc(null);
    }
  };

  const updateDoc = (key: string, patch: Partial<DocDraft>) => onChange({ ...v, docs: v.docs.map((d) => (d.key === key ? { ...d, ...patch } : d)) });

  return (
    <div className="stack">
      <Card title="Vehicle">
        <div className="stack">
          {isDelivery && (
            <div className="segmented" role="radiogroup" aria-label="Delivery or collection">
              {(['delivery', 'collection'] as const).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={v.direction === d} className={v.direction === d ? 'on' : ''} onClick={() => onChange({ ...v, direction: d })}>
                  {d === 'delivery' ? 'Delivering goods' : 'Collecting goods'}
                </button>
              ))}
            </div>
          )}
          <div className="photo-grid">
            {v.platePhotos.map((ph, i) => (
              <PhotoSlot key={i} label={`Number plate ${i + 1}`} photo={ph} busy={readingPlate && i === v.platePhotos.length - 1}
                onTake={() => void addPlatePhoto()} onRemove={() => onChange({ ...v, platePhotos: v.platePhotos.filter((_, j) => j !== i) })} />
            ))}
            {v.platePhotos.length < 3 && (
              <PhotoSlot label={v.platePhotos.length ? 'Another plate photo (optional)' : 'Number plate'} hint="Photograph the number plate" busy={readingPlate && !v.platePhotos.length}
                onTake={() => void addPlatePhoto()} required={requirePlatePhoto && !v.platePhotos.length} />
            )}
          </div>
          {errors.platePhoto && <div className="error-text">{errors.platePhoto}</div>}
          {suggestions.length > 0 && (
            <div className="row">
              <span className="muted small">Read from photo:</span>
              {suggestions.map((s) => (
                <button key={s.plate} type="button" className={`chip ${v.plate === s.plate ? 'on' : ''}`} onClick={() => onChange({ ...v, plate: s.plate })}>{s.plate}</button>
              ))}
            </div>
          )}
          <TextInput label="Number plate" value={v.plate} onChange={(x) => onChange({ ...v, plate: x.toUpperCase() })} required={isDelivery}
            error={errors.vehiclePlate} hint="Emirate, code and number — e.g. DUBAI A 12345" autoComplete="off" autoCapitalize="characters" />
        </div>
      </Card>

      <Card title={isDelivery ? 'Purchase order / invoice' : 'Documents (optional)'}>
        <div className="stack">
          {v.docs.map((d) => (
            <div key={d.key} className="doc-row">
              <PhotoSlot label={d.kind === 'po' ? 'Purchase order' : d.kind === 'invoice' ? 'Invoice' : 'Document'} photo={d.photo} busy={readingDoc === d.key}
                onTake={() => undefined} onRemove={() => onChange({ ...v, docs: v.docs.filter((x) => x.key !== d.key) })} />
              <div className="stack" style={{ flex: 1 }}>
                <Select label="Type" value={d.kind} onChange={(k) => updateDoc(d.key, { kind: k as DocDraft['kind'] })}
                  options={[{ value: 'po', label: 'Purchase order' }, { value: 'invoice', label: 'Invoice / delivery note' }, { value: 'document', label: 'Other document' }]} />
                <TextInput label={d.kind === 'invoice' ? 'Invoice number' : d.kind === 'po' ? 'PO number' : 'Reference'} value={d.number}
                  onChange={(x) => updateDoc(d.key, { number: x.toUpperCase() })} hint={readingDoc === d.key ? 'Reading…' : d.number ? 'Check the number read from the photo' : undefined} />
              </div>
            </div>
          ))}
          {errors.documents && <div className="error-text">{errors.documents}</div>}
          <div className="row">
            <Button onClick={() => void addDoc('po')}>+ Photograph PO</Button>
            <Button onClick={() => void addDoc('invoice')}>+ Photograph invoice</Button>
            <Button variant="ghost" onClick={() => void addDoc('document')}>+ Other document</Button>
            {!IS_NATIVE && <Button variant="ghost" onClick={() => void addDoc('invoice', true)}>Choose PDF…</Button>}
          </div>
          {requireDocument && isDelivery && <p className="note">At least one PO or invoice is required for deliveries and collections.</p>}
        </div>
      </Card>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
