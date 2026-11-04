import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { todayIn } from '@gradebook/domain/calendar';
import { FACTORS, FREQUENCY_LABEL, INTERVENTION_STATUS, methodKey, validateIntervention } from '@gradebook/domain/decision';
import { ulid } from '@gradebook/domain/ids';
import { targetText } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { InterventionEditor, MethodSuggestions } from '../components/InterventionEditor.jsx';
import { ActionIcon, EmptyState, Notice } from '../components/ui.jsx';

const today = () => todayIn('Africa/Nairobi');
const fullName = (s) => `${s.first_name} ${s.last_name}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One intervention for several flagged students at once (FR-12). It saves an
 * ordinary intervention for each student, exactly as if it had been logged on
 * each student's own form: each is linked to that student's latest estimate and
 * target, and can be stopped or changed for one student without touching the
 * others. Students the teacher may not log this subject for, or who already
 * have the same intervention under way, are left out and say why. Works offline
 * through the same device queue as the one-student form.
 *
 * The students come from the dashboard as ?students=id,id so the page survives
 * a reload; their details come from the dashboard's saved copy.
 */
export default function BulkInterventionForm() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { actor } = useAuth();
  const { online } = useSync();
  const back = location.state?.from || '/dashboard';
  const ids = useMemo(() => [...new Set((params.get('students') || '').split(',').filter(Boolean))], [params]);

  const [dash, setDash] = useState(undefined);
  const [removed, setRemoved] = useState(() => new Set());
  const [draft, setDraft] = useState(null);
  const [methods, setMethods] = useState([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const methodRef = useRef(null);
  // Interventions already on this device for these students, including ones not sent yet.
  const local = useLive(() => db().interventions.where('student_id').anyOf(ids).toArray(), [ids.join(',')], []);

  useEffect(() => {
    repository.loadDashboard(actor.schoolId).then((v) => setDash(v.data ?? null)).catch(() => setDash(null));
  }, [actor.schoolId, online]);

  const chosen = useMemo(() => {
    const byId = new Map((dash?.at_risk_students || []).map((c) => [c.student.student_id, c]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }, [dash, ids]);
  const people = chosen.filter((c) => !removed.has(c.student.student_id));
  const missing = dash ? ids.length - chosen.length : 0;

  // Older saved copies of the dashboard have no factors: offer every factor and let the server decide.
  const factorsOf = (c) => c.factors ?? FACTORS;
  const factors = useMemo(() => {
    const allowed = new Map();
    const targeted = new Map();
    for (const c of people) {
      for (const f of factorsOf(c)) allowed.set(f, (allowed.get(f) || 0) + 1);
      for (const t of c.targets) targeted.set(t.group, (targeted.get(t.group) || 0) + 1);
    }
    return [...allowed.keys()].sort((a, b) => (targeted.get(b) || 0) - (targeted.get(a) || 0)
      || allowed.get(b) - allowed.get(a) || a.localeCompare(b))
      .map((f) => ({ factor: f, students: allowed.get(f) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people.map((c) => c.student.student_id).join(',')]);

  useEffect(() => {
    if (!draft && factors.length) {
      setDraft({ factor: factors[0].factor, method: '', frequency: 'WEEKLY', started_on: today(), expected_outcome: '', notes: '' });
    }
  }, [draft, factors]);

  useEffect(() => {
    if (!draft?.factor) return;
    repository.loadMethods(actor.schoolId, draft.factor).then((v) => setMethods(v.data || []));
  }, [actor.schoolId, draft?.factor, online]);

  // What happens for each student with the form as it is now.
  const plan = useMemo(() => {
    if (!draft) return [];
    const key = methodKey(draft.method);
    const ongoing = [
      ...(dash?.ongoing_interventions || []),
      ...local.filter((i) => i.status === INTERVENTION_STATUS.ONGOING && i._pending !== 'DELETE'),
    ];
    return people.map((c) => {
      const s = c.student;
      if (!factorsOf(c).includes(draft.factor)) {
        return { c, ok: false, reason: `You don’t teach ${draft.factor} in ${s.class_name}` };
      }
      const already = key && ongoing.some((i) => i.student_id === s.student_id && i.factor === draft.factor && methodKey(i.method) === key);
      if (already) return { c, ok: false, reason: 'Already has this under way' };
      return { c, ok: true };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, draft, dash, local]);
  const included = plan.filter((p) => p.ok);

  async function save(e) {
    e.preventDefault();
    const base = {
      school_id: actor.schoolId, factor: draft.factor, method: draft.method, frequency: draft.frequency,
      status: INTERVENTION_STATUS.ONGOING, started_on: draft.started_on, stopped_on: null,
      expected_outcome: draft.expected_outcome || null, notes: draft.notes || null,
    };
    const checked = validateIntervention(base);
    if (!checked.ok) { setError(checked.reason); return; }
    if (!included.length) { setError('No selected student can receive this intervention. Change the subject or the students.'); return; }
    setError(null);
    const out = [];
    for (const { c } of included) {
      const input = { ...base, student_id: c.student.student_id, intervention_id: ulid() };
      await repository.saveIntervention(input, actor);
      out.push({ id: input.intervention_id, student: c.student });
    }
    setSaved({ items: out, left: plan.filter((p) => !p.ok), draft: { ...draft } });
  }

  if (!ids.length) {
    return (
      <EmptyState title="No students chosen" action={<Link className="btn" to="/dashboard">Go to the dashboard</Link>}>
        Tick the students flagged at risk on the dashboard, then choose “Log an intervention”.
      </EmptyState>
    );
  }
  if (dash === undefined) return <div className="hint">Loading…</div>;
  if (dash === null) return <Notice tone="warn">The students could not be loaded, and there is no copy saved on this device yet.</Notice>;

  if (saved) return <Saved saved={saved} online={online} back={back} onAgain={() => { setSaved(null); setDraft({ ...draft, method: '' }); }} />;

  if (!people.length) {
    return (
      <EmptyState title="No students left" action={<Link className="btn" to={back}>Back to the dashboard</Link>}>
        {missing ? 'The students you chose are no longer flagged at risk, or are not in your classes.' : 'You removed every student from this intervention.'}
      </EmptyState>
    );
  }
  if (!draft) return <div className="hint">Loading…</div>;

  const use = (method) => { setDraft({ ...draft, method }); methodRef.current?.focus(); };
  const factorNote = (f) => {
    const n = factors.find((x) => x.factor === f)?.students ?? 0;
    return n < people.length ? `${f} (${n} of ${people.length})` : f;
  };

  return (
    <div className="stack">
      <Link to={back}>Back to the dashboard</Link>
      <div className="form-split">
        <form className="stack" onSubmit={save}>
          <section className="card stack">
            <div className="stack tight">
              <h1>Log an intervention</h1>
              <span className="hint">
                Each student gets their own record, linked to their own latest risk estimate, so you can stop or change it for one
                student later without affecting the others. Which intervention to use is your decision.
              </span>
            </div>
            {missing > 0 && (
              <Notice>{plural(missing, 'student')} you chose {missing === 1 ? 'is' : 'are'} no longer flagged at risk or not in your classes, so {missing === 1 ? 'is' : 'are'} left out.</Notice>
            )}
            <div className="table-wrap bordered">
              <table className="bulk-students">
                <thead>
                  <tr><th>Student</th><th>Target for {draft.factor}</th><th>Will it be logged?</th><th><span className="sr-only">Remove</span></th></tr>
                </thead>
                <tbody>
                  {plan.map(({ c, ok, reason }) => {
                    const s = c.student;
                    const target = c.targets.find((t) => t.group === draft.factor);
                    return (
                      <tr key={s.student_id} className={ok ? '' : 'left-out'}>
                        <td>
                          <b>{fullName(s)}</b>
                          <div className="hint">{s.admission_no} · {s.class_name}</div>
                        </td>
                        <td>{target ? <span className="chip target">{targetText(target)}</span> : <span className="hint">No target for {draft.factor}</span>}</td>
                        <td>{ok ? <span className="pill recorded"><ActionIcon name="check" />Yes</span> : <span className="hint warn">{reason}</span>}</td>
                        <td className="actions">
                          <button type="button" className="btn link icon-only" aria-label={`Remove ${fullName(s)}`} title="Remove from this intervention"
                            onClick={() => setRemoved(new Set([...removed, s.student_id]))}
                          >
                            <ActionIcon name="x" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card stack">
            <h2>The intervention</h2>
            <InterventionEditor value={draft} onChange={setDraft} factors={factors.map((f) => f.factor)} factorNote={factorNote}
              idPrefix="bulk" methodRef={methodRef} />
            {error && <div className="warn" role="alert">{error}</div>}
            <div className="actions row">
              <button type="submit" className="btn primary" disabled={!included.length}>
                {included.length ? `Save for ${plural(included.length, 'student')}` : 'No students to save for'}
              </button>
              {included.length < plan.length && (
                <span className="hint">{plural(plan.length - included.length, 'student')} left out; the reason is shown beside each.</span>
              )}
              {!online && <span className="hint">You are offline; they are kept on this device and sent when you reconnect.</span>}
            </div>
          </section>
        </form>

        <MethodSuggestions factor={draft.factor} methods={methods} search={search} onSearch={setSearch} current={draft.method} onUse={use} />
      </div>
    </div>
  );
}

/** After saving: each student's record as it reaches the server, with a way to fix any that were refused. */
function Saved({ saved, online, back, onAgain }) {
  const ids = saved.items.map((i) => i.id);
  const rows = useLive(() => db().interventions.bulkGet(ids), [ids.join(',')], []);
  const byId = new Map(rows.filter(Boolean).map((r) => [r.intervention_id, r]));
  const state = (id) => {
    const r = byId.get(id);
    if (!r || r._pending === 'DELETE') return 'gone';
    if (r._failed) return 'failed';
    if (r._pending) return 'sending';
    return 'saved';
  };
  const counts = saved.items.reduce((m, i) => ({ ...m, [state(i.id)]: (m[state(i.id)] || 0) + 1 }), {});
  const d = saved.draft;

  return (
    <div className="stack">
      <Link to={back}>Back to the dashboard</Link>
      <section className="card stack" aria-live="polite">
        <div className="stack tight">
          <h1>Logged for {plural(saved.items.length, 'student')}</h1>
          <span className="hint">{d.method} · {d.factor} · {FREQUENCY_LABEL[d.frequency]} from {d.started_on}</span>
        </div>
        {counts.failed > 0 && (
          <Notice tone="warn">{plural(counts.failed, 'record')} could not be saved. Open the student to see why and fix or discard it.</Notice>
        )}
        {counts.sending > 0 && !counts.failed && (
          <span className="hint">{online ? 'Sending…' : 'Saved on this device. They are sent when you reconnect.'}</span>
        )}
        <div className="table-wrap bordered">
          <table>
            <thead><tr><th>Student</th><th>Status</th><th><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {saved.items.map(({ id, student: s }) => {
                const st = state(id);
                const r = byId.get(id);
                return (
                  <tr key={id}>
                    <td><b>{fullName(s)}</b><div className="hint">{s.admission_no} · {s.class_name}</div></td>
                    <td>
                      {st === 'saved' && <span className="pill recorded"><ActionIcon name="check" />Saved</span>}
                      {st === 'sending' && <span className="pill recording">{online ? 'Sending' : 'Waiting to send'}</span>}
                      {st === 'failed' && <><span className="pill unrecorded">Not saved</span><div className="hint">{r._failed}</div></>}
                      {st === 'gone' && <span className="pill neutral">Removed</span>}
                    </td>
                    <td className="actions">
                      <Link to={`/students/${s.student_id}/interventions`} state={{ from: back }}>
                        {st === 'failed' ? 'Fix' : 'View interventions'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {saved.left.length > 0 && (
          <span className="hint">
            Not logged for {saved.left.map((p) => `${fullName(p.c.student)} (${p.reason.charAt(0).toLowerCase()}${p.reason.slice(1)})`).join(', ')}.
          </span>
        )}
        <div className="row">
          <Link className="btn" to={back}>Done</Link>
          <button type="button" className="btn secondary" onClick={onAgain}>Log another for these students</button>
        </div>
      </section>
    </div>
  );
}
