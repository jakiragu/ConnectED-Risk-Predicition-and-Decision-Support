import { ImportanceChart } from './ui.jsx';

/** Kept for existing imports: the shared one-sided influence chart. */
export default function ImportanceBars({ items, empty = 'Nothing to show yet.' }) {
  if (!items?.length) return <div className="hint">{empty}</div>;
  return <ImportanceChart items={items} />;
}
