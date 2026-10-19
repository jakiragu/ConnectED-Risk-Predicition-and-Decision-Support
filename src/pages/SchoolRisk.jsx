import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { GET_RISK_IMPORTANCE } from '../api/riskOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ImportanceBars from '../components/ImportanceBars.jsx';
import LineChart from '../components/LineChart.jsx';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';
import '../styles/explain.css';
import '../styles/decision.css';

const POINTS = ['T1M', 'T1F', 'T2M', 'T2F', 'T3M'];
const SHORT = { T1M: 'T1 Mid', T1F: 'T1 End', T2M: 'T2 Mid', T2F: 'T2 End', T3M: 'T3 Mid' };
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

function RateTable({ rows, caption, link }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr><th>{caption}</th>{POINTS.map((p) => <th key={p}>{SHORT[p]}</th>)}<th>Latest</th>{rows[0]?.interventions_ongoing != null && <th>Ongoing interventions</th>}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr className="empty"><td colSpan={8}>No predictions yet.</td></tr>}
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{link ? <Link to={`/model-inputs?class=${r.key}`}>{r.label}</Link> : r.label}</td>
              {r.series.map((s) => <td key={s.point}>{s.students ? `${pct(s.rate)} (${s.at_risk}/${s.students})` : '—'}</td>)}
              <td>{r.latest ? `${r.latest.at_risk}/${r.latest.students} at ${SHORT[r.latest.point]}` : '—'}</td>
              {r.interventions_ongoing != null && <td>{r.interventions_ongoing} <span className="hint">of {r.interventions_logged}</span></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * School-wide risk for administrators (US-06): the share of students the model
 * flags at each checkpoint, by form and by class, the interventions under way,
 * and what drives the model across the school (global SHAP). Rates count each
 * student in the class their prediction was made in.
 */
export default function SchoolRisk() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [view, setView] = useState({ data: null });
  const [point, setPoint] = useState(null);
  const [importance, setImportance] = useState(null);

  useEffect(() => {
    repository.loadSchoolOverview(actor.schoolId).then((v) => {
      setView(v);
      const latest = [...(v.data?.points || [])].reverse().find((p) => p.students);
      setPoint((p) => p ?? latest?.point ?? 'T1M');
    });
  }, [actor.schoolId, online]);

  useEffect(() => {
    if (!point) return;
    setImportance(null);
    gql(GET_RISK_IMPORTANCE, { school_id: actor.schoolId, prediction_point: point })
      .then((d) => setImportance(d.getRiskImportance))
      .catch(() => setImportance({ unavailable: true }));
  }, [actor.schoolId, point, online]);

  const o = view.data;
  if (!o) return <div className="hint">{view.savedAt === undefined ? 'Loading…' : 'The overview could not be loaded, and there is no saved copy on this device yet.'}</div>;
  const latest = [...o.points].reverse().find((p) => p.students) ?? null;

  return (
    <div className="stack">
      <div className="page-head"><h1>School-wide risk, {o.academic_year ?? '—'}</h1></div>
      {view.fromDevice && <div className="notice">You are offline. This is the copy saved on this device at {new Date(view.savedAt).toLocaleString()}.</div>}
      <div className="stats">
        <div className="stat"><b>{latest ? `${latest.at_risk}/${latest.students}` : '—'}</b><span>flagged at {latest ? latest.label : 'the latest checkpoint'}</span></div>
        <div className="stat"><b>{latest ? pct(latest.rate) : '—'}</b><span>at-risk rate</span></div>
        <div className="stat"><b>{o.interventions_ongoing}</b><span>interventions under way ({o.interventions_logged} recorded)</span></div>
      </div>

      <div className="card stack">
        <h2>At-risk rate through the year</h2>
        <LineChart title="School at-risk rate by checkpoint" labels={POINTS.map((p) => SHORT[p])}
          series={[{ name: 'School', values: o.points.map((p) => (p.students ? p.rate * 100 : null)) },
            ...o.forms.map((f) => ({ name: f.label, values: f.series.map((s) => (s.students ? s.rate * 100 : null)) }))]}
          format={(v) => `${Math.round(v)}%`} />
        <div className="hint">The share of students at or above the model&apos;s threshold. A signal for planning support, not a judgement about students.</div>
      </div>

      <div className="card stack"><h2>By form</h2><RateTable rows={o.forms} caption="Form" /></div>
      <div className="card stack"><h2>By class</h2><RateTable rows={o.classes} caption="Class" link /></div>

      <div className="card stack">
        <div className="page-head">
          <h2>What drives the model</h2>
          <select aria-label="Prediction point" value={point ?? ''} onChange={(e) => setPoint(e.target.value)}>
            {POINTS.map((p) => <option key={p} value={p}>{SHORT[p]}</option>)}
          </select>
        </div>
        {!importance && <div className="hint">Loading…</div>}
        {importance?.unavailable && <div className="hint">Needs a connection to the server.</div>}
        {importance && !importance.unavailable && (
          <div className="two-col">
            <div className="stack">
              <h3>Across this school ({importance.observed.students} students)</h3>
              <ImportanceBars items={importance.observed.groups} empty="No predictions at this point yet." />
            </div>
            <div className="stack">
              <h3>In the model&apos;s evaluation</h3>
              <ImportanceBars items={importance.model?.groups} empty="The model package has no global importance." />
            </div>
          </div>
        )}
        <div className="hint">Mean absolute SHAP: how much each subject and attendance moved the estimates, in either direction. Not causes.</div>
      </div>
    </div>
  );
}
