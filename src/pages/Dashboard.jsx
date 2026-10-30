import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FREQUENCY_LABEL } from '@gradebook/domain/decision';
import { targetText } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { Sparkline } from '../components/ui.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

/**
 * Where a teacher starts: their classes, the students the model flags, the
 * interventions under way and the papers still to be marked. A subject teacher
 * sees their own subjects' targets and interventions; the class teacher and
 * administrators see every subject and attendance. Flags are decision-support
 * signals from the risk model, not judgements about students.
 */
export default function Dashboard() {
  const { actor, isAdmin, displayName } = useAuth();
  const { online } = useSync();
  const [view, setView] = useState({ data: null, savedAt: null, fromDevice: false });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const classes = useLive(() => db().classes.toArray(), [], []);
  const students = useLive(() => db().students.toArray(), [], []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    repository.loadDashboard(actor.schoolId).then((v) => live && setView(v)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [actor.schoolId, online]);

  // Rosters of the teacher's classes, for finding any student (kept on this device).
  useEffect(() => {
    repository.loadClasses(actor.schoolId).then(async () => {
      for (const c of await db().classes.toArray()) await repository.loadRoster(actor.schoolId, c.class_id);
    });
  }, [actor.schoolId]);

  const className = useMemo(() => new Map(classes.map((c) => [c.class_id, c.name])), [classes]);
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return students
      .filter((s) => `${s.first_name} ${s.last_name} ${s.admission_no}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, students]);

  const d = view.data;
  const byFrequency = useMemo(() => {
    const groups = new Map();
    for (const i of d?.ongoing_interventions || []) groups.set(i.frequency, [...(groups.get(i.frequency) || []), i]);
    return ['DAILY', 'WEEKLY', 'MONTHLY', 'ONCE'].filter((f) => groups.has(f)).map((f) => [f, groups.get(f)]);
  }, [d]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Hello, {displayName}</h1>
        {d?.term_name && <span className="hint">{d.term_name}</span>}
      </div>
      {view.fromDevice && <div className="notice">You are offline. This is the copy saved on this device at {when(view.savedAt)}.</div>}
      {!d && !loading && <div className="notice">The dashboard could not be loaded, and there is no saved copy on this device yet.</div>}

      <div className="dash-top">
        {d && (
          <div className="stats">
            <div className="stat"><b>{d.classes}</b><span>{d.classes === 1 ? 'class' : 'classes'}</span></div>
            <div className="stat"><b>{d.at_risk}<small>/{d.students}</small></b><span>students flagged at risk</span></div>
            <div className="stat"><b>{d.pending_assessments.length}</b><span>papers still being marked</span></div>
          </div>
        )}
        <div className="card stack find">
          <label htmlFor="find-student"><b>Find a student</b></label>
          <input id="find-student" type="search" placeholder="Name or admission number" value={query} onChange={(e) => setQuery(e.target.value)} />
          {found.length > 0 && (
            <ul className="found">
              {found.map((s) => (
                <li key={s.student_id}>
                  <span>{s.first_name} {s.last_name}, {s.admission_no}<span className="hint"> {className.get(s.class_id) ?? ''}</span></span>
                  <span className="actions">
                    <Link to={`/students/${s.student_id}/risk`} state={{ from: '/dashboard' }}>Risk profile</Link>
                    <Link to={`/students/${s.student_id}/interventions`} state={{ from: '/dashboard' }}>Log intervention</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {query.trim().length >= 2 && !found.length && <span className="hint">No student in your classes matches.</span>}
          {isAdmin && <Link to="/school-risk">School-wide risk overview</Link>}
        </div>
      </div>

      {d && (
        <>
          <section className="stack">
            <h2>Ongoing interventions</h2>
            {byFrequency.length === 0 && <div className="hint">No interventions under way. Log one from a student&apos;s risk profile.</div>}
            {byFrequency.map(([f, items]) => (
              <div key={f}>
                <h3 className="sub">{FREQUENCY_LABEL[f]}</h3>
                <ul className="plain">
                  {items.map((i) => (
                    <li key={i.intervention_id}>
                      {i.method}, <Link to={`/students/${i.student_id}/risk`} state={{ from: '/dashboard' }}><b>{i.student_name}</b></Link>
                      <span className="hint"> {i.factor} · since {i.started_on}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section className="stack">
            <h2>Students flagged at risk</h2>
            {d.at_risk_students.length === 0 && <div className="hint">The model flags none of your students at their latest checkpoint.</div>}
            <div className="cards">
              {d.at_risk_students.map((c) => (
                <div key={c.student.student_id} className="card student-card">
                  <Link to={`/students/${c.student.student_id}/risk`} state={{ from: '/dashboard' }} className="who">
                    {c.student.first_name} {c.student.last_name}, {c.student.admission_no}, {c.student.class_name}
                  </Link>
                  <div className="row">
                    <span>Estimated risk <b className="risk">{pct(c.latest.probability)}</b> <span className="hint">at {c.latest.label}</span></span>
                    <span className="grow" />
                    <Sparkline points={c.trend} />
                  </div>
                  <div>
                    {c.targets.length ? (
                      <>
                        {c.partial ? 'Your subject’s target: ' : 'Targets: '}
                        {c.targets.slice(0, 2).map((t) => <span key={t.column} className="chip target">{targetText(t)}</span>)}
                        {c.targets.length > 2 && <span className="hint"> and {c.targets.length - 2} more</span>}
                      </>
                    ) : <span className="hint">{c.latest.targets_status === 'MAINTAIN' ? 'Keep current results' : 'No target for your subjects'}</span>}
                  </div>
                  <div>Current intervention: {c.interventions.length ? <b>{c.interventions.join('; ')}</b> : <span className="hint">none yet</span>}</div>
                  <div className="actions"><Link to={`/students/${c.student.student_id}/interventions`} state={{ from: '/dashboard' }}>Log or update interventions</Link></div>
                </div>
              ))}
            </div>
          </section>

          <section className="stack">
            <h2>Papers still being marked</h2>
            {d.pending_assessments.length === 0 && <div className="hint">Nothing waiting for marks this term.</div>}
            <div className="cards">
              {d.pending_assessments.map((a) => (
                <div key={a.assessment_id} className="card">
                  <b>{a.class_name} {a.title}</b>
                  <div>Status: <span className={`pill ${a.status.toLowerCase()}`}>{a.status === 'UNRECORDED' ? 'Not started' : 'Being recorded'}</span></div>
                  <div>Missing marks: <b>{a.missing}</b></div>
                  <Link to={`/assessments/${a.assessment_id}/scores`}>Enter marks</Link>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
