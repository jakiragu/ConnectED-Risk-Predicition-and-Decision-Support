import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { validateAttendance } from '@gradebook/domain/attendance';
import { gql } from '../api/graphql.js';
import { GET_CLASS_ATTENDANCE, SUBMIT_ATTENDANCE } from '../api/calendarOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';
import '../styles/calendar.css';

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

  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher || (c.my_subjects || []).length).sort((a, b) => a.name.localeCompare(b.name)),
    [classes, isAdmin]
  );
  const classId = params.get('class') || classes.find((c) => c.is_class_teacher)?.class_id || mine[0]?.class_id || '';
  const termId = params.get('term') || defaultTermId;
  const period = params.get('period') === 'ENDTERM' ? 'ENDTERM' : 'MIDTERM';
  const go = (next) => setParams(Object.fromEntries(Object.entries({ class: classId, term: termId, period, ...next }).filter(([, v]) => v)));

  const [sheet, setSheet] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [notes, setNotes] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    if (!classId || !termId) return;
    const { getClassAttendance: s } = await gql(GET_CLASS_ATTENDANCE, { school_id: actor.schoolId, class_id: classId, term_id: termId, period });
    setSheet(s);
    setDrafts(Object.fromEntries(s.students.map((st) => [st.student_id, {
      days_attended: asText(st.entry?.days_attended),
      days_excused: asText(st.entry?.days_excused ?? (st.entry ? 0 : '')),
    }])));
  }, [actor.schoolId, classId, termId, period]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setNotes({});
    setSheet(null);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

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

  if (!online) return <div className="notice">Recording attendance needs a connection.</div>;
  if (!mine.length) return <div className="notice">You are not assigned to any class yet.</div>;

  const editable = Boolean(sheet?.can_edit);

  return (
    <>
      <div className="page-head">
        <h1>Attendance</h1>
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
          options={mine.map((c) => ({ value: c.class_id, label: c.name }))} style={{ width: 190 }} />
        <Select aria-label="Term" value={termId} onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))} style={{ width: 160 }} />
        <Select aria-label="Period" value={period} onChange={(v) => go({ period: v })} options={PERIODS} style={{ width: 230 }} />
      </div>

      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {sheet && (
        <>
          <div className="budget-row">
            <span>{sheet.class_name} · {sheet.term_name}</span>
            <span className="period-chip">{sheet.period_label}: {sheet.from} to {sheet.to} · <b>{sheet.school_days}</b> school days</span>
            {sheet.locked && <span className="warn">Locked: End of term results are published</span>}
            {!editable && !sheet.locked && <span className="hint">Only the class teacher or an administrator can record attendance.</span>}
          </div>

          {editable && (
            <div className="budget-row">
              <button type="button" className="btn secondary" onClick={fillFull}>Fill blanks with full attendance</button>
              <span className="hint">Then lower the days for students who missed school. Excused days are left out of the percentage.</span>
            </div>
          )}

          <div className="table-wrap">
            <table className="attendance-table">
              <thead>
                <tr>
                  <th>Adm no</th><th>Student</th><th>Days attended</th><th>Days excused</th><th>Days absent</th>
                  <th>This period</th><th>School year so far</th><th>Saved by</th>
                </tr>
              </thead>
              <tbody>
                {sheet.students.map((st) => {
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
                          aria-label={`Days attended by ${st.first_name}`} onChange={(e) => set(st.student_id, { days_attended: e.target.value })} />
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
              <span className="hint">School year so far is the figure the risk model uses at this checkpoint.</span>
            </div>
          )}
        </>
      )}
    </>
  );
}