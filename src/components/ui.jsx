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

/**
 * A destructive action (delete, deactivate, remove). The only red button in the
 * app: red is reserved for actions that cannot easily be undone. Takes the
 * same props as <button>; type defaults to "button" so it never submits a form.
 */
export function DangerButton({ children, type = 'button', ...rest }) {
  return <button type={type} className="btn danger" {...rest}>{children}</button>;
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

/**
 * A student's estimates through the year as a tiny line, for cards. Drawn at a
 * fixed size, with the threshold dotted and the last point marked.
 * points: [{ prediction_point, probability, threshold }] in checkpoint order
 */
export function Sparkline({ points, width = 120, height = 32 }) {
  if (!points?.length) return null;
  const pad = 4;
  const x = (i) => (points.length < 2 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
  const y = (v) => pad + (1 - v) * (height - 2 * pad);
  const last = points[points.length - 1];
  const words = points.map((p) => `${p.prediction_point} ${Math.round(p.probability * 100)}%`).join(', ');
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label={`Estimated risk through the year: ${words}`}>
      <title>{words}</title>
      <line x1={pad} x2={width - pad} y1={y(last.threshold)} y2={y(last.threshold)} className="spark-threshold" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.probability)}`).join(' ')} fill="none" className="spark-line" />
      <circle cx={x(points.length - 1)} cy={y(last.probability)} r="3" className={last.probability >= last.threshold ? 'spark-dot risk' : 'spark-dot'} />
    </svg>
  );
}
