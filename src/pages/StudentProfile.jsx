import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { backTo } from '../navigation.js';
import { CHECKPOINT_ORDER, FREQUENCY_LABEL } from '@gradebook/domain/decision';
import { CHECKPOINT_LABEL } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import LineChart from '../components/LineChart.jsx';
import { influenceItems, summarise, Targets } from '../components/RiskExplanation.jsx';
import { InfluenceChart } from '../components/ui.jsx';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';

const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const mark = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}`);
const SHORT = { T1M: 'T1 Mid', T1F: 'T1 End', T2M: 'T2 Mid', T2F: 'T2 End', T3M: 'T3 Mid', T3F: 'T3 End' };

/** "Kiswahili: +4 (40 to 44)" for a change in a factor, with the unit it is measured in. */
const changeText = (factor, from, to) => {
  if (from == null || to == null) return '—';
  const unit = factor === 'Attendance' ? ' points' : '';
  const d = Math.round((to - from) * 10) / 10;
  return `${d >= 0 ? '+' : ''}${d}${unit} (${mark(from)} to ${mark(to)})`;
};

/** The checkpoint a target column is for: T2M_Kiswahili and Attendance_T2M are both Term 2 Mid-term. */
const targetCheckpoint = (column) => {
  const point = column.startsWith('Attendance_') ? column.slice('Attendance_'.length) : column.split('_')[0];
  return CHECKPOINT_LABEL[point] ?? point;
};

function Outcome({ i }) {
  const o = i.outcome;
  if (!i.linked) return <span className="hint">Not linked to a prediction</span>;
  if (!o?.to_point) return <span className="hint">Waiting for the next published results</span>;
  return (
    <span>
      {changeText(i.factor, o.from, o.to)} by {o.to_label}
      {o.target_gain != null && (
        <span className={o.reached_target ? 'good' : 'warn'}> · target +{o.target_gain} {o.reached_target ? 'reached' : 'not reached'}</span>
      )}
      {o.risk_to != null && <span className="hint"> · estimate {pct(o.risk_from)} to {pct(o.risk_to)}</span>}
    </span>
  );
}

/**
 * A student's risk profile: the latest prediction with its explanation and
 * targets, how risk and results moved through the year, and the interventions
 * teachers recorded with what followed them. Everything here is a
 * decision-support signal; it does not say what will happen, and what followed
 * an intervention is not proof that it worked.
 */
export default function StudentProfile() {
  const { studentId } = useParams();
  const { actor } = useAuth();
  const { online } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const [view, setView] = useState({ data: null, fromDevice: false, savedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    repository.loadProfile(actor.schoolId, studentId)
      .then((v) => live && setView(v))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [actor.schoolId, studentId, online]);

  const p = view.data;
  if (error) return <div className="stack"><Link to="/dashboard">Back</Link><div className="notice">{error}</div></div>;
  if (!p) return <div className="hint">{loading ? 'Loading…' : 'This profile has not been opened on this device before, so it cannot be shown offline.'}</div>;

  const points = CHECKPOINT_ORDER.filter((c) => p.risk_trend.some((r) => r.prediction_point === c) || p.performance_trend.some((r) => r.point === c));
  const riskAt = new Map(p.risk_trend.map((r) => [r.prediction_point, r.probability * 100]));
  const resultsAt = new Map(p.performance_trend.map((r) => [r.point, r]));
  const subjects = [...new Set(p.performance_trend.flatMap((r) => r.subjects.map((s) => s.subject)))];
  const previousInterventions = p.previous ? p.interventions.filter((i) => i.linked?.prediction_point === p.previous.prediction_point) : [];
  const latest = p.latest;

  return (
    <div className="stack">
      <button type="button" className="btn link back" onClick={() => navigate(backTo(location))}>Back</button>
      {view.fromDevice && <div className="notice">You are offline. This is the copy saved on this device at {new Date(view.savedAt).toLocaleString()}.</div>}

      <div className="card profile-head">
        <h1>{p.student.first_name} {p.student.last_name}</h1>
        <div>Admission no: <b>{p.student.admission_no}</b> · Class: <b>{p.student.class_name ?? '—'}</b></div>
        <Link className="btn primary" to={`/students/${studentId}/interventions`} state={{ from: backTo(location) }}>Log or update interventions</Link>
      </div>

      {!p.scope.all && (
        <div className="hint">You see {p.scope.factors.join(' and ')}: the subject{p.scope.factors.length === 1 ? '' : 's'} you teach this student. The class teacher sees every subject and attendance.</div>
      )}
      {!latest && <div className="notice">No risk prediction for this student this school year yet. Predictions are made when Mid-term and End-term results are published.</div>}
      {latest && !p.current && (
        <div className="notice">
          Not current: results up to {CHECKPOINT_LABEL[p.last_published_point]} are published, but the latest prediction is from {latest.label}.
          It is shown until a new prediction is made.
        </div>
      )}

      <div className="profile-grid">
        <div className="card stack">
          <h2>{p.results ? `${p.results.label} (latest results)` : 'Latest results'}</h2>
          {latest && (
            <div>
              Estimated risk at {latest.label}: <b className={latest.at_risk ? 'risk' : ''}>{pct(latest.probability)}</b>
              {latest.at_risk ? ` (at or above the model's ${pct(latest.threshold)} threshold)` : ` (below the model's ${pct(latest.threshold)} threshold)`}
              {!p.current && <span className="pill recording"> not current</span>}
            </div>
          )}
          {p.results ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Subject</th><th>Result</th><th>Grade</th></tr></thead>
                <tbody>
                  {p.results.subjects.map((s) => <tr key={s.subject}><td>{s.subject}</td><td>{mark(s.score)}</td><td>{s.grade ?? '—'}</td></tr>)}
                  {p.results.average != null && <tr><td><b>Average</b></td><td><b>{mark(p.results.average)}</b></td><td /></tr>}
                </tbody>
              </table>
            </div>
          ) : <div className="hint">No published results this school year yet.</div>}

          {latest && (
            <>
              <h3>What moved the estimate</h3>
              {!p.explained && <div className="hint">This estimate was made before explanations were added.</div>}
              {p.explained && (
                <>
                  {summarise(p.factors) && <div>{summarise(p.factors)}</div>}
                  <InfluenceChart items={influenceItems(p.factors)} />
                </>
              )}
              <h3>Targets</h3>
              {p.targets ? (
                <>
                  {p.targets.partial && <div className="hint">Showing only your subjects&apos; part of each target.</div>}
                  {p.targets.partial && !p.targets.options.length && ['FOUND', 'FALLBACK'].includes(p.targets.status)
                    ? <div className="hint">The targets for this student do not involve your subjects.</div>
                    : <Targets targets={p.targets} />}
                </>
              ) : <div className="hint">{latest.at_risk ? 'No targets were worked out for this prediction.' : 'Not flagged at risk, so no targets.'}</div>}
            </>
          )}
        </div>

        <div className="card stack">
          <h2>{p.previous ? `${p.previous.label} (previous prediction)` : 'Previous prediction'}</h2>
          {!p.previous && <div className="hint">There is no earlier prediction this school year.</div>}
          {p.previous && (
            <>
              <div>Estimated risk: <b className={p.previous.at_risk ? 'risk' : ''}>{pct(p.previous.probability)}</b></div>
              <h3>Interventions after it</h3>
              {previousInterventions.length === 0 && <div className="hint">None were logged against this prediction.</div>}
              <ul className="plain">
                {previousInterventions.map((i) => (
                  <li key={i.intervention_id}>
                    <b>{i.method}</b> <span className="hint">({i.factor}, {FREQUENCY_LABEL[i.frequency].toLowerCase()})</span>
                    <div>Target: {i.linked?.target ? `+${i.linked.target.gain} (${mark(i.linked.target.from)} to ${mark(i.linked.target.to)})` : 'none set'} · Result: <Outcome i={i} /></div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="two-col">
        <div className="card stack">
          <h2>Estimated risk through the year</h2>
          {p.risk_trend.length ? (
            <LineChart title="Estimated risk by checkpoint" labels={points.map((c) => SHORT[c])}
              series={[{ name: 'Estimated risk', emphasis: true, values: points.map((c) => riskAt.get(c) ?? null) }]} yLabel="% estimated risk" valueLabels
              line={latest ? { value: latest.threshold * 100, label: `flagged from ${Math.round(latest.threshold * 100)}%` } : null} format={(v) => `${Math.round(v)}%`} />
          ) : <div className="hint">No predictions yet.</div>}
        </div>
        <div className="card stack">
          <h2>{p.scope.all ? 'Average result' : 'Your subjects’ results'}</h2>
          {p.performance_trend.length ? (
            <LineChart title="Results by checkpoint" labels={points.map((c) => SHORT[c])}
              series={p.scope.all
                ? [{ name: 'Average', emphasis: true, values: points.map((c) => resultsAt.get(c)?.average ?? null) }]
                : subjects.map((s) => ({ name: s, values: points.map((c) => resultsAt.get(c)?.subjects.find((x) => x.subject === s)?.score ?? null) }))} />
          ) : <div className="hint">No published results yet.</div>}
        </div>
      </div>
      {p.scope.all && subjects.length > 0 && (
        <div className="card stack">
          <h2>Results by subject</h2>
          <LineChart title="Results by subject and checkpoint" labels={points.map((c) => SHORT[c])}
            series={subjects.map((s) => ({ name: s, values: points.map((c) => resultsAt.get(c)?.subjects.find((x) => x.subject === s)?.score ?? null) }))} />
        </div>
      )}

      <div className="card stack">
        <h2>Intervention history</h2>
        {p.interventions.length === 0 && <div className="hint">No interventions recorded{p.scope.all ? '' : ' for your subjects'}.</div>}
        {p.interventions.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Started</th><th>For</th><th>Intervention</th><th>Status</th><th>Target then</th><th>What followed</th><th>By</th></tr></thead>
              <tbody>
                {p.interventions.map((i) => (
                  <tr key={i.intervention_id}>
                    <td>{i.started_on}</td>
                    <td>{i.factor}</td>
                    <td>{i.method}<div className="hint">{FREQUENCY_LABEL[i.frequency]}{i.expected_outcome ? ` · expected: ${i.expected_outcome}` : ''}</div></td>
                    <td>{i.status === 'ONGOING' ? 'Ongoing' : `Stopped ${i.stopped_on}`}</td>
                    <td>{i.linked?.target ? `+${i.linked.target.gain} by ${targetCheckpoint(i.linked.target.column)}` : '—'}</td>
                    <td><Outcome i={i} /></td>
                    <td>{i.created_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint">
          &quot;What followed&quot; is monitoring: how the result and the estimate moved after the intervention began. It does not show
          that the intervention caused the change.
        </div>
      </div>
    </div>
  );
}
