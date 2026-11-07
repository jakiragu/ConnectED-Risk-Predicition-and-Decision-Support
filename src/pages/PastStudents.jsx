import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { LIST_PAST_STUDENTS } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import { Notice, Offline } from '../components/ui.jsx';
import { useSync } from '../offline/useSync.js';

/**
 * Graduates and students who left (administrators). Their records stay as they
 * were: published results, report cards, risk history and interventions, read
 * only, opened from the student profile with its year selector.
 */
const STATUS = { GRADUATED: 'Graduated', INACTIVE: 'Left or deactivated' };

export default function PastStudents() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [students, setStudents] = useState(null);
  const [year, setYear] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!online) return;
    gql(LIST_PAST_STUDENTS, { school_id: actor.schoolId })
      .then(({ listPastStudents }) => setStudents(listPastStudents))
      .catch((e) => setError(e.message));
  }, [actor.schoolId, online]);

  const years = useMemo(() => [...new Set((students || [])
    .map((s) => s.graduation_year ?? s.left_year).filter(Boolean))].sort((a, b) => b - a), [students]);
  const shown = (students || []).filter((s) =>
    (!year || String(s.graduation_year ?? s.left_year) === year) && (!status || s.status === status));

  if (!online) return <Offline what="Past students" />;

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/classes">Back</Link>
        <h1>Past students</h1>
        <Select aria-label="Year" value={year} onChange={setYear} allLabel="All years"
          options={years.map((y) => ({ value: String(y), label: String(y) }))} />
        <Select aria-label="Status" value={status} onChange={setStatus} allLabel="All past students"
          options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} />
      </div>
      <div className="hint">Records here are read-only. Open a profile to see any school year the student has results in.</div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Admission no</th><th>Name</th><th>Status</th><th>Year</th><th>Last class</th><th>Records</th></tr></thead>
          <tbody>
            {students && shown.length === 0 && (
              <tr className="empty"><td colSpan={6}>No past students{year ? ` for ${year}` : ''} yet. Graduates appear here after a school year is closed.</td></tr>
            )}
            {!students && !error && <tr className="empty"><td colSpan={6}>Loading…</td></tr>}
            {shown.map((s) => (
              <tr key={s.student_id}>
                <td>{s.admission_no}</td>
                <td>{s.first_name} {s.last_name}</td>
                <td>{s.departure_kind === 'LEFT' ? 'Left permanently' : s.departure_kind === 'TEMPORARY' ? 'Temporarily deactivated' : STATUS[s.status] ?? s.status}{s.deactivation_reason && <div className="hint">{s.deactivation_reason} · {s.deactivation_date}</div>}</td>
                <td>{s.graduation_year ?? s.left_year ?? <span className="hint">—</span>}</td>
                <td>{s.class_name ?? <span className="hint">—</span>}</td>
                <td><Link to={`/students/${s.student_id}/risk`} state={{ from: '/students/past' }}>Profile</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
