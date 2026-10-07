/**
 * Only UNRECORDED and LOCKED are reachable this sprint, because no scores
 * exist yet. RECORDING and RECORDED are listed so the score sprint can start
 * returning them without touching this component.
 */
const LABELS = {
  UNRECORDED: 'Unrecorded',
  RECORDING: 'Recording',
  RECORDED: 'Recorded',
  LOCKED: 'Locked',
};

export default function StatusPill({ status }) {
  const key = (status || '').toLowerCase();
  return <span className={`pill ${key}`}>{LABELS[status] || status}</span>;
}