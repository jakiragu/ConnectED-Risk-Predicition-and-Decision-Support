import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import {
  DELETE_ASSESSMENT,
  LIST_DELETED_ASSESSMENTS,
  LOCK_ASSESSMENT,
  RESTORE_ASSESSMENT,
  SOFT_DELETE_ASSESSMENT,
  UNLOCK_ASSESSMENT,
} from '../api/operations.js';
import { weightRemaining } from '@gradebook/domain/assessment';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { watchClass } from '../offline/syncEngine.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';

const TERM_ID = import.meta.env.VITE_TERM_ID || 'term_2026_2';

export default function Assessments() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const classId = params.get('class') || '';

  const [deleted, setDeleted] = useState([]);
  const [error, setError] = useState(null);

  const isAdmin = actor.groups.includes('Admin');
  const canLock = isAdmin || actor.groups.includes('Head Teacher');

  const classes = useLive(() => db().classes.toArray(), [], []);
  const assessments = useLive(
    () => (classId ? db().assessments.where('[class_id+term_id]').equals([classId, TERM_ID]).toArray() : []),
    [classId],
    null
  );

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setError(e.message));
  }, [actor.schoolId]);

  useEffect(() => {
    if (!classId && classes.length) setParams({ class: classes[0].class_id }, { replace: true });
  }, [classId, classes, setParams]);

  const refresh = useCallback(async () => {
    if (!classId) return;
    await repository.loadAssessments(actor.schoolId, classId, TERM_ID);
    if (isAdmin && online) {
      const res = await gql(LIST_DELETED_ASSESSMENTS, { school_id: actor.schoolId, class_id: classId, term_id: TERM_ID });
      setDeleted(res.listDeletedAssessments);
    }
  }, [actor.schoolId, classId, isAdmin, online]);

  useEffect(() => {
    setError(null);
    refresh().catch((e) => setError(e.message));
    return classId ? watchClass(classId, TERM_ID) : undefined;
  }, [classId, refresh]);


  async function run(mutation, variables) {
    setError(null);
    try {
      await gql(mutation, variables);
    } catch (e) {
      setError(e.message);
    }
    await refresh().catch(() => {});
  }

  const ref = (a) => ({ input: { school_id: actor.schoolId, assessment_id: a.assessment_id, _version: a._version } });
  const byId = (a) => ({ school_id: actor.schoolId, assessment_id: a.assessment_id });

  function lock(a) {
    if (window.confirm(`Lock "${a.title}"? Marks can no longer be edited.`)) run(LOCK_ASSESSMENT, byId(a));
  }
  function unlock(a) {
    if (window.confirm(`Unlock "${a.title}"? Marks and details can be changed again until results are published.`)) {
      run(UNLOCK_ASSESSMENT, byId(a));
    }
  }
  function remove(a) {
    if (window.confirm(`Delete "${a.title}"? This cannot be undone.\n\nIts ${a.weight}% goes back to ${a.subject}.`)) {
      run(DELETE_ASSESSMENT, ref(a));
    }
  }
  function softRemove(a) {
    const message =
      `Delete "${a.title}" and its ${a.score_count} recorded mark${a.score_count === 1 ? '' : 's'}?\n\n` +
      `It can be restored from "Deleted assessments" below. Its ${a.weight}% goes back to ${a.subject} until then.`;
    if (window.confirm(message)) run(SOFT_DELETE_ASSESSMENT, ref(a));
  }
  const restore = (a) => run(RESTORE_ASSESSMENT, byId(a));

  const list = assessments || [];
  const sorted = useMemo(
    () => [...list].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [list]
  );
  const budgets = useMemo(() => {
    const subjects = [...new Set(list.map((a) => a.subject))];
    return subjects.map((s) => ({ subject: s, remaining: weightRemaining(list, s) }));
  }, [list]);

  const className = classes.find((c) => c.class_id === classId)?.name;

  return (
    <>
      <div className="page-head">
        <h1>Assessments</h1>
        <Select
          aria-label="Class"
          value={classId}
          onChange={(v) => setParams({ class: v })}
          options={[...classes].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.class_id, label: c.name }))}
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
            {assessments && sorted.length === 0 && (
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
                <td>
                  {a._failed ? <span className="error">Not created: {a._failed}</span>
                    : a._pending ? <span className="pill recording">Waiting to sync</span>
                    : <StatusPill status={a.status} />}
                </td>
                <td className="actions">
                  {!a._failed && (
                    <Link to={`/assessments/${a.assessment_id}/scores?class=${classId}`}>
                      {a.status === 'LOCKED' ? 'View marks' : 'Enter marks'}
                    </Link>
                  )}
                  {!a._pending && online && (
                    <>
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
                    </>
                  )}
                  {!a._pending && !online && <span className="hint">Other changes need a connection</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && online && deleted.length > 0 && (
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