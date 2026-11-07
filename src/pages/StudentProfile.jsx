import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { backTo } from '../navigation.js';
import { CHECKPOINT_ORDER, FREQUENCY_LABEL } from '@gradebook/domain/decision';
import { CHECKPOINT_LABEL } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import LineChart from '../components/LineChart.jsx';
import { influenceItems, summarise, Targets } from '../components/RiskExplanation.jsx';
import SubjectPerformanceChart from '../components/SubjectPerformanceChart.jsx';
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

function AssessmentPanel({
  heading,
  entry,
  options,
  value,
  onChange,
  targetIndex,
  onTargetIndexChange,
  isCurrent,
}) {
  const prediction = entry?.prediction;
  const results = entry?.results;
  const factors = entry?.factors ?? [];
  const interventions = entry?.interventions ?? [];

  return (
    <div className="card stack assessment-panel">
      <div className="assessment-panel-heading">
        <div>
          <h2>{heading}</h2>
          {prediction && <div className="hint">{prediction.label}</div>}
        </div>

        <label className="assessment-picker">
          <span>Assessment checkpoint</span>
          <Select
            value={value ?? ''}
            onChange={onChange}
            options={options}
            placeholder="No assessment available"
            disabled={!options.length}
            aria-label={`${heading} checkpoint`}
          />
        </label>
      </div>

      {!entry ? (
        <div className="hint">No assessment is available for comparison.</div>
      ) : (
        <>
          {/* 1. Estimated risk */}
          <div className="assessment-risk">
            <span>Estimated risk:</span>

            <b className={prediction.at_risk ? 'risk' : ''}>
              {pct(prediction.probability)}
            </b>

            <span className={`pill ${prediction.at_risk ? 'risk' : 'good'}`}>
              {prediction.at_risk ? 'At risk' : 'Not flagged'}
            </span>

            {isCurrent === false && (
              <span className="pill recording">Not current</span>
            )}
          </div>

          {/* 2. Results */}
          <h3>Subject results</h3>

          {results ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Result</th>
                    <th>Grade</th>
                  </tr>
                </thead>

                <tbody>
                  {results.subjects.map((s) => (
                    <tr key={s.subject}>
                      <td>{s.subject}</td>
                      <td>{mark(s.score)}</td>
                      <td>{s.grade ?? '—'}</td>
                    </tr>
                  ))}

                  {results.average != null && (
                    <tr>
                      <td><b>Average</b></td>
                      <td><b>{mark(results.average)}</b></td>
                      <td />
                    </tr>
                  )}

                  {results.subjects.length === 0 && (
                    <tr className="empty">
                      <td colSpan={3}>No subject results available.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="hint">
              No published results are associated with this checkpoint.
            </div>
          )}

          {/* 3. SHAP explanation */}
          <h3>What moved the estimate</h3>

          {!entry.explained ? (
            <div className="hint">
              This estimate was made before explanations were available.
            </div>
          ) : factors.length ? (
            <>
              {summarise(factors) && (
                <div>{summarise(factors)}</div>
              )}
              <InfluenceChart items={influenceItems(factors)} />
            </>
          ) : (
            <div className="hint">
              No visible factor contributions are available.
            </div>
          )}

          {/* 4. Model-generated targets */}
          <h3>Model-generated targets</h3>

          {entry.targets ? (
            <>
              {entry.targets.partial && (
                <div className="hint">
                  Showing only the targets within your subject scope.
                </div>
              )}

              {entry.targets.partial &&
                !entry.targets.options.length &&
                ['FOUND', 'FALLBACK'].includes(entry.targets.status) ? (
                  <div className="hint">
                    The targets do not involve your subjects.
                  </div>
                ) : (
                  <Targets
                    targets={entry.targets}
                    selectedIndex={targetIndex}
                    onSelectedIndexChange={onTargetIndexChange}
                  />
                )}
            </>
          ) : (
            <div className="hint">
              {prediction.at_risk
                ? 'No model-generated targets were available for this prediction.'
                : 'Not flagged at risk, so no targets were generated.'}
            </div>
          )}

          {/* 5. Interventions */}
          <h3>Interventions linked to this assessment</h3>

          {interventions.length === 0 ? (
            <div className="hint">
              No interventions were logged against this prediction.
            </div>
          ) : (
            <ul className="plain">
              {interventions.map((i) => (
                <li key={i.intervention_id}>
                  <b>{i.method}</b>

                  <span className="hint">
                    {' '}({i.factor}, {FREQUENCY_LABEL[i.frequency]?.toLowerCase() ?? i.frequency})
                  </span>

                  <div className="hint">
                    Started: {i.started_on} ·{' '}
                    {i.status === 'ONGOING'
                      ? 'Ongoing'
                      : `Stopped ${i.stopped_on}`}
                  </div>

                  <div>
                    Target:{' '}
                    {i.linked?.target
                      ? `+${i.linked.target.gain} (${mark(i.linked.target.from)} to ${mark(i.linked.target.to)})`
                      : 'None set'}
                  </div>

                  <div>
                    Result: <Outcome i={i} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
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
  const [selectedTargetIndex, setSelectedTargetIndex] = useState(0);
  const [latestAssessmentPoint, setLatestAssessmentPoint] = useState(null);
  const [previousAssessmentPoint, setPreviousAssessmentPoint] = useState(null);

  const [latestTargetIndex, setLatestTargetIndex] = useState(0);
  const [previousTargetIndex, setPreviousTargetIndex] = useState(0);

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
  useEffect(() => {
    setSelectedTargetIndex(0);
  }, [p?.targets]);
  if (error) return <div className="stack"><Link to="/dashboard">Back</Link><div className="notice">{error}</div></div>;
  if (!p) return <div className="hint">{loading ? 'Loading…' : 'This profile has not been opened on this device before, so it cannot be shown offline.'}</div>;
  const assessmentHistory = (p.assessment_history || [])
    .slice()
    .sort((a, b) =>
      CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) -
      CHECKPOINT_ORDER.indexOf(b.prediction.prediction_point)
    );

  // Dropdowns display the newest checkpoint first.
  const newestFirst = assessmentHistory.slice().reverse();

  const defaultLatest = newestFirst[0] ?? null;
  const defaultPrevious = newestFirst[1] ?? null;

  const latestAssessment =
    newestFirst.find(
      (a) => a.prediction.prediction_point === latestAssessmentPoint
    ) ?? defaultLatest;

  const latestPoint =
    latestAssessment?.prediction.prediction_point ?? null;

  // Keep the previous selection valid and different from the latest selection.
  const previousAssessment =
    newestFirst.find(
      (a) =>
        a.prediction.prediction_point === previousAssessmentPoint &&
        a.prediction.prediction_point !== latestPoint
    ) ??
    newestFirst.find(
      (a) =>
        a.prediction.prediction_point === defaultPrevious?.prediction.prediction_point &&
        a.prediction.prediction_point !== latestPoint
    ) ??
    newestFirst.find(
      (a) => a.prediction.prediction_point !== latestPoint
    ) ??
    null;

  const previousPoint =
    previousAssessment?.prediction.prediction_point ?? null;

  const latestOptions = newestFirst
    .filter((a) => a.prediction.prediction_point !== previousPoint)
    .map((a) => ({
      value: a.prediction.prediction_point,
      label: a.prediction.label,
    }));

  const previousOptions = newestFirst
    .filter((a) => a.prediction.prediction_point !== latestPoint)
    .map((a) => ({
      value: a.prediction.prediction_point,
      label: a.prediction.label,
    }));

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

        <div className="profile-student-info profile-info">
          <div>
            Admission no: <b>{p.student.admission_no}</b>
          </div>
          <div>
            Class: <b>{p.student.class_name ?? '—'}</b>
          </div>
        </div>

        <div className="profile-teaching-info profile-info">
          <div>
            Subjects taught:{' '}
            <b>{p.teaching?.subjects?.length
              ? p.teaching.subjects.join(', ')
              : 'No subject assignments available'}</b>
          </div>

          {p.teaching?.isClassTeacher && (
            <span className="pill good">Class teacher</span>
          )}
        </div>
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

      <div className="profile-grid assessment-comparison">
        <AssessmentPanel
          heading="Earlier assessment"
          entry={latestAssessment}
          options={latestOptions}
          value={latestPoint ?? ''}
          onChange={(point) => {
            setLatestAssessmentPoint(point);
            setLatestTargetIndex(0);
          }}
          targetIndex={latestTargetIndex}
          onTargetIndexChange={setLatestTargetIndex}
          isCurrent={
            latestPoint === p.latest?.prediction_point
              ? p.current
              : null
          }
        />

        <AssessmentPanel
          heading="Later assessment"
          entry={previousAssessment}
          options={previousOptions}
          value={previousPoint ?? ''}
          onChange={(point) => {
            setPreviousAssessmentPoint(point);
            setPreviousTargetIndex(0);
          }}
          targetIndex={previousTargetIndex}
          onTargetIndexChange={setPreviousTargetIndex}
        />
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
          <SubjectPerformanceChart
            performanceTrend={p.performance_trend}
            subjects={subjects}
            targetOption={p.targets?.options?.[selectedTargetIndex] ?? null}
          />
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
