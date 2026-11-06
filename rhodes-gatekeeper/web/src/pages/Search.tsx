import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dateTime, FILE_KIND_LABEL, groupRef, visitorId, VISIT_TYPE_LABEL } from '../lib/format';
import type { Group, VisitType } from '../lib/types';
import { Alert, Badge, Card, Empty, Spinner, useAsync } from '../components/ui';
import { IconFolder, IconTruck } from '../components/icons';

interface Result {
  query: string;
  visits: { id: string; referenceNo: number; visitType: VisitType; status: string; visitorName: string; company: string | null; idNumberMasked: string | null; hostName: string | null; badgeNumber: string | null; role: string | null; checkedInAt: string; groupId: string | null; groupNo: number | null; vehiclePlate: string | null; folderName: string | null }[];
  folders: Group[];
  files: { id: string; groupId: string; kind: string; isIdImage: boolean; fileName: string; docNumber: string | null; createdAt: string; folderName: string }[];
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const r = useAsync(() => (q.trim().length >= 2 ? api<Result>(`/search?q=${encodeURIComponent(q)}`) : Promise.resolve(null)), [q]);
  const d = r.data;

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Search</h1><p>Visitor name, Visitor ID (V1234), group (G1001), Emirates ID number, number plate, PO / invoice number, company or file name.</p></div></div>
      <form onSubmit={(e) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); }} className="row">
        <input className="search" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. DUBAI A 12345, 784-…, PO-45001234, V1262" aria-label="Search" style={{ flex: 1, fontSize: '1.1rem', minHeight: 56 }} autoFocus />
        <button className="btn btn-brand btn-lg" type="submit">Search</button>
      </form>
      {r.error && <Alert tone="error">{r.error.message}</Alert>}
      {r.loading && q ? <Spinner /> : !d ? null : !d.visits.length && !d.folders.length && !d.files.length ? (
        <Empty title={`Nothing found for “${d.query}”`}>Try fewer characters, or the last digits of a plate or PO number.</Empty>
      ) : (
        <>
          {d.folders.length > 0 && (
            <Card title={`Folders (${d.folders.length})`}>
              <div className="folder-grid">{d.folders.map((f) => <FolderCard key={f.id} f={f} />)}</div>
            </Card>
          )}
          {d.visits.length > 0 && (
            <Card title={`Visitors (${d.visits.length})`}>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Visitor ID</th><th>Name</th><th>Type</th><th>Host / vehicle</th><th>ID</th><th>Checked in</th><th>Folder</th></tr></thead>
                <tbody>{d.visits.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{visitorId(v.referenceNo)}</td>
                    <td><strong>{v.visitorName}</strong>{v.company && <div className="muted small">{v.company}</div>}{v.role && v.role !== 'visitor' && <Badge>{v.role}</Badge>}</td>
                    <td>{VISIT_TYPE_LABEL[v.visitType]} {v.status === 'on_site' && <Badge tone="red">On site</Badge>}</td>
                    <td>{v.vehiclePlate ?? v.hostName ?? '—'}</td>
                    <td className="mono small">{v.idNumberMasked ?? '—'}</td>
                    <td className="small nowrap">{dateTime(v.checkedInAt)}</td>
                    <td>{v.groupId ? <Link to={`/folders/${v.groupId}`}>{groupRef(v.groupNo)}</Link> : '—'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
          )}
          {d.files.length > 0 && (
            <Card title={`Files (${d.files.length})`}>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>File</th><th>Type</th><th>Folder</th><th>Saved</th></tr></thead>
                <tbody>{d.files.map((f) => (
                  <tr key={f.id}>
                    <td className="mono small">{f.fileName}</td>
                    <td>{FILE_KIND_LABEL[f.kind]}{f.docNumber && <span className="muted small"> · {f.docNumber}</span>}</td>
                    <td><Link to={`/folders/${f.groupId}`} className="mono small">{f.folderName}</Link></td>
                    <td className="small nowrap">{dateTime(f.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export function FolderCard({ f }: { f: Group }) {
  const files = Object.values(f.fileCounts).reduce((a, b) => a + b, 0);
  const vehicle = f.visitType === 'delivery' && f.vehiclePlate;
  return (
    <Link to={`/folders/${f.id}`} className={`folder-card ${vehicle ? 'vehicle' : ''}`}>
      <span className="folder-icon" aria-hidden>{vehicle ? <IconTruck /> : <IconFolder />}</span>
      <span className="folder-main">
        <span className="folder-name mono">{f.folderName}</span>
        <span className="muted small">
          {vehicle ? `${f.leadName ?? ''}${f.visitorCount > 1 ? ` +${f.visitorCount - 1}` : ''}` : `${f.visitorCount} ${f.visitorCount === 1 ? 'person' : 'people'}`}
          {' · '}{files} file{files === 1 ? '' : 's'}{f.poNumber ? ` · ${f.poNumber}` : ''}
        </span>
      </span>
      <span className="folder-side">
        <span className="mono small">{groupRef(f.groupNo)}</span>
        {f.onSiteCount > 0 && <Badge tone="red">{f.onSiteCount} on site</Badge>}
      </span>
    </Link>
  );
}
