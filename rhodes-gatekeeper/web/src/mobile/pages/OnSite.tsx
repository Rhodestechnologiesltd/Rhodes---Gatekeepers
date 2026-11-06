import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { elapsedSince, groupRef, time, visitorId, VISIT_TYPE_LABEL } from '../../lib/format';
import type { OnSiteRow } from '../../lib/types';
import { Alert, Badge, Button, Empty, Modal, Spinner, TextInput, useAsync, useToast } from '../../components/ui';

/** On-site list, refreshed every 15 s (the tablet polls; live push is used by the web dashboard). */
export function useOnSite() {
  const list = useAsync(() => api<OnSiteRow[]>('/visits/on-site'), []);
  useEffect(() => {
    const t = window.setInterval(() => void list.reload(), 15_000);
    return () => window.clearInterval(t);
  }, [list.reload]);
  return list;
}

interface Party { key: string; groupId: string | null; groupNo: number | null; members: OnSiteRow[] }

export function OnSitePage() {
  const toast = useToast();
  const list = useOnSite();
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<{ party: Party; member: OnSiteRow | null } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const parties = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rows = (list.data ?? []).filter((v) => !t || [v.visitorName, v.company, v.hostName, v.deliveryCompany, v.badgeNumber, v.vehiclePlate, visitorId(v.referenceNo), groupRef(v.groupNo)]
      .some((x) => x?.toLowerCase().includes(t)));
    const map = new Map<string, Party>();
    for (const r of rows) {
      const key = r.groupId ?? r.id;
      const p = map.get(key) ?? { key, groupId: r.groupId, groupNo: r.groupNo, members: [] };
      p.members.push(r);
      map.set(key, p);
    }
    for (const p of map.values()) p.members.sort((a, b) => (a.groupPosition ?? 0) - (b.groupPosition ?? 0));
    // Newest arrivals first — that is who is most likely to be leaving or asked about at the gate.
    return [...map.values()].sort((a, b) => b.members[0].checkedInAt.localeCompare(a.members[0].checkedInAt));
  }, [q, list.data]);

  const doCheckout = async () => {
    if (!confirm) return;
    setBusy(true);
    setErr('');
    try {
      if (confirm.member) await api(`/visits/${confirm.member.id}/check-out`, { body: { note: note || undefined } });
      else await api(`/visit-groups/${confirm.party.groupId}/check-out`, { body: { note: note || undefined } });
      toast(confirm.member ? `${confirm.member.visitorName} checked out` : `${confirm.party.members.length} people checked out`);
      setConfirm(null);
      setNote('');
      void list.reload();
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === 'ALREADY_CHECKED_OUT') {
        setConfirm(null);
        void list.reload();
      } else setErr(ae.message);
    } finally {
      setBusy(false);
    }
  };

  const total = list.data?.length ?? 0;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>On site now <Badge tone="red">{total}</Badge></h1><p>Check out people as they leave — one at a time or the whole group.</p></div>
        <Link to="/check-in" className="btn btn-primary">New check-in</Link>
      </div>
      <input className="search" type="search" placeholder="Search name, Visitor ID, pass, plate, company…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people on site" style={{ fontSize: '1.1rem', minHeight: 56 }} />
      {list.error && <Alert tone="error">{list.error.message}</Alert>}
      {list.loading && !list.data ? <Spinner /> : parties.length === 0 ? <Empty title={q ? 'No match' : 'Nobody is on site'} /> : (
        <div className="party-list">
          {parties.map((p) => {
            const first = p.members[0];
            const isGroup = p.members.length > 1;
            return (
              <article key={p.key} className={`party ${first.visitType === 'delivery' ? 'vehicle' : ''}`}>
                <header className="party-head">
                  <div>
                    <div className="party-title">
                      {first.vehiclePlate && first.visitType === 'delivery' ? <span className="plate">{first.vehiclePlate}</span> : <strong>{isGroup ? `Group of ${p.members.length}` : first.visitorName}</strong>}
                      <Badge tone="teal">{VISIT_TYPE_LABEL[first.visitType]}</Badge>
                      {p.groupNo && isGroup && <span className="muted small mono">{groupRef(p.groupNo)}</span>}
                    </div>
                    <div className="muted small">
                      {[first.deliveryCompany ?? first.company, first.hostName ?? first.department, `in ${time(first.checkedInAt)} · ${elapsedSince(first.checkedInAt)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {isGroup && p.groupId && <Button variant="primary" onClick={() => { setConfirm({ party: p, member: null }); setErr(''); }}>Check out all {p.members.length}</Button>}
                </header>
                <ul className="party-members">
                  {p.members.map((m) => (
                    <li key={m.id}>
                      <span className="mono vid">{visitorId(m.referenceNo)}</span>
                      <span className="who"><strong>{m.visitorName}</strong>
                        <span className="muted small">{[m.groupRole && m.groupRole !== 'visitor' ? m.groupRole : null, m.badgeNumber ? `pass ${m.badgeNumber}` : null, m.idNumberMasked].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Button variant={isGroup ? 'secondary' : 'primary'} onClick={() => { setConfirm({ party: p, member: m }); setErr(''); }}>Check out</Button>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      {confirm && (
        <Modal title={confirm.member ? 'Confirm check-out' : `Check out all ${confirm.party.members.length}`} onClose={() => setConfirm(null)}
          footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" size="lg" busy={busy} onClick={() => void doCheckout()}>Check out now</Button></>}>
          <div className="stack">
            {(confirm.member ? [confirm.member] : confirm.party.members).map((m) => (
              <div key={m.id} className="row-between"><span><strong>{m.visitorName}</strong> <span className="muted mono">{visitorId(m.referenceNo)}</span></span>{m.badgeNumber && <Badge>pass {m.badgeNumber}</Badge>}</div>
            ))}
            {(confirm.member ? [confirm.member] : confirm.party.members).some((m) => m.badgeNumber) && <Alert tone="info">Collect the visitor passes.</Alert>}
            <TextInput label="Note (optional)" value={note} onChange={setNote} />
            {err && <Alert tone="error">{err}</Alert>}
          </div>
        </Modal>
      )}
    </div>
  );
}
