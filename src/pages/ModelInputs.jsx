import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { GET_FEATURE_READINESS, GET_STUDENT_FEATURES } from '../api/calendarOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import '../styles/calendar.css';

const POINTS = [
  { value: 'T1M', label: 'Term 1 Mid-term (T1M)' },
  { value: 'T1F', label: 'Term 1 End-term (T1F)' },
  { value: 'T2M', label: 'Term 2 Mid-term (T2M)' },
  { value: 'T2F', label: 'Term 2 End-term (T2F)' },
  { value: 'T3M', label: 'Term 3 Mid-term (T3M)' },
];

export default function ModelInputs() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort((a, b) => a.name.localeCompare(b.name)),
    [classes, isAdmin]
  );
  const classId = params.get('class') || mine[0]?.class_id || '';
  const point = POINTS.some((p) => p.value === params.get('point')) ? params.get('point') : 'T1M';
  const year = params.get('year') ? Number(params.get('year')) : null;
  const go = (next) => setParams(Object.fromEntries(Object.entries({ class: classId, point, year, ...next }).filter(([, v]) => v)));

  const [readiness, setReadiness] = useState(null);
  const [selected, setSelected] = useState(null);
  const [features, setFeatures] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    if (!classId) return;
    const { getFeatureReadiness } = await gql(GET_FEATURE_READINESS, {
      school_id: actor.schoolId, class_id: classId, prediction_point: point, academic_year: year,
    });
    setReadiness(getFeatureReadiness);
  }, [actor.schoolId, classId, point, year]);

  useEffect(() => {
    setError(null);
    setReadiness(null);
    setSelected(null);
    setFeatures(null);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function open(student) {
    setSelected(student.student_id);
    setFeatures(null);
    try {
      const { getStudentFeatures } = await gql(GET_STUDENT_FEATURES, {
        school_id: actor.schoolId, student_id: student.student_id, prediction_point: point, academic_year: readiness.academic_year,
      });
      setFeatures(getStudentFeatures);
    } catch (e) {
      setError(e.message);
    }
  }

  if (!online) return <div className="notice">Model inputs need a connection.</div>;
  if (!isAdmin && !mine.length) return <div className="notice">Model inputs are available to administrators and class teachers.</div>;

  return (
    <>
      <div className="page-head">
        <h1>Model inputs</h1>
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
          options={mine.map((c) => ({ value: c.class_id, label: c.name }))} style={{ width: 190 }} />
        <Select aria-label="Prediction point" value={point} onChange={(v) => go({ point: v })} options={POINTS} style={{ width: 230 }} />
      </div>
      <div className="hint">
        The values the risk model receives at this point: published Mid-term and End-term exam results for its nine subjects
        (CRE is the model's Religious Education) and attendance from the first day of the school year. A blank value is sent as
        missing. Subjects a student does not take are expected to be blank.
      </div>
      {error && <div className="card error-card">{error}</div>}

      {readiness && (
        <>
          <div className="budget-row">
            <span>{readiness.class_name} · school year {readiness.academic_year} · {readiness.columns} inputs</span>
            <span>{readiness.complete} of {readiness.students.length} students have every input</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Adm no</th><th>Student</th><th>Missing results</th><th>Missing attendance</th><th>What is missing</th><th>Action</th></tr>
              </thead>
              <tbody>
                {readiness.students.map((s) => (
                  <tr key={s.student_id} className={s.student_id === selected ? 'row-dirty' : ''}>
                    <td>{s.admission_no}</td>
                    <td>{s.first_name} {s.last_name}</td>
                    <td>{s.missing_scores}</td>
                    <td>{s.missing_attendance ? <span className="warn">{s.missing_attendance}</span> : 0}</td>
                    <td className="hint">{s.notes.join('; ') || (s.complete ? 'Nothing' : 'Subjects without results')}</td>
                    <td className="actions"><button type="button" className="btn link" onClick={() => open(s)}>View inputs</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {features && (
        <div className="card stack">
          <h2>Inputs for {readiness.students.find((s) => s.student_id === features.student_id)?.first_name} at {features.prediction_point}</h2>
          <div className="feature-grid">
            {features.values.map((v) => (
              <div key={v.name} className={v.value == null ? 'missing' : ''}>
                <code>{v.name}</code>: {v.value == null ? 'missing' : v.value.toFixed(2)}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}