import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { bytes, dateTime, FILE_KIND_LABEL, groupRef, minutes, time, todayLocal, visitorId, VISIT_TYPE_LONG } from '../lib/format';
import type { Group, StoredFile, Visit } from '../lib/types';
import { Alert, Badge, Button, Card, Empty, Modal, Select, Spinner, TextInput, useAsync } from '../components/ui';
import { FolderCard } from './Search';
import { IconFile, IconId, IconImage, IconLock } from '../components/icons';

const PAGE = 60;

export function FoldersPage() {
  const [f, setF] = useState({ q: '', type: '', from: todayLocal(-30), to: todayLocal() });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const list = useAsync(() => api<{ items: Group[]; total: number }>(`/folders${qs({ ...applied, limit: PAGE, offset })}`), [applied, offset]);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Folders</h1><p>Each check-in has a folder: visitors are named after the lead visitor, vehicles after the number plate, with date and time.</p></div></div>
      <Card>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(f); }}>
          <div className="field grow"><label htmlFor="fq">Search folders</label><input id="fq" className="search" type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Name, plate, PO / invoice number, company" /></div>
          <Select label="Show" value={f.type} onChange={(v) => setF({ ...f, type: v })} placeholder="All folders" options={[{ value: 'visitors', label: 'Visitors' }, { value: 'vehicles', label: 'Vehicles' }]} />
          <TextInput label="From" type="date" value={f.from} onChange={(v) => setF({ ...f, from: v })} />
          <TextInput label="To" type="date" value={f.to} onChange={(v) => setF({ ...f, to: v })} />
          <Button variant="brand" type="submit">Apply</Button>
        </form>
      </Card>
      {list.error && <Alert tone="error">{list.error.message}</Alert>}
      {list.loading && !list.data ? <Spinner /> : !list.data?.items.length ? <Empty title="No folders in this period" /> : (
        <>
          <div className="folder-grid">{list.data.items.map((g) => <FolderCard key={g.id} f={g} />)}</div>
          <div className="pager">
            <span className="muted">{offset + 1}–{offset + list.data.items.length} of {list.data.total}</span>
            <div className="row">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button size="sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface FolderData { group: Group; files: StoredFile[]; visits: Visit[]; canViewIdImages: boolean; canDownload: boolean }

export function FolderPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const d = useAsync(() => api<FolderData>(`/folders/${id}`), [id]);
  const [preview, setPreview] = useState<StoredFile | null>(null);
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <Alert tone="error">{d.error.message}</Alert>;
  const { group: g, files, visits, canViewIdImages, canDownload } = d.data!;
  const byVisit = (vid: string) => files.filter((f) => f.visitId === vid);
  const other = files.filter((f) => !f.visitId);
  const content = (f: StoredFile, download = false) => `/api/files/${f.id}/content${download ? '?download=1' : ''}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="muted small"><Link to="/folders">Folders</Link> / {g.folderPath.split('/').slice(0, -1).join(' / ')}</div>
          <h1 className="mono" style={{ fontSize: '1.35rem', overflowWrap: 'anywhere' }}>{g.folderName}</h1>
          <p>{VISIT_TYPE_LONG[g.visitType]}{g.direction ? ` · ${g.direction}` : ''} · {dateTime(g.checkedInAt)} · {groupRef(g.groupNo)}</p>
        </div>
        {canDownload && <a className="btn btn-primary" href={`/api/folders/${g.id}/download.zip`}>Download folder (.zip)</a>}
      </div>
      {g.purged && <Alert tone="info">Personal data in this folder was removed under the retention policy.</Alert>}
      {me && me.app.sharepointEnabled && <p className="muted small">Also copied to SharePoint: <span className="mono">{g.folderPath}</span></p>}

      <div className="grid grid-2">
        <Card title="Visit">
          <dl className="details">
            {g.vehiclePlate && <><dt>Vehicle</dt><dd><span className="plate">{g.vehiclePlate}</span></dd></>}
            {g.deliveryCompany && <><dt>Company</dt><dd>{g.deliveryCompany}</dd></>}
            {g.poNumber && <><dt>PO number</dt><dd className="mono">{g.poNumber}</dd></>}
            {g.invoiceNumber && <><dt>Invoice number</dt><dd className="mono">{g.invoiceNumber}</dd></>}
            <dt>{g.visitType === 'delivery' ? 'Receiving' : 'Host'}</dt><dd>{g.host?.name ?? g.department?.name ?? '—'}</dd>
            {g.purpose && <><dt>Purpose</dt><dd>{g.purpose}</dd></>}
            <dt>Checked in by</dt><dd>{g.checkedInBy ?? '—'}</dd>
          </dl>
        </Card>
        <Card title={`People (${visits.length})`}>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Visitor ID</th><th>Name</th><th>In / out</th><th className="num">Duration</th></tr></thead>
            <tbody>{visits.map((v) => (
              <tr key={v.id}>
                <td className="mono">{visitorId(v.referenceNo)}</td>
                <td><strong>{v.visitor.fullName}</strong>{v.group?.role !== 'visitor' && <span className="muted small"> · {v.group?.role}</span>}<div className="muted small mono">{v.visitor.idNumberMasked ?? 'No ID'}{v.badgeNumber ? ` · pass ${v.badgeNumber}` : ''}</div></td>
                <td className="nowrap small">{time(v.checkedInAt)} – {v.checkedOutAt ? time(v.checkedOutAt) : <Badge tone="red">on site</Badge>}</td>
                <td className="num">{minutes(v.durationMinutes)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      </div>

      <Card title={`Files (${files.length})`}>
        {!files.length ? <Empty title="No files in this folder" /> : (
          <div className="stack">
            {visits.filter((v) => byVisit(v.id).length).map((v) => (
              <div key={v.id}>
                <h3 className="section-title">{visitorId(v.referenceNo)} · {v.visitor.fullName}</h3>
                <div className="file-grid" style={{ marginTop: 10 }}>{byVisit(v.id).map((f) => <FileTile key={f.id} f={f} locked={f.isIdImage && !canViewIdImages} onOpen={() => setPreview(f)} src={content(f)} />)}</div>
              </div>
            ))}
            {other.length > 0 && (
              <div>
                <h3 className="section-title">Vehicle & documents</h3>
                <div className="file-grid" style={{ marginTop: 10 }}>{other.map((f) => <FileTile key={f.id} f={f} locked={false} onOpen={() => setPreview(f)} src={content(f)} />)}</div>
              </div>
            )}
            {!canViewIdImages && files.some((f) => f.isIdImage) && <p className="note">Identity-card images are visible to managers and administrators only.</p>}
          </div>
        )}
      </Card>

      {preview && (
        <Modal title={preview.fileName} onClose={() => setPreview(null)} wide
          footer={<><a className="btn" href={content(preview, true)}>Download</a><Button onClick={() => setPreview(null)}>Close</Button></>}>
          {preview.isIdImage && <Alert tone="warn">Identity document — this view has been recorded in the audit log.</Alert>}
          {preview.mime === 'application/pdf'
            ? <iframe title={preview.fileName} src={content(preview)} style={{ width: '100%', height: '70vh', border: 0, marginTop: 10 }} sandbox="" />
            : <img src={content(preview)} alt={preview.fileName} style={{ maxWidth: '100%', display: 'block', margin: '10px auto 0', borderRadius: 8 }} />}
          <p className="muted small">{FILE_KIND_LABEL[preview.kind]} · {bytes(preview.sizeBytes)} · saved {dateTime(preview.createdAt)}{preview.uploadedBy ? ` by ${preview.uploadedBy}` : ''}{preview.docNumber ? ` · ${preview.docNumber}` : ''}</p>
        </Modal>
      )}
    </div>
  );
}

function FileTile({ f, locked, onOpen, src }: { f: StoredFile; locked: boolean; onOpen: () => void; src: string }) {
  // ID images are never loaded as thumbnails (each view is audited); open them deliberately.
  const showThumb = !f.isIdImage && f.mime.startsWith('image/');
  return (
    <div className={`file-tile ${locked ? 'locked' : ''}`}>
      <button type="button" className="file-thumb" onClick={onOpen} disabled={locked} aria-label={locked ? `${f.fileName} (restricted)` : `Open ${f.fileName}`}>
        {showThumb ? <img src={src} alt="" loading="lazy" /> : <span className="file-icon">{locked ? <IconLock /> : f.isIdImage ? <IconId /> : f.mime === 'application/pdf' ? <IconFile /> : <IconImage />}</span>}
      </button>
      <div className="file-meta">
        <span className="mono small file-name" title={f.fileName}>{f.fileName}</span>
        <span className="muted small">{FILE_KIND_LABEL[f.kind]} · {bytes(f.sizeBytes)}{f.sharepoint === 'synced' ? ' · SharePoint ✓' : f.sharepoint === 'pending' ? ' · SharePoint…' : f.sharepoint === 'failed' ? ' · SharePoint failed' : ''}</span>
      </div>
    </div>
  );
}
