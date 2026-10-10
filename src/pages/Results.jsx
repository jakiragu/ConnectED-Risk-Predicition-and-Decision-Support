import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CHECKPOINTS, CHECKPOINT_LABEL, SEVERITY } from '@gradebook/domain/results';
import { gql } from '../api/graphql.js';
import {
  CALCULATE_SCHOOL_RESULTS,
  CALCULATE_TERM_RESULTS,
  GET_CLASS_ROSTER,
  GET_TERM_RESULTS,
  LIST_CHECKPOINT_STATUS,
  LIST_RESULT_SETS,
  PUBLISH_RESULTS,
  PUBLISH_SCHOOL_RESULTS,
} from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';

const POLL_MS = 3000;
const IN_FLIGHT = new Set(['PENDING', 'RUNNING']);

const fmt = (n) => (n === null || n === undefined ? '—' : n.toFixed(2));
const blockingOf = (set) => (set?.issues || []).filter((i) => i.severity === SEVERITY.BLOCKING);
const warningsOf = (set) => (set?.issues || []).filter((i) => i.severity === SEVERITY.WARNING);
const publishable = (set) => set?.status === 'CALCULATED' && !set.blocking;
const MARK_TEXT = { ABSENT: 'ABS', NOT_ASSESSED: 'NA', MISSING: '—' };
const paperMark = (p) => (p.mark_status === 'SCORED' ? `${p.raw_score}/${p.max_score}` : MARK_TEXT[p.mark_status] || '—');

function ReportCards({ set }) {
  if (set?.status !== 'PUBLISHED' || !set.report_cards_status) return null;
  const { report_cards_status: status, report_cards_generated: done, report_cards_expected: total } = set;
  const text = {
    PENDING: 'Report cards are queued',
    RUNNING: `Producing report cards: ${done} of ${total}`,
    COMPLETE: `${done} report card${done === 1 ? '' : 's'} produced`,
    FAILED: `Report cards failed after ${done} of ${total}${set.report_error ? `: ${set.report_error}` : ''}`,
  }[status];
  return <span className={`budget ${status === 'FAILED' ? 'warn' : ''}`}>{text}</span>;
}

function Issues({ set }) {
  const blocking = blockingOf(set);
  const warnings = warningsOf(set);
  if (!blocking.length && !warnings.length) return null;
  return (
    <div className="card issues">
      {blocking.length > 0 && <h3>Must be fixed before publishing</h3>}
      {blocking.map((i, n) => <div key={`b${n}`} className="issue blocking">{i.message}</div>)}
      {warnings.length > 0 && <h3>Check before publishing</h3>}
      {warnings.map((i, n) => <div key={`w${n}`} className="issue warning">{i.message}</div>)}
    </div>
  );
}

/** Every class for one term + checkpoint: Admin/Head Teacher calculate and publish many at once. */
function SchoolPanel({ schoolId, termId, checkpoint, onOpen, refreshKey, onChanged }) {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [outcomes, setOutcomes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const { listCheckpointStatus } = await gql(LIST_CHECKPOINT_STATUS, { school_id: schoolId, term_id: termId, checkpoint });
    setRows(listCheckpointStatus);
    return listCheckpointStatus;
  }, [schoolId, termId, checkpoint]);

  useEffect(() => {
    setOutcomes(null);
    setError(null);
    load()
      .then((list) => setSelected(new Set(list.map((r) => r.class_id)))) // all classes selected by default
      .catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (refreshKey) load().catch(() => {});
  }, [refreshKey, load]);

  useEffect(() => {
    if (!rows.some((r) => IN_FLIGHT.has(r.result_set.report_cards_status))) return undefined;
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [rows, load]);

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const chosen = rows.filter((r) => selected.has(r.class_id));
  const ready = chosen.filter((r) => publishable(r.result_set));

  async function run(mutation, input) {
    setBusy(true);
    setError(null);
    try {
      const data = await gql(mutation, { input });
      setOutcomes(Object.values(data)[0]);
    } catch (e) {
      setError(e.message);
    } finally {
      await load().catch(() => {});
      onChanged();
      setBusy(false);
    }
  }

  const calculate = () =>
    run(CALCULATE_SCHOOL_RESULTS, { school_id: schoolId, term_id: termId, checkpoint, class_ids: chosen.map((r) => r.class_id) });
  function publish() {
    const label = CHECKPOINT_LABEL[checkpoint];
    const skipped = chosen.length - ready.length;
    const message =
      `Publish ${label} results for ${ready.length} class${ready.length === 1 ? '' : 'es'}?` +
      (skipped ? `\n\n${skipped} selected class${skipped === 1 ? ' is' : 'es are'} not ready and will be skipped.` : '') +
      '\n\nPublished marks are locked and report cards are produced for every student.';
    if (!window.confirm(message)) return;
    run(PUBLISH_SCHOOL_RESULTS, {
      school_id: schoolId,
      term_id: termId,
      checkpoint,
      classes: ready.map((r) => ({ class_id: r.class_id, _version: r.result_set._version })),
    });
  }

  const outcomeFor = (id) => outcomes?.find((o) => o.class_id === id);

  return (
    <div className="card">
      <div className="weights-head">
        <h2>{CHECKPOINT_LABEL[checkpoint]}: whole school</h2>
        <span className="hint">All classes are selected. Untick any class you do not want to include.</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all classes"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={(e) => setSelected(new Set(e.target.checked ? rows.map((r) => r.class_id) : []))}
                />
              </th>
              <th>Class</th><th>Status</th><th>Students</th><th>Problems</th><th>Report cards</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const set = r.result_set;
              const blocking = blockingOf(set);
              const outcome = outcomeFor(r.class_id);
              return (
                <tr key={r.class_id}>
                  <td>
                    <input type="checkbox" aria-label={`Include ${r.class_name}`}
                      checked={selected.has(r.class_id)} onChange={() => toggle(r.class_id)} />
                  </td>
                  <td>{r.class_name}</td>
                  <td><StatusPill status={set.status} /></td>
                  <td>{set.student_count || '—'}</td>
                  <td>
                    {outcome && !outcome.ok && <div className="issue blocking">{outcome.message}</div>}
                    {!outcome && blocking.length > 0 && (
                      <div className="issue blocking">
                        {blocking[0].message}{blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ''}
                      </div>
                    )}
                    {!outcome && !blocking.length && warningsOf(set).length > 0 && (
                      <span className="hint warn">{warningsOf(set).length} warning{warningsOf(set).length === 1 ? '' : 's'}</span>
                    )}
                    {outcome?.ok && <span className="hint">Done</span>}
                  </td>
                  <td><ReportCards set={set} /></td>
                  <td className="actions">
                    <button type="button" className="btn link" onClick={() => onOpen(r.class_id)}>Review</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="budget-row">
        <button type="button" className="btn secondary" disabled={busy || !chosen.length} onClick={calculate}>
          {busy ? 'Working' : `Calculate ${chosen.length} class${chosen.length === 1 ? '' : 'es'}`}
        </button>
        <button type="button" className="btn" disabled={busy || !ready.length} onClick={publish}>
          {`Publish ${ready.length} class${ready.length === 1 ? '' : 'es'}`}
        </button>
        {chosen.length > ready.length && (
          <span className="hint">{chosen.length - ready.length} selected not ready to publish (not calculated, blocked or already published)</span>
        )}
      </div>
    </div>
  );
}

function ResultsTable({ rows, roster, set, subject }) {
  const final = set.kind === 'FINAL';
  const subjects = subject ? set.subjects.filter((s) => s === subject) : set.subjects;
  const byStudent = new Map(rows.map((r) => [r.student_id, r]));
  const label = CHECKPOINT_LABEL[set.checkpoint];

  // One subject: show each paper's mark, then the exam (and term) result.
  const papers = subject
    ? (rows.find((r) => r.subjects.some((s) => s.subject === subject && s.papers.length))?.subjects
        .find((s) => s.subject === subject)?.papers || [])
    : [];

  const cell = (r, name) => {
    const s = r?.subjects.find((x) => x.subject === name);
    if (!s) return '—';
    if (final) return s.term?.term_score === null || s.term?.term_score === undefined
      ? '—'
      : <>{fmt(s.term.term_score)} <b>{s.term.grade}</b></>;
    if (s.score === null) return '—';
    return <>{fmt(s.score)}%{s.covered < 100 && <span className="hint"> ({s.covered}% sat)</span>}</>;
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Adm no</th><th>Student</th>
            {subject
              ? <>
                  {papers.map((p) => <th key={p.assessment_id}>Paper {p.paper_no ?? '—'} ({p.weight}%)</th>)}
                  <th>{label} exam</th>
                  {final && <><th>Opener</th><th>Mid-term</th><th>Term score</th><th>Grade</th></>}
                </>
              : <>
                  {subjects.map((s) => <th key={s}>{s}</th>)}
                  <th>{final ? 'Term average' : `${label} average`}</th>
                </>}
          </tr>
        </thead>
        <tbody>
          {roster.map((st) => {
            const r = byStudent.get(st.student_id);
            const s = subject ? r?.subjects.find((x) => x.subject === subject) : null;
            const comp = (c) => s?.term?.components.find((x) => x.checkpoint === c)?.score;
            return (
              <tr key={st.student_id}>
                <td>{st.admission_no}</td>
                <td>{st.first_name} {st.last_name}</td>
                {subject
                  ? <>
                      {papers.map((p) => {
                        const mine = s?.papers.find((x) => x.assessment_id === p.assessment_id);
                        return <td key={p.assessment_id}>{mine ? paperMark(mine) : '—'}</td>;
                      })}
                      <td>{s?.score === null || s?.score === undefined ? '—' : `${fmt(s.score)}%`}</td>
                      {final && (
                        <>
                          <td>{comp('OPENER') == null ? '—' : `${fmt(comp('OPENER'))}%`}</td>
                          <td>{comp('MIDTERM') == null ? '—' : `${fmt(comp('MIDTERM'))}%`}</td>
                          <td>{fmt(s?.term?.term_score)}</td>
                          <td><b>{s?.term?.grade || '—'}</b></td>
                        </>
                      )}
                    </>
                  : <>
                      {subjects.map((name) => <td key={name}>{r ? cell(r, name) : '—'}</td>)}
                      <td>
                        {final
                          ? <>{fmt(r?.term_average)} <b>{r?.term_grade || ''}</b></>
                          : r?.checkpoint_average == null ? '—' : `${fmt(r.checkpoint_average)}%`}
                      </td>
                    </>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Results() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const reviewer = actor.groups.includes('Admin') || actor.groups.includes('Head Teacher');
  const { terms, defaultTermId } = useTerms(actor.schoolId);

  const termId = params.get('term') || defaultTermId;
  const checkpoint = CHECKPOINTS.includes(params.get('cp')) ? params.get('cp') : 'OPENER';
  const classId = params.get('class') || '';
  const subject = params.get('subject') || '';
  const go = (next) => {
    const merged = { term: termId, cp: checkpoint, class: classId, subject, ...next };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, v]) => v)));
  };

  const classes = useLive(() => db().classes.toArray(), [], []);
  const sortedClasses = useMemo(() => [...classes].sort((a, b) => a.name.localeCompare(b.name)), [classes]);
  const [sets, setSets] = useState([]);
  const [rows, setRows] = useState([]);
  const [roster, setRoster] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [schoolRefresh, setSchoolRefresh] = useState(0);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setError(e.message));
  }, [actor.schoolId]);

  useEffect(() => {
    if (!classId && !reviewer && sortedClasses.length) go({ class: sortedClasses[0].class_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, reviewer, sortedClasses]);

  const set = sets.find((s) => s.checkpoint === checkpoint) || null;

  const load = useCallback(async () => {
    if (!classId || !termId) return;
    const [{ listResultSets }, { getTermResults }, { getClassRoster }] = await Promise.all([
      gql(LIST_RESULT_SETS, { school_id: actor.schoolId, class_id: classId, term_id: termId }),
      gql(GET_TERM_RESULTS, { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint }),
      gql(GET_CLASS_ROSTER, { school_id: actor.schoolId, class_id: classId }),
    ]);
    setSets(listResultSets);
    setRows(getTermResults);
    setRoster(getClassRoster);
  }, [actor.schoolId, classId, termId, checkpoint]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setSets([]);
    setRows([]);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  useEffect(() => {
    if (!IN_FLIGHT.has(set?.report_cards_status)) return undefined;
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [set?.report_cards_status, load]);

  async function act(mutation, input, done) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await gql(mutation, { input });
      setNotice(done(Object.values(data)[0]));
    } catch (e) {
      setError(e.message);
    } finally {
      // Like the assessment form: after a conflict or a refusal, show what the server now holds.
      await load().catch(() => {});
      setSchoolRefresh((n) => n + 1);
      setBusy(false);
    }
  }

  const scope = { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint };
  const calculate = () =>
    act(CALCULATE_TERM_RESULTS, scope, (s) =>
      s.blocking ? 'Calculated. Fix the problems below before publishing.' : 'Calculated. Review the results, then publish.');
  function publish() {
    const label = CHECKPOINT_LABEL[checkpoint];
    const finalNote = checkpoint === 'ENDTERM'
      ? '\n\nThis is the official end of term result. The term is locked for this class afterwards.'
      : '';
    if (!window.confirm(`Publish ${label} results for ${className}? Marks for these papers are locked.${finalNote}`)) return;
    act(PUBLISH_RESULTS, { ...scope, _version: set._version }, (s) =>
      `Published. Report cards: ${s.report_cards_generated} of ${s.report_cards_expected} produced so far.`);
  }

  const className = classes.find((c) => c.class_id === classId)?.name || '';
  const subjects = set?.subjects || [];
  const final = checkpoint === 'ENDTERM';
  const weights = set?.checkpoint_weights;

  return (
    <>
      <div className="page-head">
        <h1>Results</h1>
        <Select aria-label="Term" value={termId} onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))} placeholder="Choose a term" style={{ width: 180 }} />
      </div>

      {!online && <div className="notice">Results need a connection.</div>}

      <div className="segmented" role="tablist" aria-label="Checkpoint">
        {CHECKPOINTS.map((c) => {
          const s = sets.find((x) => x.checkpoint === c);
          return (
            <button key={c} type="button" role="tab" aria-selected={c === checkpoint}
              className={`seg ${c === checkpoint ? 'active' : ''}`} onClick={() => go({ cp: c })}>
              <span>{CHECKPOINT_LABEL[c]}</span>
              {classId && s && <StatusPill status={s.status} />}
            </button>
          );
        })}
      </div>

      {reviewer && online && termId && (
        <SchoolPanel
          schoolId={actor.schoolId}
          termId={termId}
          checkpoint={checkpoint}
          refreshKey={schoolRefresh}
          onChanged={() => load().catch(() => {})}
          onOpen={(id) => go({ class: id, subject: '' })}
        />
      )}

      <div className="page-head">
        <h2>{className ? `${className}: ${CHECKPOINT_LABEL[checkpoint]}` : 'Class results'}</h2>
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v, subject: '' })}
          options={sortedClasses.map((c) => ({ value: c.class_id, label: c.name }))} placeholder="Choose a class" style={{ width: 200 }} />
        {classId && (
          <Select aria-label="Subject" value={subject} onChange={(v) => go({ subject: v })}
            options={[{ value: '', label: 'All subjects' }, ...subjects.map((s) => ({ value: s, label: s }))]}
            style={{ width: 180 }} />
        )}
      </div>

      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {classId && set && (
        <>
          <div className="budget-row">
            <StatusPill status={set.status} />
            {set.status !== 'NOT_CALCULATED' && set.status !== 'UNPUBLISHED' && (
              <span>{set.student_count} students · {set.assessment_count} papers</span>
            )}
            {final && weights && (
              <span>Term result = Opener {weights.OPENER}% + Mid-term {weights.MIDTERM}% + End of term {weights.ENDTERM}%</span>
            )}
            <ReportCards set={set} />
            {reviewer && set.status !== 'PUBLISHED' && (
              <button type="button" className="btn secondary" disabled={busy || !online} onClick={calculate}>
                {set.status === 'CALCULATED' ? 'Recalculate' : 'Calculate'}
              </button>
            )}
            {reviewer && set.status === 'CALCULATED' && (
              <button type="button" className="btn" disabled={busy || !online || set.blocking} onClick={publish}
                title={set.blocking ? 'Fix the problems below first' : undefined}>
                Publish
              </button>
            )}
            {reviewer && set.status === 'PUBLISHED' && ['PENDING', 'FAILED'].includes(set.report_cards_status) && (
              <button type="button" className="btn secondary" disabled={busy || !online}
                // Publishing again is idempotent: it resumes the event and the report cards.
                // The published set's version is one past the version that was published.
                onClick={() => act(PUBLISH_RESULTS, { ...scope, _version: set._version - 1 }, () => 'Report cards restarted.')}>
                Retry report cards
              </button>
            )}
          </div>

          {reviewer && <Issues set={set} />}

          {set.status === 'UNPUBLISHED' || (set.status === 'NOT_CALCULATED' && !reviewer) ? (
            <div className="notice">{CHECKPOINT_LABEL[checkpoint]} results for {className} have not been published yet.</div>
          ) : set.status === 'NOT_CALCULATED' ? (
            <div className="notice">Not calculated yet. Calculate to review {CHECKPOINT_LABEL[checkpoint]} results for {className}.</div>
          ) : rows.length > 0 ? (
            <>
              <div className="notice">
                {final
                  ? 'Official end of term results: each subject combines its checkpoint exams by the weights above.'
                  : `Provisional ${CHECKPOINT_LABEL[checkpoint]} exam results. Each subject's papers make up 100% of this exam. ` +
                    'This is not the term result, and no grade is given.'}
                {set.status === 'CALCULATED' && ' Not yet published.'}
              </div>
              <ResultsTable rows={rows} roster={roster} set={set} subject={subject} />
            </>
          ) : null}
        </>
      )}
    </>
  );
}