const LABELS = {
  UNRECORDED: 'Unrecorded',
  RECORDING: 'Recording',
  RECORDED: 'Recorded',
  LOCKED: 'Locked',
  NOT_CALCULATED: 'Not calculated',
  CALCULATED: 'Calculated',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Not published',
};

const TONE = {
  NOT_CALCULATED: 'unrecorded',
  UNPUBLISHED: 'unrecorded',
  CALCULATED: 'recording',
  PUBLISHED: 'recorded',
};

export default function StatusPill({ status }) {
  const key = TONE[status] || (status || '').toLowerCase();
  return <span className={`pill ${key}`}>{LABELS[status] || status}</span>;
}