import { useState } from 'react';
import { api, ApiError, uuid } from '../../lib/api';
import { time } from '../../lib/format';
import type { CaptureSettings, ParsedScan, ScanLookup } from '../../lib/types';
import { Alert, Badge, Button, Card, Select, TextInput, useToast } from '../../components/ui';
import { Scanner } from '../../components/Scanner';
import { takePhoto, type Photo } from '../camera';
import { recognizeText } from '../ocr';
import { PhotoSlot } from './PhotoSlot';

export type DocType = 'emirates_id' | 'passport' | 'other' | 'none';
export interface PersonDraft {
  key: string;
  role: 'visitor' | 'driver' | 'helper';
  fullName: string;
  company: string;
  phone: string;
  nationality: string;
  docType: DocType;
  idNumber: string;
  idStatus: 'scanned' | 'manual' | 'not_provided';
  idMethod: '' | 'camera_ocr' | 'camera_barcode' | 'hardware_reader' | 'manual';
  idLocked: boolean;
  expiry: string;
  badgeNumber: string;
  front: Photo | null;
  back: Photo | null;
  warnings: string[];
  onSite: ScanLookup['onSiteVisit'];
}

export const emptyPerson = (role: PersonDraft['role'], company = ''): PersonDraft => ({
  key: uuid(), role, fullName: '', company, phone: '', nationality: '', docType: 'emirates_id', idNumber: '',
  idStatus: 'not_provided', idMethod: '', idLocked: false, expiry: '', badgeNumber: '', front: null, back: null, warnings: [], onSite: null,
});

/** What is still missing for this person before the group can be checked in. */
export function personProblems(p: PersonDraft, capture: CaptureSettings, requireId: boolean): string[] {
  const out: string[] = [];
  if (!p.fullName.trim()) out.push('name');
  if (p.idStatus === 'not_provided' && requireId) out.push('ID');
  if (p.idStatus !== 'not_provided' && !p.idNumber.trim()) out.push('ID number');
  if (p.idStatus !== 'not_provided' && capture.storeIdImages && capture.requireIdImages) {
    if (!p.front) out.push('front photo');
    if (!p.back && p.docType === 'emirates_id') out.push('back photo');
  }
  return out;
}

export function PersonCapture({ initial, title, capture, requireId, onSave, onCancel }: {
  initial: PersonDraft;
  title: string;
  capture: CaptureSettings;
  requireId: boolean;
  onSave: (p: PersonDraft) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [p, setP] = useState<PersonDraft>(initial);
  const [texts, setTexts] = useState<{ front?: string; back?: string }>({});
  const [reading, setReading] = useState<'front' | 'back' | null>(null);
  const [error, setError] = useState('');
  const [showReader, setShowReader] = useState(false);
  const set = <K extends keyof PersonDraft>(k: K, v: PersonDraft[K]) => setP((s) => ({ ...s, [k]: v }));

  /** Merge a parse result into the form without overwriting what the guard has typed. */
  const apply = (parsed: ParsedScan, lookup: ScanLookup | null, method: PersonDraft['idMethod']) => {
    setP((s) => {
      const num = parsed.idNumber ?? (parsed.documentType === 'other' ? parsed.documentNumber : undefined);
      const trusted = !!num && (parsed.checksumsValid !== false);
      return {
        ...s,
        fullName: s.fullName || parsed.fullName || lookup?.previousVisitor?.fullName || '',
        company: s.company || lookup?.previousVisitor?.company || '',
        phone: s.phone || lookup?.previousVisitor?.phone || '',
        nationality: s.nationality || parsed.nationality || '',
        docType: parsed.idNumber ? 'emirates_id' : s.docType,
        idNumber: num ?? s.idNumber,
        idStatus: num ? 'scanned' : s.idStatus === 'not_provided' ? 'manual' : s.idStatus,
        idMethod: num ? method : s.idMethod || 'manual',
        idLocked: trusted,
        expiry: parsed.expiryDate ?? s.expiry,
        warnings: parsed.warnings,
        onSite: lookup?.onSiteVisit ?? null,
      };
    });
  };

  const capturePhoto = async (side: 'front' | 'back') => {
    setError('');
    let photo: Photo | null;
    try {
      photo = await takePhoto();
    } catch (e) {
      setError((e as Error).message || 'Camera not available');
      return;
    }
    if (!photo) return;
    setP((s) => ({ ...s, [side]: photo, idStatus: s.idStatus === 'not_provided' ? 'manual' : s.idStatus }));
    setReading(side);
    try {
      const text = await recognizeText(photo.base64);
      const next = { ...texts, [side]: text };
      setTexts(next);
      const r = await api<{ parsed: ParsedScan; lookup: ScanLookup | null }>('/scan/parse-ocr', { body: next });
      apply(r.parsed, r.lookup, 'camera_ocr');
    } catch (e) {
      setError(`Could not read the card automatically (${(e as Error).message}). Check the photo or type the details.`);
    } finally {
      setReading(null);
    }
  };

  const readerScan = async (raw: string, method: 'camera_barcode' | 'hardware_reader') => {
    try {
      const r = await api<{ parsed: ParsedScan; lookup: ScanLookup | null }>('/scan/parse', { body: { raw } });
      apply(r.parsed, r.lookup, method);
      setShowReader(false);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  const checkOutPrevious = async () => {
    if (!p.onSite) return;
    try {
      await api(`/visits/${p.onSite.id}/check-out`, { body: {} });
      toast(`Previous visit V${p.onSite.referenceNo} checked out`);
      set('onSite', null);
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const problems = personProblems(p, capture, requireId);
  const roleLabel = p.role === 'driver' ? 'Driver' : p.role === 'helper' ? 'Helper' : 'Visitor';

  return (
    <div className="stack">
      <div className="row-between">
        <h2 style={{ fontSize: '1.3rem' }}>{title}</h2>
        <Badge tone={p.idStatus === 'scanned' ? 'teal' : p.idStatus === 'manual' ? 'amber' : 'neutral'}>
          {p.idStatus === 'scanned' ? 'Read from card' : p.idStatus === 'manual' ? 'Typed by guard' : 'No ID yet'}
        </Badge>
      </div>

      <Card title="Identity card photos">
        <div className="photo-grid">
          <PhotoSlot label="Front of ID" hint="Photograph the FRONT" photo={p.front} busy={reading === 'front'} onTake={() => void capturePhoto('front')}
            onRemove={() => set('front', null)} required={capture.storeIdImages && capture.requireIdImages && p.idStatus !== 'not_provided'} />
          <PhotoSlot label="Back of ID" hint="Photograph the BACK (3 lines of text)" photo={p.back} busy={reading === 'back'} onTake={() => void capturePhoto('back')}
            onRemove={() => set('back', null)} required={capture.storeIdImages && capture.requireIdImages && p.docType === 'emirates_id' && p.idStatus !== 'not_provided'} />
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          Lay the card flat, fill the frame, avoid glare. The text is read on this tablet; check it below.
          {capture.storeIdImages ? ' The photos are saved in this visit\'s folder.' : ' Photos are used for reading only and are not saved.'}
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <Button variant="ghost" size="sm" onClick={() => setShowReader((x) => !x)}>{showReader ? 'Hide card reader' : 'Use a card reader / barcode instead'}</Button>
        </div>
        {showReader && <div style={{ marginTop: 12 }}><Scanner onScan={(raw, m) => void readerScan(raw, m)} /></div>}
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {p.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      {p.onSite && (
        <Alert tone="warn" title={`Already on site — V${p.onSite.referenceNo}`} action={<Button variant="danger" onClick={() => void checkOutPrevious()}>Check out previous</Button>}>
          This ID was checked in at {time(p.onSite.checkedInAt)} and has not checked out.
        </Alert>
      )}

      <Card title={`${roleLabel} details`}>
        <div className="form-grid">
          <TextInput label="Full name" value={p.fullName} onChange={(v) => set('fullName', v)} required autoComplete="off" />
          <TextInput label="Company" value={p.company} onChange={(v) => set('company', v)} autoComplete="off" />
          <Select label="Document" value={p.docType} onChange={(v) => setP((s) => ({ ...s, docType: v as DocType, idStatus: v === 'none' ? 'not_provided' : s.idStatus === 'not_provided' ? 'manual' : s.idStatus }))}
            options={[{ value: 'emirates_id', label: 'Emirates ID' }, { value: 'passport', label: 'Passport' }, { value: 'other', label: 'Other ID' }, ...(requireId ? [] : [{ value: 'none', label: 'No ID provided' }])]} />
          {p.docType !== 'none' && (
            <TextInput
              label="ID number" value={p.idNumber} readOnly={p.idLocked} required inputMode={p.docType === 'emirates_id' ? 'numeric' : 'text'} autoComplete="off"
              onChange={(v) => setP((s) => ({ ...s, idNumber: v, idStatus: 'manual', idMethod: s.idMethod || 'manual' }))}
              hint={p.idLocked ? <>Read from the card. <button type="button" className="btn btn-ghost btn-sm" onClick={() => setP((s) => ({ ...s, idLocked: false, idStatus: 'manual' }))}>Edit (marks as typed)</button></> : p.docType === 'emirates_id' ? '784-XXXX-XXXXXXX-X' : undefined}
            />
          )}
          {p.docType !== 'none' && <TextInput label="Card expiry" type="date" value={p.expiry} onChange={(v) => set('expiry', v)} />}
          <TextInput label="Nationality (code)" value={p.nationality} onChange={(v) => set('nationality', v.toUpperCase().slice(0, 3))} hint="e.g. ARE, IND" autoComplete="off" />
          <TextInput label="Mobile number" type="tel" inputMode="tel" value={p.phone} onChange={(v) => set('phone', v)} autoComplete="off" />
          <TextInput label="Visitor pass / badge no." value={p.badgeNumber} onChange={(v) => set('badgeNumber', v)} autoComplete="off" />
          {(p.role === 'driver' || p.role === 'helper') && (
            <Select label="Role" value={p.role} onChange={(v) => set('role', v as PersonDraft['role'])} options={[{ value: 'driver', label: 'Driver' }, { value: 'helper', label: 'Helper' }]} />
          )}
        </div>
        <p className="note" style={{ marginTop: 12 }}>Reading a card does not prove it is genuine — compare the photo on the card with the person.</p>
      </Card>

      <div className="sticky-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <div className="row">
          {problems.length > 0 && <span className="muted small">Missing: {problems.join(', ')}</span>}
          <Button variant="primary" size="lg" disabled={problems.length > 0 || !!reading} onClick={() => onSave(p)}>Save {roleLabel.toLowerCase()}</Button>
        </div>
      </div>
    </div>
  );
}
