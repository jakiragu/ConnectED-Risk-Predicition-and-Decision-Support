import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { validateAttendance } from '@gradebook/domain/attendance';
import { gql } from '../api/graphql.js';
import { useLatest } from '../api/useLatest.js';
import { GET_CLASS_ATTENDANCE, SUBMIT_ATTENDANCE } from '../api/calendarOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import { EmptyState, Info, Notice, Offline } from '../components/ui.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';

const PERIODS = [
  { value: 'MIDTERM', label: 'Start of term to Mid-term' },
  { value: 'ENDTERM', label: 'Mid-term to end of term' },
];
const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
const asText = (v) => (v == null ? '' : String(v));

/**
 * Attendance for one class and one attendance period. The school days of the
 * period come from the term's dates (Terms page). The class teacher enters,
 * per student, the days attended and the days of excused absence; absent days
 * and the percentage follow. Each saved entry carries its version, so a change
 * someone else made in the meantime is shown, not overwritten.
 */
export default function Attendance() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const { terms, defaultTermId } = useTerms(actor.schoolId);
  const classes = useLive(() => db().classes.toArray(), [], []);

  // Attendance is the class teacher's: they see only their own class; administrators choose any class.
  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort((a, b) => a.name.localeCompare(b.name)),
    [classes, isAdmin]
  );
  const requested = params.get('class');
  const classId = (requested && mine.some((c) => c.class_id === requested) ? requested : null) || mine[0]?.class_id || '';
  const termId = params.get('term') || defaultTermId;
  const period = params.get('period') === 'ENDTERM' ? 'ENDTERM' : 'MIDTERM';
  const go = (next) => setParams(Object.fromEntries(Object.entries({ class: classId, term: termId, period, ...next }).filter(([, v]) => v)));

  const [sheet, setSheet] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [notes, setNotes] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  // Why the class list may be empty: still loading, or the server refused (shown instead of "No class to record").
  const [classesLoaded, setClassesLoaded] = useState(false);
  const [classesError, setClassesError] = useState(null);
  const [find, setFind] = useState('');

  useEffect(() => {
    setClassesError(null);
    repository.loadClasses(actor.schoolId)
      .catch((e) => setClassesError(e.message))
      .finally(() => setClassesLoaded(true));
  }, [actor.schoolId]);

  const latest = useLatest();
  const load = useCallback(async () => {
    if (!classId || !termId) return;
    const n = latest.start();
    let s;
    try {
      ({ getClassAttendance: s } = await gql(GET_CLASS_ATTENDANCE, { school_id: actor.schoolId, class_id: classId, term_id: termId, period }));
    } catch (e) {
      if (latest.isLatest(n)) throw e;
      return;
    }
    if (!latest.isLatest(n)) return; // a newer class, term or period is on screen now
    setSheet(s);
    setDrafts(Object.fromEntries(s.students.map((st) => [st.student_id, {
      days_attended: asText(st.entry?.days_attended),
      days_excused: asText(st.entry?.days_excused ?? (st.entry ? 0 : '')),
    }])));
  }, [actor.schoolId, classId, termId, period, latest]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setNotes({});
    setSheet(null);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();

    return q
      ? (sheet?.students || []).filter((st) =>
          `${st.first_name} ${st.last_name} ${st.admission_no}`
            .toLowerCase()
            .includes(q)
        )
      : sheet?.students || [];
  }, [sheet, find]);

  const changed = useMemo(() => (sheet?.students || []).filter((st) => {
    const d = drafts[st.student_id];
    if (!d || d.days_attended === '') return false;
    return d.days_attended !== asText(st.entry?.days_attended) || (d.days_excused || '0') !== asText(st.entry?.days_excused ?? 0);
  }), [sheet, drafts]);

  const problems = useMemo(() => Object.fromEntries(changed.map((st) => {
    const d = drafts[st.student_id];
    const check = validateAttendance({ days_attended: Number(d.days_attended), days_excused: Number(d.days_excused || 0) }, sheet.school_days);
    return [st.student_id, check.ok ? null : check.reason];
  }).filter(([, v]) => v)), [changed, drafts, sheet]);

  const set = (id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const fillFull = () => setDrafts((d) => Object.fromEntries(Object.entries(d).map(([id, v]) => [id, v.days_attended === '' ? { days_attended: String(sheet.school_days), days_excused: '0' } : v])));

  async function save() {
    if (Object.keys(problems).length) {
      setError('Fix the highlighted rows first.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { submitAttendance: res } = await gql(SUBMIT_ATTENDANCE, {
        input: {
          school_id: actor.schoolId,
          class_id: classId,
          term_id: termId,
          period,
          entries: changed.map((st) => ({
            student_id: st.student_id,
            days_attended: Number(drafts[st.student_id].days_attended),
            days_excused: Number(drafts[st.student_id].days_excused || 0),
            _version: st.entry?._version ?? null,
          })),
        },
      });
      const rowNotes = Object.fromEntries(res.results.filter((r) => r.outcome !== 'APPLIED').map((r) => [r.student_id, r.reason]));
      await load();
      setNotes(rowNotes);
      setNotice(`${res.accepted} saved${res.rejected ? `, ${res.rejected} refused` : ''}${res.conflicted ? `, ${res.conflicted} changed by someone else (their entry is shown)` : ''}.`);
    } catch (e) {
      setError(e.message);
      await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  if (!online) return <Offline what="Recording attendance" />;
  if (!mine.length) {
    if (classesError) return <Notice tone="error">{classesError}</Notice>;
    if (!classesLoaded) return <p className="hint">Loading…</p>;
    return <EmptyState title="No class to record">Attendance is recorded by each class&apos;s class teacher.</EmptyState>;
  }

  const editable = Boolean(sheet?.can_edit);

  return (
    <>
      <div className="page-head">
        <h1>Attendance{!isAdmin && mine[0] ? `: ${mine[0].name}` : ''}</h1>
        <Info label="How attendance is recorded">
          Enter the days each student attended and the days excused in each period. Excused days are left out of the
          percentage. The figure for the school year so far is what the risk model uses at this checkpoint.
        </Info>
      </div>
      <div className="toolbar">
        {isAdmin && (
          <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
            options={mine.map((c) => ({ value: c.class_id, label: c.name }))} />
        )}
        <Select aria-label="Term" value={termId} onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))} />
        <Select aria-label="Period" value={period} onChange={(v) => go({ period: v })} options={PERIODS} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      {!sheet && !error && <p className="hint">Loading attendance…</p>}

      {sheet && (
        <>
          <div className="budget-row">
            <span>{sheet.class_name} · {sheet.term_name}</span>
            <span className="period-chip">{sheet.period_label}: {sheet.from} to {sheet.to} · <b>{sheet.school_days}</b> school days</span>
            {sheet.locked && <span className="pill locked">Locked: end-of-term results are published</span>}
          </div>

          <div className="table-wrap">
            <div className="toolbar table-tools attendance-tools">
              <div className="attendance-search">
                <input type="search" aria-label="Find a student" placeholder="Find a student by name or admission number" value={find} onChange={(e) => setFind(e.target.value)}/>
                {find.trim() && (
                  <span className="hint">
                    Showing {shown.length} of {sheet.students.length}
                  </span>
                )}
              </div>
              {editable && (
                <div className="budget-row">
                  <button type="button" className="btn secondary" onClick={fillFull}>Fill blanks with full attendance</button>
                </div>
              )}
            </div>
            <table className="attendance-table">
              <thead>
                <tr>
                  <th>Adm no</th><th>Student</th><th>Days attended</th><th>Days excused</th><th>Days absent</th>
                  <th>This period</th><th>School year so far</th><th>Saved by</th>
                </tr>
              </thead>
              <tbody>
                {sheet.students.length === 0 && (
                  <tr className="empty">
                    <td colSpan={8}>No students are enrolled in this class.</td>
                  </tr>
                )}

                {shown.length === 0 && sheet.students.length > 0 && (
                  <tr className="empty">
                    <td colSpan={8}>
                      No student matches “{find.trim()}”.
                    </td>
                  </tr>
                )}
                {shown.map((st) => {
                  const d = drafts[st.student_id] || { days_attended: '', days_excused: '' };
                  const problem = problems[st.student_id];
                  const note = notes[st.student_id];
                  const attended = Number(d.days_attended);
                  const excused = Number(d.days_excused || 0);
                  const filled = d.days_attended !== '';
                  const absent = filled ? Math.max(sheet.school_days - attended - excused, 0) : null;
                  const counted = sheet.school_days - excused;
                  const periodPct = filled && counted > 0 ? (attended / counted) * 100 : null;
                  const rowClass = problem ? 'row-error' : note ? 'row-conflict' : changed.includes(st) ? 'row-dirty' : '';
                  return (
                    <tr key={st.student_id} className={rowClass}>
                      <td>{st.admission_no}</td>
                      <td><Link to={`/classes/${classId}/students`}>{st.first_name} {st.last_name}</Link></td>
                      <td>
                        <input type="number" min="0" max={sheet.school_days} value={d.days_attended} disabled={!editable}
                          aria-label={`Days attended by ${st.first_name}`} 
                          onChange={(e) => {
                            const attended = e.target.value;
                            set(st.student_id, {
                              days_attended: attended,
                              ...(attended !== '' && d.days_excused === ''
                                ? { days_excused: '0' }
                                : {}),
                            });
                          }} />
                      </td>
                      <td>
                        <input type="number" min="0" max={sheet.school_days} value={d.days_excused} disabled={!editable}
                          aria-label={`Days excused for ${st.first_name}`} onChange={(e) => set(st.student_id, { days_excused: e.target.value })} />
                        {(problem || note) && <div className="error">{problem || note}</div>}
                      </td>
                      <td>{absent ?? '—'}</td>
                      <td>{pct(periodPct)}</td>
                      <td>
                        {pct(st.year_to_date)}
                        {st.year_to_date_missing > 0 && <span className="hint"> ({st.year_to_date_missing} period{st.year_to_date_missing === 1 ? '' : 's'} not entered)</span>}
                      </td>
                      <td className="hint">{st.entry?.recorded_by_name || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {editable && (
            <div className="budget-row">
              <button type="button" className="btn" disabled={saving || !changed.length} onClick={save}>
                {saving ? 'Saving' : `Save attendance${changed.length ? ` (${changed.length})` : ''}`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}