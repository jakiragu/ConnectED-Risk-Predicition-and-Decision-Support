import '../styles/explain.css';

/** Mean |SHAP| per item, as bars scaled to the largest. */
export default function ImportanceBars({ items, empty = 'Nothing to show yet.' }) {
  if (!items?.length) return <div className="hint">{empty}</div>;
  const max = Math.max(...items.map((i) => i.importance), 0) || 1;
  return (
    <div className="importance">
      {items.map((i) => (
        <div key={i.name} style={{ display: 'contents' }}>
          <span>{i.label}</span>
          <span className="bar" style={{ width: `${(i.importance / max) * 100}%` }} />
          <span className="hint">{i.importance.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}