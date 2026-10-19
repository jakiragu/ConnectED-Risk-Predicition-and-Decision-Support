import { useEffect, useRef, useState } from 'react';

/**
 * Small shared building blocks. Every page uses these rather than its own
 * markup, so a notice, an empty page, a checkbox or a risk figure looks and
 * reads the same everywhere. Styles live in styles/global.css.
 */

/** A message about the page. tone: info (default) | warn | error | success. */
export function Notice({ tone = 'info', children }) {
  return <div className={`notice${tone === 'info' ? '' : ` ${tone}`}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}

/** What a page shows when it has nothing to show yet, with the next step. */
export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** The page shown when an action needs the server and there is no saved copy. */
export const Offline = ({ what }) => (
  <EmptyState title="You are offline">{what} needs a connection. Anything you have entered is kept on this device.</EmptyState>
);

const DANGER_ICONS = {
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  ban: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
};

/**
 * A destructive action (delete, remove, deactivate): red outline with an icon
 * and its label, so it never reads as an unlabelled red block.
 * icon: trash (default) | x | ban
 */
export function DangerButton({ icon = 'trash', children, ...rest }) {
  return (
    <button type="button" className="btn small destructive" {...rest}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{DANGER_ICONS[icon]}</svg>
      <span>{children}</span>
    </button>
  );
}

/** A checkbox that can also show "some selected". */
export function Checkbox({ checked, indeterminate = false, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

/** An "i" that opens a short explanation, so the page itself stays brief. */
export function Info({ label = 'More information', children }) {
  return (
    <details className="info">
      <summary aria-label={label} title={label}>i</summary>
      <div>{children}</div>
    </details>
  );
}

/** A confirmation that disappears by itself. Returns [element, show]. */
export function useToast(ms = 3500) {
  const [text, setText] = useState(null);
  useEffect(() => {
    if (!text) return undefined;
    const t = setTimeout(() => setText(null), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return [text ? <div className="toast" role="status">{text}</div> : null, setText];
}

/** Progress of a background job, such as producing report cards. */
export function Progress({ done = 0, total = 0, label, failed = false }) {
  const share = total ? Math.min(done / total, 1) : 0;
  return (
    <span className={`progress${failed ? ' failed' : ''}`}>
      <span className="track" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span>
      {label ?? `${done} of ${total}`}
    </span>
  );
}

/** An estimated risk as a short bar with its percentage; the mark is the model's threshold. */
export function RiskBar({ probability, threshold, atRisk }) {
  if (probability == null) return <span className="hint">—</span>;
  return (
    <span className={`riskbar${atRisk ? ' at-risk' : ''}`} title={`Flagged at ${Math.round(threshold * 100)}% or more`}>
      <span className="track" aria-hidden="true">
        <i style={{ width: `${probability * 100}%` }} />
        {threshold != null && <span className="tick" style={{ left: `${threshold * 100}%` }} />}
      </span>
      <b className={atRisk ? 'risk' : ''}>{Math.round(probability * 100)}%</b>
    </span>
  );
}

/**
 * What moved an estimate (SHAP), as bars either side of a centre line: right
 * raised the risk, left lowered it. Bar length is each factor's share of the
 * total effect, so the bars add up to the whole explanation.
 * items: [{ key, label, share, direction: 'RAISES'|'LOWERS'|'NONE', note }]
 */
export function InfluenceChart({ items, limit = 5 }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return <span className="hint">No explanation for this estimate.</span>;
  const shown = all ? items : items.slice(0, limit);
  const max = Math.max(...items.map((i) => i.share), 0.0001);
  return (
    <div className="influence">
      <div className="influence-head"><span /><span className="sides"><span>← lowered risk</span><span>raised risk →</span></span><span /></div>
      {shown.map((i) => {
        const width = (i.share / max) * 50;
        const side = i.direction === 'LOWERS' ? 'lowers' : 'raises';
        return (
          <div key={i.key} className="influence-row">
            <span className="name">{i.label}{i.note && <small> · {i.note}</small>}</span>
            <span className="lane" aria-hidden="true">
              {i.direction !== 'NONE' && <i className={`${side}${i.missing ? ' missing' : ''}`} style={{ width: `${width}%` }} />}
            </span>
            <span className="val">{Math.round(i.share * 100)}%</span>
          </div>
        );
      })}
      {items.length > limit && (
        <button type="button" className="btn link" onClick={() => setAll(!all)}>
          {all ? 'Show the main ones' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** Average influence (mean absolute SHAP), one-sided: how much each factor moves estimates, in either direction. */
export function ImportanceChart({ items, limit = 9 }) {
  if (!items?.length) return <span className="hint">Nothing to show yet.</span>;
  const total = items.reduce((s, i) => s + i.importance, 0) || 1;
  const max = Math.max(...items.map((i) => i.importance)) || 1;
  return (
    <div className="influence one-sided">
      {items.slice(0, limit).map((i) => (
        <div key={i.name} className="influence-row">
          <span className="name">{i.label}</span>
          <span className="lane" aria-hidden="true"><i style={{ width: `${(i.importance / max) * 100}%` }} /></span>
          <span className="val">{Math.round((i.importance / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
