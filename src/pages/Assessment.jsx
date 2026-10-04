import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { DELETE_ASSESSMENT, LIST_ASSESSMENTS, LIST_MY_CLASSES, LOCK_ASSESSMENT } from '../api/operations.js';
import { weightRemaining } from '@gradebook/domain/assessment';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';

const TERM_ID = import.meta.env.VITE_TERM_ID || 'term_2026_2';

export default function Assessments() {
  const { actor } = useAuth();
  const [params, setParams] = useSearchParams();
  const classId = params.get('class') || '';

  const [classes, setClasses] = useState([]);
  const [assessments, setAssessments] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const canLock = actor.groups.includes('Admin') || actor.groups.includes('Head Teacher');

  useEffect(() => {
    gql(LIST_MY_CLASSES, { school_id: actor.schoolId })
      .then((res) => {
        setClasses(res.listMyClasses);
        if (!classId && res.listMyClasses.length) {
          setParams({ class: res.listMyClasses[0].class_id }, { replace: true });
        }
      })
      .catch((e) => setError(e.message));
  }, [actor.schoolId, classId, setParams]);

  const load = useCallback(() => {
    if (!classId) return;
    setLoading(true);
    setError(null);
    gql(LIST_ASSESSMENTS, { school_id: actor.schoolId, class_id: classId, term_id: TERM_ID })
      .then((res) => setAssessments(res.listAssessmentsByClass.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [actor.schoolId, classId]);

  useEffect(() => {
    load();
  }, [load]);

  async function lock(assessment) {
    if (!window.confirm(`Lock "${assessment.title}"? Marks can no longer be edited.`)) return;
    try {
      await gql(LOCK_ASSESSMENT, {
        school_id: actor.schoolId,
        assessment_id: assessment.assessment_id,
      });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(assessment) {
    const message =
      `Delete "${assessment.title}"? This cannot be undone.\n\n` +
      `Its ${assessment.weight}% goes back to ${assessment.subject}.`;
    if (!window.confirm(message)) return;
    try {
      await gql(DELETE_ASSESSMENT, {
        input: {
          school_id: actor.schoolId,
          assessment_id: assessment.assessment_id,
          _version: assessment._version,
        },
      });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  const sorted = useMemo(
    () => [...assessments].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [assessments]
  );

  // Per-subject weight budget, so a teacher can see at a glance where the
  // remaining 100% has gone before they open the form.
  const budgets = useMemo(() => {
    const subjects = [...new Set(assessments.map((a) => a.subject))];
    return subjects.map((s) => ({ subject: s, remaining: weightRemaining(assessments, s) }));
  }, [assessments]);

  const className = classes.find((c) => c.class_id === classId)?.name;

  return (
    <>
      <div className="page-head">
        <h1>Assessments</h1>
        <Select
          aria-label="Class"
          value={classId}
          onChange={(v) => setParams({ class: v })}
          options={classes.map((c) => ({ value: c.class_id, label: c.name }))}
          placeholder="Choose a class"
          style={{ width: 220 }}
        />
        <Link className="btn" to={`/assessments/new?class=${classId}`}>
          Add assessment
        </Link>
      </div>

      {error && <div className="card error-card">{error}</div>}

      {budgets.length > 0 && (
        <div className="budget-row">
          {budgets.map((b) => (
            <span key={b.subject} className="budget">
              {b.subject}: <b>{b.remaining}%</b> unassigned
            </span>
          ))}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Subject</th><th>Type</th><th>Weight</th>
              <th>Out of</th><th>Due</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!loading && sorted.length === 0 && (
              <tr className="empty">
                <td colSpan={8}>
                  {className
                    ? `No assessments for ${className} this term. Add one to start recording marks.`
                    : 'Choose a class to see its assessments.'}
                </td>
              </tr>
            )}
            {sorted.map((a) => (
              <tr key={a.assessment_id}>
                <td>{a.title}</td>
                <td>{a.subject}</td>
                <td>{a.assessment_type}</td>
                <td>{a.weight}%</td>
                <td>{a.max_score}</td>
                <td>{a.due_date || '—'}</td>
                <td><StatusPill status={a.status} /></td>
                <td className="actions">
                  {a.status === 'LOCKED' ? (
                    <span className="hint">No changes allowed</span>
                  ) : (
                    <>
                      <Link to={`/assessments/${a.assessment_id}/edit?class=${classId}`}>Edit</Link>
                      {canLock && (
                        <button type="button" className="btn link" onClick={() => lock(a)}>
                          Lock
                        </button>
                      )}
                      {a.status === 'UNRECORDED' && (
                        <button type="button" className="btn link danger" onClick={() => remove(a)}>
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}