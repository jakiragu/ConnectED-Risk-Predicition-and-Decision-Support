import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import {
  DELETE_ASSESSMENT,
  LIST_ASSESSMENTS,
  LIST_DELETED_ASSESSMENTS,
  LIST_MY_CLASSES,
  LOCK_ASSESSMENT,
  UNLOCK_ASSESSMENT,
  RESTORE_ASSESSMENT,
  SOFT_DELETE_ASSESSMENT,
} from '../api/operations.js';
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
  const [deleted, setDeleted] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const isAdmin = actor.groups.includes('Admin');
  const canLock = isAdmin || actor.groups.includes('Head Teacher');

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
    const vars = { school_id: actor.schoolId, class_id: classId, term_id: TERM_ID };
    setLoading(true);
    Promise.all([
      gql(LIST_ASSESSMENTS, vars),
      isAdmin ? gql(LIST_DELETED_ASSESSMENTS, vars) : Promise.resolve({ listDeletedAssessments: [] }),
    ])
      .then(([live, gone]) => {
        setAssessments(live.listAssessmentsByClass.items);
        setDeleted(gone.listDeletedAssessments);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [actor.schoolId, classId, isAdmin]);

  useEffect(() => {
    setError(null);
    load();
  }, [load]);

  // Every mutation reloads the list afterwards, success or failure: the server
  // has moved _version and status, and on a Conflict someone else changed it.
  async function run(mutation, variables) {
    setError(null);
    try {
      await gql(mutation, variables);
    } catch (e) {
      setError(e.message);
    }
    load();
  }

  function lock(a) {
    if (!window.confirm(`Lock "${a.title}"? Marks can no longer be edited.`)) return;
    run(LOCK_ASSESSMENT, { school_id: actor.schoolId, assessment_id: a.assessment_id });
  }

  function unlock(a) {
    const message =
      `Unlock "${a.title}"? Marks and details can be changed again until results are published.`;
    if (window.confirm(message)) {
      run(UNLOCK_ASSESSMENT, { school_id: actor.schoolId, assessment_id: a.assessment_id });
    }
  }

  const ref = (a) => ({ input: { school_id: actor.schoolId, assessment_id: a.assessment_id, _version: a._version } });

  function remove(a) {
    const message = `Delete "${a.title}"? This cannot be undone.\n\nIts ${a.weight}% goes back to ${a.subject}.`;
    if (window.confirm(message)) run(DELETE_ASSESSMENT, ref(a));
  }

  function softRemove(a) {
    const message =
      `Delete "${a.title}" and its ${a.score_count} recorded mark${a.score_count === 1 ? '' : 's'}?\n\n` +
      `It can be restored from "Deleted assessments" below. Its ${a.weight}% goes back to ${a.subject} until then.`;
    if (window.confirm(message)) run(SOFT_DELETE_ASSESSMENT, ref(a));
  }

  function restore(a) {
    run(RESTORE_ASSESSMENT, { school_id: actor.schoolId, assessment_id: a.assessment_id });
  }

  const sorted = useMemo(
    () => [...assessments].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [assessments]
  );

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
              <th>Out of</th><th>Marks</th><th>Due</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!loading && sorted.length === 0 && (
              <tr className="empty">
                <td colSpan={9}>
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
                <td>{a.score_count}</td>
                <td>{a.due_date || '—'}</td>
                <td><StatusPill status={a.status} /></td>
                <td className="actions">
                  <Link to={`/assessments/${a.assessment_id}/scores?class=${classId}`}>
                    {a.status === 'LOCKED' ? 'View marks' : 'Enter marks'}
                  </Link>

                  {a.status === 'LOCKED' && isAdmin && (
                      <button type="button" className="btn link" onClick={() => unlock(a)}>Unlock</button>
                  )}
                  {a.status !== 'LOCKED' && (
                    <>
                      <Link to={`/assessments/${a.assessment_id}/edit?class=${classId}`}>Edit</Link>
                      {canLock && (
                        <button type="button" className="btn link" onClick={() => lock(a)}>Lock</button>
                      )}
                      {a.score_count === 0 && (
                        <button type="button" className="btn link danger" onClick={() => remove(a)}>Delete</button>
                      )}
                      {a.score_count > 0 && isAdmin && (
                        <button type="button" className="btn link danger" onClick={() => softRemove(a)}>Delete</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && deleted.length > 0 && (
        <>
          <h2>Deleted assessments</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Subject</th><th>Weight</th><th>Marks</th><th>Deleted</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {deleted.map((a) => (
                  <tr key={a.assessment_id}>
                    <td>{a.title}</td>
                    <td>{a.subject}</td>
                    <td>{a.weight}%</td>
                    <td>{a.score_count}</td>
                    <td>{a.deleted_at ? new Date(a.deleted_at).toLocaleString() : '—'}</td>
                    <td className="actions">
                      <button type="button" className="btn link" onClick={() => restore(a)}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}