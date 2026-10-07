import { useEffect, useRef } from 'react';

export default function ConflictDialog({ open, student, maxScore, options, onChoose, onCancel, busy, error, online }) {
  const first = useRef(null);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  if (!open) return null;

  return (
    <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title">Two entries for {student}</h2>
        <p>Choose the mark that should stand. The other is kept in the audit trail.</p>
        {!online && <div className="notice">Deciding needs a connection.</div>}
        {error && <div className="error">{error}</div>}
        <div className="choices">
          {options.map((o, i) => (
            <button
              key={o.label}
              ref={i === 0 ? first : undefined}
              type="button"
              className="choice"
              disabled={busy || !online}
              onClick={() => onChoose(o.value)}
            >
              <span>{o.label}</span>
              <b>{o.value === null ? 'No mark' : `${o.value} / ${maxScore}`}</b>
            </button>
          ))}
        </div>
        <button type="button" className="btn secondary" onClick={onCancel}>Decide later</button>
      </div>
    </div>
  );
}