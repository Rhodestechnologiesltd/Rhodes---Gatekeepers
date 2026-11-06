export function Bars({ rows, accent }: { rows: { label: string; value: number }[]; accent?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="empty small">No data for this period</div>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span className="bar-label" title={r.label}>{r.label}</span>
          <span className="bar-track" role="img" aria-label={`${r.label}: ${r.value}`}>
            <span className={`bar-fill ${accent ? 'red' : ''}`} style={{ width: `${(r.value / max) * 100}%`, display: 'block' }} />
          </span>
          <span className="bar-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
