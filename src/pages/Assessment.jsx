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
import { examTotals, TOTAL_WEIGHT } from '@gradebook/domain/assessment';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';
import CheckpointWeights from '../components/CheckpointWeights.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { watchClass } from '../offline/syncEngine.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';

const TYPE_ORDER = { Opener: 0, 'Mid-term': 1, 'End-term': 2 };

export default function Assessments() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const classId = params.get('class') || '';
  const { terms, defaultTermId } = useTerms(actor.schoolId);
  const termId = params.get('term') || defaultTermId;
  const go = (next) => setParams({ class: classId, term: termId, ...next });

  const [deleted, setDeleted] = useState([]);
  const [error, setError] = useState(null);

  const isAdmin = actor.groups.includes('Admin');
  const canLock = isAdmin || actor.groups.includes('Head Teacher');

  const classes = useLive(() => db().classes.toArray(), [], []);
  const assessments = useLive(
    () => (classId && termId ? db().assessments.where('[class_id+term_id]').equals([classId, termId]).toArray() : []),
    [classId, termId],
    null
  );

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setError(e.message));
  }, [actor.schoolId]);

  useEffect(() => {
    if (!classId && classes.length) setParams({ class: classes[0].class_id, term: termId }, { replace: true });
  }, [classId, classes, termId, setParams]);

  const refresh = useCallback(async () => {
    if (!classId || !termId) return;
    await repository.loadAssessments(actor.schoolId, classId, termId);
    if (isAdmin && online) {
      const res = await gql(LIST_DELETED_ASSESSMENTS, { school_id: actor.schoolId, class_id: classId, term_id: termId });
      setDeleted(res.listDeletedAssessments);
    }
  }, [actor.schoolId, classId, termId, isAdmin, online]);

  useEffect(() => {
    setError(null);
    refresh().catch((e) => setError(e.message));
    return classId && termId ? watchClass(classId, termId) : undefined;
  }, [classId, termId, refresh]);


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
    if (window.confirm(`Delete "${a.title}"? This cannot be undone.\n\nIts ${a.weight}% goes back to the ${a.subject} ${a.assessment_type} exam.`)) {
      run(DELETE_ASSESSMENT, ref(a));
    }
  }
  function softRemove(a) {
    const message =
      `Delete "${a.title}" and its ${a.score_count} recorded mark${a.score_count === 1 ? '' : 's'}?\n\n` +
      `It can be restored from "Deleted assessments" below. Its ${a.weight}% goes back to the ${a.subject} ${a.assessment_type} exam until then.`;
    if (window.confirm(message)) run(SOFT_DELETE_ASSESSMENT, ref(a));
  }
  const restore = (a) => run(RESTORE_ASSESSMENT, byId(a));

  const list = assessments || [];
  const sorted = useMemo(
    () => [...list].sort((a, b) => a.subject.localeCompare(b.subject)
      || (TYPE_ORDER[a.assessment_type] ?? 9) - (TYPE_ORDER[b.assessment_type] ?? 9)
      || (a.paper_no ?? 9) - (b.paper_no ?? 9)),
    [list]
  );
  // Each subject's papers in each checkpoint must total 100% before that checkpoint can be published.
  const budgets = useMemo(
    () => examTotals(list)
      .sort((a, b) => a.subject.localeCompare(b.subject) || TYPE_ORDER[a.assessment_type] - TYPE_ORDER[b.assessment_type])
      .map((t) => ({ ...t, remaining: TOTAL_WEIGHT - t.weight })),
    [list]
  );

  const className = classes.find((c) => c.class_id === classId)?.name;

  return (
    <>
      <div className="page-head">
        <h1>Assessments</h1>
        <Select
          aria-label="Term"
          value={termId}
          onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))}
          placeholder="Choose a term"
          style={{ width: 180 }}
        />
        <Select
          aria-label="Class"
          value={classId}
          onChange={(v) => go({ class: v })}
          options={[...classes].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.class_id, label: c.name }))}
          placeholder="Choose a class"
          style={{ width: 220 }}
        />
        <Link className="btn" to={`/assessments/new?class=${classId}&term=${termId}`}>
          Add assessment
        </Link>
      </div>

      {error && <div className="card error-card">{error}</div>}

      {termId && <CheckpointWeights schoolId={actor.schoolId} termId={termId} online={online} />}

      {budgets.length > 0 && (
        <div className="budget-row">
          {budgets.map((b) => (
            <span key={`${b.subject}|${b.assessment_type}`} className={`budget ${b.remaining === 0 ? '' : 'warn'}`}>
              {b.subject} {b.assessment_type}: {b.remaining === 0 ? <b>100% assigned</b> : <><b>{b.remaining}%</b> unassigned</>}
            </span>
          ))}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Subject</th><th>Checkpoint</th><th>Paper</th><th>Weight</th>
              <th>Out of</th><th>Marks</th><th>Due</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {assessments && sorted.length === 0 && (
              <tr className="empty">
                <td colSpan={10}>
                  {className
                    ? `No assessments for ${className} in ${terms.find((t) => t.term_id === termId)?.name || 'this term'}. Add one to start recording marks.`
                    : 'Choose a class to see its assessments.'}
                </td>
              </tr>
            )}
            {sorted.map((a) => (
              <tr key={a.assessment_id}>
                <td>{a.title}</td>
                <td>{a.subject}</td>
                <td>{a.assessment_type}</td>
                <td>{a.paper_no ? `Paper ${a.paper_no}` : '—'}</td>
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
                    <Link to={`/assessments/${a.assessment_id}/scores?class=${classId}&term=${termId}`}>
                      {a.status === 'LOCKED' ? 'View marks' : 'Enter marks'}
                    </Link>
                  )}
                  {!a._pending && online && (
                    <>
                      {a.status === 'LOCKED' && isAdmin && !(a.published_in || []).length && (
                        <button type="button" className="btn link" onClick={() => unlock(a)}>Unlock</button>
                      )}
                      {a.status !== 'LOCKED' && (
                        <>
                          <Link to={`/assessments/${a.assessment_id}/edit?class=${classId}&term=${termId}`}>Edit</Link>
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
                  <th>Name</th><th>Subject</th><th>Checkpoint</th><th>Paper</th><th>Weight</th><th>Marks</th><th>Deleted</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {deleted.map((a) => (
                  <tr key={a.assessment_id}>
                    <td>{a.title}</td>
                    <td>{a.subject}</td>
                    <td>{a.assessment_type}</td>
                    <td>{a.paper_no ? `Paper ${a.paper_no}` : '—'}</td>
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