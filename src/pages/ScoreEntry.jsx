import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { validateEntry, normalize, isBlank } from '@gradebook/domain/score';
import { gql } from '../api/graphql.js';
import { GET_ASSESSMENT, GET_CLASS_ROSTER, LIST_SCORES, SUBMIT_SCORES } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import StatusPill from '../components/StatusPill.jsx';

const asText = (score) => (score ? String(score.raw_score) : '');

export default function ScoreEntry() {
  const { assessmentId } = useParams();
  const [params] = useSearchParams();
  const { actor } = useAuth();

  const [assessment, setAssessment] = useState(null);
  const [roster, setRoster] = useState([]);
  const [saved, setSaved] = useState({});      
  const [drafts, setDrafts] = useState({});    
  const [rowErrors, setRowErrors] = useState({});
  const [rowNotes, setRowNotes] = useState({});
  const [failure, setFailure] = useState(null);
  const [summary, setSummary] = useState(null);
  const [saving, setSaving] = useState(false);
  const inputs = useRef([]);

  const load = useCallback(async () => {
    const { getAssessment: a } = await gql(GET_ASSESSMENT, { school_id: actor.schoolId, assessment_id: assessmentId });
    if (!a) {
      setFailure('This assessment no longer exists.');
      return;
    }
    const [r, s] = await Promise.all([
      gql(GET_CLASS_ROSTER, { school_id: actor.schoolId, class_id: a.class_id }),
      gql(LIST_SCORES, { school_id: actor.schoolId, assessment_id: assessmentId }),
    ]);
    const byStudent = Object.fromEntries(s.listScoresByAssessment.items.map((x) => [x.student_id, x]));
    setAssessment(a);
    setRoster(r.getClassRoster);
    setSaved(byStudent);
    setDrafts(Object.fromEntries(r.getClassRoster.map((st) => [st.student_id, asText(byStudent[st.student_id])])));
    setRowErrors({});
  }, [actor.schoolId, assessmentId]);

  useEffect(() => {
    load().catch((e) => setFailure(e.message));
  }, [load]);

  const rosterIds = useMemo(() => new Set(roster.map((s) => s.student_id)), [roster]);
  const readOnly = assessment?.status === 'LOCKED';

  const changed = useMemo(
    () => roster.filter((s) => (drafts[s.student_id] ?? '').trim() !== asText(saved[s.student_id])),
    [roster, drafts, saved]
  );

  useEffect(() => {
    if (!changed.length) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed.length]);

  function edit(studentId, value) {
    setDrafts((d) => ({ ...d, [studentId]: value }));
    setRowNotes((n) => ({ ...n, [studentId]: undefined }));
    const check = validateEntry({ student_id: studentId, raw_score: value }, { assessment, roster: rosterIds });
    setRowErrors((e) => ({ ...e, [studentId]: check.ok ? undefined : check.reason }));
  }

  function nextOnEnter(e, index) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    inputs.current[index + 1]?.focus();
  }

  async function save() {
    setFailure(null);
    setSummary(null);
    const entries = changed
      .filter((s) => !rowErrors[s.student_id])
      .map((s) => {
        const draft = drafts[s.student_id];
        return {
          student_id: s.student_id,
          raw_score: isBlank(draft) ? null : Number(draft),
          _version: saved[s.student_id]?._version ?? null,
        };
      });
    if (!entries.length) return;

    setSaving(true);
    try {
      const { submitScores: res } = await gql(SUBMIT_SCORES, {
        input: { school_id: actor.schoolId, assessment_id: assessmentId, entries },
      });
      const nextSaved = { ...saved };
      const nextDrafts = { ...drafts };
      const nextErrors = { ...rowErrors };
      const nextNotes = {};
      for (const r of res.results) {
        if (r.outcome === 'REJECTED') {
          nextErrors[r.student_id] = r.reason;
          continue;
        }
        if (r.item) nextSaved[r.student_id] = r.item;
        else delete nextSaved[r.student_id];
        if (r.outcome === 'CONFLICT') {
          nextDrafts[r.student_id] = asText(r.item);
          nextNotes[r.student_id] = r.reason;
        }
      }
      setSaved(nextSaved);
      setDrafts(nextDrafts);
      setRowErrors(nextErrors);
      setRowNotes(nextNotes);
      setSummary(res);
      const { getAssessment: a } = await gql(GET_ASSESSMENT, { school_id: actor.schoolId, assessment_id: assessmentId });
      if (a) setAssessment(a);
    } catch (e) {
      setFailure(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!assessment) {
    return failure ? <div className="card error-card">{failure}</div> : <p className="hint">Loading…</p>;
  }

  const entered = Object.keys(saved).length;
  const invalid = changed.filter((s) => rowErrors[s.student_id]).length;

  return (
    <>
      <div className="page-head">
        <Link to={`/assessments?class=${params.get('class') || assessment.class_id}`}>Back</Link>
        <h1>{assessment.title}</h1>
        <StatusPill status={assessment.status} />
      </div>

      <div className="budget-row">
        <span>{assessment.subject}</span>
        <span>Marked out of <b>{assessment.max_score}</b></span>
        <span><b>{entered}</b> of {roster.length} entered</span>
        {changed.length > 0 && <span><b>{changed.length}</b> unsaved</span>}
      </div>

      {failure && <div className="card error-card">{failure}</div>}
      {readOnly && <div className="notice">This assessment is locked. Marks can be viewed but not changed.</div>}
      {summary && (
        <div className="notice">
          Saved {summary.accepted}
          {summary.rejected > 0 && `, ${summary.rejected} rejected`}
          {summary.conflicted > 0 && `, ${summary.conflicted} changed by someone else`}.
        </div>
      )}

      <div className="table-wrap">
        <table className="score-table">
          <thead>
            <tr>
              <th>Adm. no</th><th>Student</th><th>Mark</th><th>%</th><th>State</th>
            </tr>
          </thead>
          <tbody>
            {roster.length === 0 && (
              <tr className="empty"><td colSpan={5}>No students are enrolled in this class.</td></tr>
            )}
            {roster.map((s, i) => {
              const draft = drafts[s.student_id] ?? '';
              const err = rowErrors[s.student_id];
              const note = rowNotes[s.student_id];
              const dirty = draft.trim() !== asText(saved[s.student_id]);
              const pct = !err && !isBlank(draft) ? normalize(Number(draft), assessment.max_score) : null;
              return (
                <tr key={s.student_id} className={err ? 'row-error' : dirty ? 'row-dirty' : ''}>
                  <td>{s.admission_no}</td>
                  <td>{s.first_name} {s.last_name}</td>
                  <td>
                    <input
                      ref={(el) => (inputs.current[i] = el)}
                      className="mark-input"
                      inputMode="decimal"
                      value={draft}
                      disabled={readOnly}
                      aria-invalid={Boolean(err)}
                      aria-label={`Mark for ${s.first_name} ${s.last_name}`}
                      onChange={(e) => edit(s.student_id, e.target.value)}
                      onKeyDown={(e) => nextOnEnter(e, i)}
                    />
                    <span className="hint"> / {assessment.max_score}</span>
                  </td>
                  <td>{pct === null ? '—' : `${pct}%`}</td>
                  <td>
                    {err ? <span className="error">{err}</span>
                      : note ? <span className="warn">{note}</span>
                      : dirty ? <span className="hint">Unsaved</span>
                      : saved[s.student_id] ? <span className="ok">Saved</span>
                      : <span className="hint">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div className="page-head">
          <button className="btn" type="button" onClick={save} disabled={saving || changed.length === invalid}>
            {saving ? 'Saving' : 'Save marks'}
          </button>
          {invalid > 0 && <span className="error">{invalid} mark{invalid === 1 ? '' : 's'} need fixing before they can be saved</span>}
        </div>
      )}
    </>
  );
}