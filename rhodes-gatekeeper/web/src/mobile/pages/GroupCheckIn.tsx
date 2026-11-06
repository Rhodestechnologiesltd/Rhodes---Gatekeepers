import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, uuid } from '../../lib/api';
import { dateTime, groupRef, visitorId, VISIT_TYPE_LONG } from '../../lib/format';
import type { Department, Employee, Group, Visit, VisitType } from '../../lib/types';
import { Alert, Badge, Button, Card, Select, TextArea, TextInput, useAsync } from '../../components/ui';
import { EmployeePicker } from '../../components/EmployeePicker';
import { IconCheck, VISIT_TYPE_ICON } from '../../components/icons';
import { useSession } from '../session';
import { emptyPerson, PersonCapture, personProblems, type PersonDraft } from '../components/PersonCapture';
import { emptyVehicle, VehicleCapture, type VehicleDraft } from '../components/VehicleCapture';
import { enqueue, subscribeUploads, type UploadJob } from '../uploads';
import { preloadOcr } from '../ocr';

type Step = 'type' | 'people' | 'vehicle' | 'details' | 'confirm' | 'done';

const TYPE_DESC: Record<VisitType, string> = {
  meeting: 'One person or a group visiting staff',
  delivery: 'Truck or van delivering or collecting goods',
  customer: 'Buying or discussing products',
  other: 'Contractors, inspections, anything else',
};

interface Details { hostEmployeeId: string; hostName: string; departmentId: string; purpose: string; deliveryCompany: string; salesReference: string; notes: string }
const EMPTY_DETAILS: Details = { hostEmployeeId: '', hostName: '', departmentId: '', purpose: '', deliveryCompany: '', salesReference: '', notes: '' };

export function GroupCheckIn() {
  const { me } = useSession();
  const nav = useNavigate();
  const capture = me!.app.capture;
  const requireId = me!.app.requireIdDocument;
  const privacy = me!.app.privacyNotice;

  const [step, setStep] = useState<Step>('type');
  const [visitType, setVisitType] = useState<VisitType>('meeting');
  const [people, setPeople] = useState<PersonDraft[]>([]);
  const [editing, setEditing] = useState<PersonDraft | null>(null);
  const [vehicle, setVehicle] = useState<VehicleDraft>(emptyVehicle());
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [privacyAck, setPrivacyAck] = useState(false);
  const [idemKey, setIdemKey] = useState(uuid);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ group: Group; visits: Visit[]; warnings: string[]; jobIds: string[] } | null>(null);

  const employees = useAsync(() => api<Employee[]>('/directory/employees'), []);
  const departments = useAsync(() => api<Department[]>('/directory/departments'), []);
  useEffect(() => preloadOcr(), []);

  const isDelivery = visitType === 'delivery';
  const roleFor = (i: number): PersonDraft['role'] => (isDelivery ? (i === 0 ? 'driver' : 'helper') : 'visitor');
  const setD = (k: keyof Details) => (v: string) => setDetails((d) => ({ ...d, [k]: v }));

  const steps: [Step, string][] = isDelivery
    ? [['type', 'Type'], ['people', 'Driver & helpers'], ['vehicle', 'Vehicle & PO'], ['details', 'Details'], ['confirm', 'Confirm']]
    : [['type', 'Type'], ['people', 'Visitors'], ['details', 'Details'], ['vehicle', 'Vehicle'], ['confirm', 'Confirm']];
  const order = steps.map(([s]) => s);
  const next = () => setStep(order[order.indexOf(step) + 1] ?? 'confirm');
  const back = () => setStep(order[order.indexOf(step) - 1] ?? 'type');

  const peopleOk = people.length > 0 && people.every((p) => personProblems(p, capture, requireId).length === 0);

  const validateVehicle = (): boolean => {
    const e: Record<string, string> = {};
    if (isDelivery && !vehicle.plate.trim()) e.vehiclePlate = 'Number plate is required';
    if (isDelivery && capture.requirePlatePhotoForDelivery && !vehicle.platePhotos.length) e.platePhoto = 'Take a photo of the number plate';
    if (isDelivery && capture.requireDocumentForDelivery && !vehicle.docs.some((d) => d.kind === 'po' || d.kind === 'invoice')) e.documents = 'Photograph the purchase order or invoice';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const validateDetails = (): boolean => {
    const e: Record<string, string> = {};
    const hasHost = !!(details.hostEmployeeId || details.hostName);
    if (visitType === 'meeting') {
      if (!hasHost) e.hostEmployeeId = 'Select the employee being visited';
      if (!details.purpose.trim()) e.purpose = 'Purpose is required';
    }
    if (isDelivery) {
      if (!details.deliveryCompany.trim()) e.deliveryCompany = 'Delivery company is required';
      if (!details.purpose.trim()) e.purpose = 'Describe the goods';
      if (!hasHost && !details.departmentId) e.departmentId = 'Select the receiving department or employee';
    }
    if (visitType === 'other' && !details.purpose.trim()) e.purpose = 'Describe the reason for the visit';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const firstDoc = (k: 'po' | 'invoice') => vehicle.docs.find((d) => d.kind === k && d.number.trim())?.number.trim();

  const submit = async () => {
    setSubmitting(true);
    setBanner('');
    setErrors({});
    const body = {
      idempotencyKey: idemKey,
      visitType,
      direction: isDelivery ? vehicle.direction : undefined,
      visitors: people.map((p, i) => ({
        role: roleFor(i),
        fullName: p.fullName, company: p.company || (isDelivery ? details.deliveryCompany : ''), phone: p.phone, nationality: p.nationality,
        badgeNumber: p.badgeNumber,
        id: p.idStatus === 'not_provided' || p.docType === 'none'
          ? { documentType: 'none', status: 'not_provided' }
          : { documentType: p.docType, status: p.idStatus, method: p.idMethod || 'manual', number: p.idNumber, expiryDate: p.expiry },
      })),
      ...details,
      hostName: details.hostEmployeeId ? '' : details.hostName,
      deliveryCompany: isDelivery ? details.deliveryCompany : '',
      vehiclePlate: vehicle.plate,
      poNumber: firstDoc('po'),
      invoiceNumber: firstDoc('invoice'),
      privacyNoticeAck: privacyAck,
    };
    try {
      const r = await api<{ group: Group; visits: Visit[]; warnings: string[] }>('/visit-groups', { body });
      // Queue every photo/document for upload into the group's folder.
      const jobs: Omit<UploadJob, 'attempts' | 'createdAt'>[] = [];
      people.forEach((p, i) => {
        const v = r.visits[i];
        if (!capture.storeIdImages || p.idStatus === 'not_provided') return;
        if (p.front) jobs.push({ id: uuid(), groupId: r.group.id, label: `${visitorId(v.referenceNo)} ID front`, body: { kind: 'id_front', visitId: v.id, dataBase64: p.front.base64 } });
        if (p.back) jobs.push({ id: uuid(), groupId: r.group.id, label: `${visitorId(v.referenceNo)} ID back`, body: { kind: 'id_back', visitId: v.id, dataBase64: p.back.base64 } });
      });
      vehicle.platePhotos.forEach((ph, i) => jobs.push({ id: uuid(), groupId: r.group.id, label: `Number plate ${i + 1}`, body: { kind: 'plate', dataBase64: ph.base64 } }));
      vehicle.docs.forEach((d) => jobs.push({
        id: uuid(), groupId: r.group.id, label: d.kind === 'po' ? `PO ${d.number}` : d.kind === 'invoice' ? `Invoice ${d.number}` : 'Document',
        body: { kind: d.kind, dataBase64: d.photo.base64, docNumber: d.number || undefined, ocrText: d.ocrText || undefined },
      }));
      await enqueue(jobs);
      setResult({ ...r, jobIds: jobs.map((j) => j.id) });
      setStep('done');
      window.scrollTo({ top: 0 });
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.fields);
      if (err.code === 'ALREADY_ON_SITE') {
        const idx = Number(err.details?.visitorIndex ?? 0);
        setBanner(`${err.message}. Open that person and check out their previous visit (V${err.details?.referenceNo}) first.`);
        setPeople((ps) => ps.map((p, i) => (i === idx ? { ...p, onSite: { id: String(err.details?.visitId), referenceNo: Number(err.details?.referenceNo), checkedInAt: '' } } : p)));
        setStep('people');
      } else {
        setBanner(err.message + (Object.keys(err.fields).length ? ` — ${Object.values(err.fields).join('; ')}` : ''));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep('type'); setPeople([]); setEditing(null); setVehicle(emptyVehicle()); setDetails(EMPTY_DETAILS);
    setPrivacyAck(false); setIdemKey(uuid()); setErrors({}); setBanner(''); setResult(null);
  };

  const deptOptions = useMemo(() => (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })), [departments.data]);
  const idx = order.indexOf(step);

  // ------------------------------------------------------------------ person editor takes the whole screen
  if (editing) {
    const i = people.findIndex((p) => p.key === editing.key);
    const n = i === -1 ? people.length : i;
    return (
      <PersonCapture
        initial={editing}
        title={isDelivery ? (n === 0 ? 'Driver' : `Helper ${n}`) : `Visitor ${n + 1}`}
        capture={capture}
        requireId={requireId}
        onCancel={() => setEditing(null)}
        onSave={(p) => {
          setPeople((ps) => (i === -1 ? [...ps, p] : ps.map((x) => (x.key === p.key ? p : x))));
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>New check-in</h1><p>{step === 'type' ? 'What is the reason for the visit?' : VISIT_TYPE_LONG[visitType]}</p></div>
        {step !== 'done' && <Button variant="ghost" onClick={() => nav('/')}>Cancel</Button>}
      </div>
      {step !== 'done' && (
        <ol className="steps" aria-label="Progress">
          {steps.map(([s, label], i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>{label}</li>)}
        </ol>
      )}
      {banner && <div style={{ marginBottom: 16 }}><Alert tone="error">{banner}</Alert></div>}

      {step === 'type' && (
        <div className="type-grid">
          {me!.app.visitTypes.map((t) => {
            const Icon = VISIT_TYPE_ICON[t.value];
            return (
              <button key={t.value} className="type-card" onClick={() => { setVisitType(t.value); setStep('people'); setEditing(emptyPerson(t.value === 'delivery' ? 'driver' : 'visitor')); }}>
                <span className="icon"><Icon /></span>
                <span><strong>{t.label}</strong><span className="desc">{TYPE_DESC[t.value]}</span></span>
              </button>
            );
          })}
        </div>
      )}

      {step === 'people' && (
        <div className="stack">
          {people.length === 0 && <Alert tone="info">Add the first {isDelivery ? 'person (the driver)' : 'visitor'} by photographing their Emirates ID.</Alert>}
          <div className="people-list">
            {people.map((p, i) => {
              const problems = personProblems(p, capture, requireId);
              return (
                <div key={p.key} className={`person-row ${problems.length ? 'incomplete' : ''}`}>
                  <div className="person-thumbs">
                    {p.front ? <img src={p.front.dataUrl} alt="" /> : <span className="thumb-empty">front</span>}
                    {p.back ? <img src={p.back.dataUrl} alt="" /> : <span className="thumb-empty">back</span>}
                  </div>
                  <div className="person-info">
                    <strong>{p.fullName || 'Unnamed'}</strong>
                    <span className="muted small">
                      {roleFor(i) === 'driver' ? 'Driver · ' : roleFor(i) === 'helper' ? 'Helper · ' : ''}
                      {p.idNumber ? `ID …${p.idNumber.replace(/\D/g, '').slice(-4)}` : 'No ID'}{p.badgeNumber ? ` · Pass ${p.badgeNumber}` : ''}
                    </span>
                    {problems.length > 0 && <span className="error-text">Missing: {problems.join(', ')}</span>}
                    {p.onSite && <Badge tone="amber">Already on site</Badge>}
                  </div>
                  <div className="row">
                    <Button size="sm" onClick={() => setEditing(p)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPeople((ps) => ps.filter((x) => x.key !== p.key))} aria-label={`Remove ${p.fullName}`}>Remove</Button>
                  </div>
                </div>
              );
            })}
          </div>
          {people.length < capture.maxGroupSize && (
            <Button size="lg" onClick={() => setEditing(emptyPerson(roleFor(people.length), people[0]?.company ?? ''))}>
              + Add {people.length === 0 ? (isDelivery ? 'driver' : 'visitor') : isDelivery ? 'helper' : 'another visitor'}
            </Button>
          )}
          <div className="sticky-actions">
            <Button variant="ghost" onClick={back}>← Back</Button>
            <Button variant="primary" size="lg" disabled={!peopleOk} onClick={next}>
              Continue with {people.length} {people.length === 1 ? 'person' : 'people'}
            </Button>
          </div>
        </div>
      )}

      {step === 'vehicle' && (
        <div className="stack">
          {!isDelivery && <Alert tone="info">Optional: record the visitor's car number plate.</Alert>}
          <VehicleCapture v={vehicle} onChange={setVehicle} isDelivery={isDelivery}
            requirePlatePhoto={isDelivery && capture.requirePlatePhotoForDelivery} requireDocument={capture.requireDocumentForDelivery} errors={errors} />
          <div className="sticky-actions">
            <Button variant="ghost" onClick={back}>← Back</Button>
            <Button variant="primary" size="lg" onClick={() => validateVehicle() && next()}>{!isDelivery && !vehicle.plate ? 'Skip' : 'Continue'}</Button>
          </div>
        </div>
      )}

      {step === 'details' && (
        <div className="stack">
          <Card title="Visit details">
            <div className="form-grid">
              {isDelivery && <TextInput label="Delivery company" value={details.deliveryCompany} onChange={setD('deliveryCompany')} error={errors.deliveryCompany} required />}
              {isDelivery && <TextInput label={vehicle.direction === 'collection' ? 'Goods being collected' : 'Goods being delivered'} value={details.purpose} onChange={setD('purpose')} error={errors.purpose} required />}
              {isDelivery && <Select label="Receiving department" value={details.departmentId} onChange={setD('departmentId')} options={deptOptions} placeholder="Select department" error={errors.departmentId} />}
              {visitType === 'customer' && <TextInput label="Sales / order reference (optional)" value={details.salesReference} onChange={setD('salesReference')} />}
              {(visitType === 'meeting' || visitType === 'customer') && <TextInput label={visitType === 'meeting' ? 'Purpose of visit' : 'Purpose (optional)'} value={details.purpose} onChange={setD('purpose')} error={errors.purpose} required={visitType === 'meeting'} />}
              {visitType === 'other' && <div className="span-2"><TextArea label="Reason for visit" value={details.purpose} onChange={setD('purpose')} error={errors.purpose} required rows={2} /></div>}
              <div className="span-2">
                <EmployeePicker
                  label={visitType === 'meeting' ? 'Employee being visited' : isDelivery ? 'Receiving employee (optional)' : 'Contact person (optional)'}
                  employees={employees.data ?? []} value={details.hostEmployeeId} freeText={details.hostName} required={visitType === 'meeting'} error={errors.hostEmployeeId}
                  onChange={({ employeeId, freeText }) => setDetails((d) => ({ ...d, hostEmployeeId: employeeId, hostName: freeText }))}
                />
              </div>
              <div className="span-2"><TextInput label="Notes" value={details.notes} onChange={setD('notes')} /></div>
            </div>
          </Card>
          <div className="sticky-actions">
            <Button variant="ghost" onClick={back}>← Back</Button>
            <Button variant="primary" size="lg" onClick={() => validateDetails() && next()}>Continue</Button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="stack">
          <Card title="Check before saving">
            <dl className="details">
              <dt>Visit</dt><dd>{VISIT_TYPE_LONG[visitType]}{isDelivery ? ` · ${vehicle.direction === 'collection' ? 'collecting' : 'delivering'}` : ''}</dd>
              <dt>People</dt><dd>{people.map((p, i) => `${p.fullName}${isDelivery ? (i === 0 ? ' (driver)' : ' (helper)') : ''}`).join(', ')}</dd>
              {vehicle.plate && <><dt>Vehicle</dt><dd>{vehicle.plate}</dd></>}
              {vehicle.docs.length > 0 && <><dt>Documents</dt><dd>{vehicle.docs.map((d) => `${d.kind === 'po' ? 'PO' : d.kind === 'invoice' ? 'Invoice' : 'Doc'}${d.number ? ` ${d.number}` : ''}`).join(', ')}</dd></>}
              {(details.hostEmployeeId || details.hostName) && <><dt>Visiting</dt><dd>{employees.data?.find((e) => e.id === details.hostEmployeeId)?.fullName ?? details.hostName}</dd></>}
              {details.purpose && <><dt>Purpose</dt><dd>{details.purpose}</dd></>}
              <dt>Photos to save</dt><dd>{people.reduce((n, p) => n + (capture.storeIdImages && p.idStatus !== 'not_provided' ? (p.front ? 1 : 0) + (p.back ? 1 : 0) : 0), 0) + vehicle.platePhotos.length + vehicle.docs.length}</dd>
            </dl>
          </Card>
          {privacy.enabled && (
            <Card title="Privacy notice">
              <div className="stack">
                <div className="privacy-text">{privacy.text}</div>
                <label className={`checkbox-big ${privacyAck ? 'checked' : ''}`}>
                  <input type="checkbox" checked={privacyAck} onChange={(e) => setPrivacyAck(e.target.checked)} />
                  <span><strong>{people.length > 1 ? 'Everyone in the group has' : 'The visitor has'} been shown the privacy notice</strong>{privacy.requireAcknowledgement && <span className="req"> *</span>}</span>
                </label>
              </div>
            </Card>
          )}
          <div className="sticky-actions">
            <Button variant="ghost" onClick={back}>← Back</Button>
            <Button variant="primary" size="lg" busy={submitting} disabled={privacy.enabled && privacy.requireAcknowledgement && !privacyAck} onClick={() => void submit()}>
              Check in {people.length > 1 ? `${people.length} people` : 'visitor'}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && result && <Done result={result} onNext={reset} onHome={() => nav('/')} />}
    </div>
  );
}

function Done({ result, onNext, onHome }: { result: { group: Group; visits: Visit[]; warnings: string[]; jobIds: string[] }; onNext: () => void; onHome: () => void }) {
  const [state, setState] = useState<{ done: Set<string>; pending: number }>({ done: new Set(), pending: 0 });
  useEffect(() => subscribeUploads((s) => setState({ done: new Set(s.done), pending: s.pending })), []);
  const total = result.jobIds.length;
  const uploaded = result.jobIds.filter((id) => state.done.has(id)).length;
  return (
    <Card>
      <div className="done-panel">
        <div className="done-check"><IconCheck /></div>
        <h1>{result.visits.length > 1 ? `${result.visits.length} people checked in` : `${result.visits[0].visitor.fullName} is checked in`}</h1>
        <div className="muted">{VISIT_TYPE_LONG[result.group.visitType]}{result.group.vehiclePlate ? ` · ${result.group.vehiclePlate}` : ''} · {dateTime(result.group.checkedInAt)}</div>
        <table className="data" style={{ maxWidth: 560, margin: '8px auto', textAlign: 'left' }}>
          <thead><tr><th>Visitor ID</th><th>Name</th><th>Pass</th></tr></thead>
          <tbody>
            {result.visits.map((v) => (
              <tr key={v.id}>
                <td className="mono" style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--teal)' }}>{visitorId(v.referenceNo)}</td>
                <td>{v.visitor.fullName}{v.group?.role !== 'visitor' && <span className="muted small"> · {v.group?.role}</span>}</td>
                <td>{v.badgeNumber ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Group {groupRef(result.group.groupNo)} · Folder <span className="mono">{result.group.folderName}</span></div>
        {total > 0 && (
          uploaded === total
            ? <Alert tone="success">All {total} photos and documents saved to the folder.</Alert>
            : <Alert tone="info">Saving photos: {uploaded} of {total}… You can continue — uploads finish in the background.</Alert>
        )}
        {result.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <Button variant="primary" size="lg" onClick={onNext}>Next check-in</Button>
          <Button size="lg" onClick={onHome}>Back to gate</Button>
        </div>
      </div>
    </Card>
  );
}
