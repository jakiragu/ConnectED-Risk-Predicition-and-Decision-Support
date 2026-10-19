import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { GET_FEATURE_READINESS, GET_STUDENT_FEATURES, LIST_TERMS_FULL } from '../api/calendarOperations.js';
import {
  GET_RISK_EXPLANATION, GET_RISK_IMPORTANCE, GET_RISK_MODEL, GET_RISK_RUN, LIST_RISK_PREDICTIONS, RUN_RISK_PREDICTIONS,
} from '../api/riskOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import ImportanceBars from '../components/ImportanceBars.jsx';
import RiskExplanation from '../components/RiskExplanation.jsx';
import { targetText } from '@gradebook/domain/targets';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import '../styles/calendar.css';
import '../styles/explain.css';

const POINTS = [
  { value: 'T1M', label: 'Term 1 Mid-term (T1M)', term_number: 1, checkpoint: 'MIDTERM' },
  { value: 'T1F', label: 'Term 1 End-term (T1F)', term_number: 1, checkpoint: 'ENDTERM' },
  { value: 'T2M', label: 'Term 2 Mid-term (T2M)', term_number: 2, checkpoint: 'MIDTERM' },
  { value: 'T2F', label: 'Term 2 End-term (T2F)', term_number: 2, checkpoint: 'ENDTERM' },
  { value: 'T3M', label: 'Term 3 Mid-term (T3M)', term_number: 3, checkpoint: 'MIDTERM' },
];
const RUN_TEXT = { QUEUED: 'Queued', RUNNING: 'Running', COMPLETE: 'Complete', FAILED: 'Failed', SKIPPED: 'Skipped' };
const pct = (p) => `${(p * 100).toFixed(1)}%`;

/**
 * What the risk model received and returned for each student at a prediction
 * point, and why. Inputs: published Mid-term and End-term exam results per
 * subject and attendance from the start of the school year (missing values are
 * passed as missing). Output: the model's probability, whether it is at or
 * above the model's threshold, and its SHAP explanation: which subjects and
 * attendance pushed the estimate up or down; for flagged students, targets for
 * the next checkpoint (DiCE against the next checkpoint's model, or the pass mark
 * at T3M; peer progression when DiCE finds none). Below the table: what drives
 * the model overall (global importance), for the model and for this class.
 * Predictions are made automatically when the checkpoint's results are
 * published; administrators can run them again, for example after the model is
 * replaced. The output is a decision-support signal, not a judgement about a
 * student. Administrators see every class; a class teacher sees their own.
 */
export default function ModelInputs() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort((a, b) => a.name.localeCompare(b.name)),
    [classes, isAdmin]
  );
  const classId = params.get('class') || mine[0]?.class_id || '';
  const point = POINTS.find((p) => p.value === params.get('point')) || POINTS[0];
  const year = params.get('year') ? Number(params.get('year')) : null;
  const go = (next) => setParams(Object.fromEntries(Object.entries({ class: classId, point: point.value, year, ...next }).filter(([, v]) => v)));

  const [readiness, setReadiness] = useState(null);
  const [predictions, setPredictions] = useState([]);
  const [run, setRun] = useState(null);
  const [model, setModel] = useState(null);
  const [selected, setSelected] = useState(null);
  const [features, setFeatures] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [importance, setImportance] = useState(null);
  const [terms, setTerms] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  useEffect(() => {
    if (online) gql(LIST_TERMS_FULL, { school_id: actor.schoolId }).then((d) => setTerms(d.listTerms)).catch(() => {});
  }, [online, actor.schoolId]);

  // The term this prediction point belongs to, in the school year being shown.
  const term = useMemo(() => {
    const y = readiness?.academic_year ?? year;
    return terms.find((t) => Number(t.academic_year) === Number(y) && Number(t.term_number) === point.term_number) || null;
  }, [terms, readiness, year, point]);

  const load = useCallback(async () => {
    if (!classId) return;
    const scope = { school_id: actor.schoolId, class_id: classId, prediction_point: point.value, academic_year: year };
    const [{ getFeatureReadiness }, { listRiskPredictions }, { getRiskImportance }] = await Promise.all([
      gql(GET_FEATURE_READINESS, scope),
      gql(LIST_RISK_PREDICTIONS, scope),
      gql(GET_RISK_IMPORTANCE, { school_id: actor.schoolId, prediction_point: point.value, academic_year: year, class_id: classId }),
    ]);
    setReadiness(getFeatureReadiness);
    setPredictions(listRiskPredictions);
    setImportance(getRiskImportance);
  }, [actor.schoolId, classId, point, year]);

  const loadRun = useCallback(async () => {
    if (!classId || !term) return null;
    const { getRiskRun } = await gql(GET_RISK_RUN, { school_id: actor.schoolId, class_id: classId, term_id: term.term_id, checkpoint: point.checkpoint });
    setRun(getRiskRun);
    return getRiskRun;
  }, [actor.schoolId, classId, term, point]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setReadiness(null);
    setPredictions([]);
    setRun(null);
    setSelected(null);
    setFeatures(null);
    setExplanation(null);
    setImportance(null);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  useEffect(() => {
    if (online) loadRun().catch(() => {});
  }, [loadRun, online]);

  useEffect(() => {
    if (online && isAdmin) gql(GET_RISK_MODEL, { school_id: actor.schoolId }).then((d) => setModel(d.getRiskModel)).catch(() => {});
  }, [online, isAdmin, actor.schoolId]);

  // While a run is queued or running, poll until it finishes, then reload the predictions.
  useEffect(() => {
    if (!run || !['QUEUED', 'RUNNING'].includes(run.status)) return undefined;
    const t = setTimeout(async () => {
      const r = await loadRun().catch(() => null);
      if (r && !['QUEUED', 'RUNNING'].includes(r.status)) load().catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [run, loadRun, load]);

  async function rerun() {
    setError(null);
    setNotice(null);
    try {
      const { runRiskPredictions } = await gql(RUN_RISK_PREDICTIONS, {
        input: { school_id: actor.schoolId, class_id: classId, term_id: term.term_id, checkpoint: point.checkpoint },
      });
      setRun(runRiskPredictions);
      setNotice('Predictions queued. This page updates when they are ready.');
    } catch (e) {
      setError(e.message);
    }
  }

  async function explainFor(student) {
    setSelected(student.student_id);
    setFeatures(null);
    setExplanation(null);
    try {
      const { getRiskExplanation } = await gql(GET_RISK_EXPLANATION, {
        school_id: actor.schoolId, student_id: student.student_id, prediction_point: point.value, academic_year: readiness.academic_year,
      });
      setExplanation({ ...getRiskExplanation, name: `${student.first_name} ${student.last_name}` });
    } catch (e) {
      setError(e.message);
    }
  }

  async function open(student) {
    setSelected(student.student_id);
    setExplanation(null);
    setFeatures(null);
    try {
      const { getStudentFeatures } = await gql(GET_STUDENT_FEATURES, {
        school_id: actor.schoolId, student_id: student.student_id, prediction_point: point.value, academic_year: readiness.academic_year,
      });
      setFeatures(getStudentFeatures);
    } catch (e) {
      setError(e.message);
    }
  }

  if (!online) return <div className="notice">Model inputs need a connection.</div>;
  if (!isAdmin && !mine.length) return <div className="notice">Model inputs are available to administrators and class teachers.</div>;

  const byStudent = new Map(predictions.map((p) => [p.student_id, p]));
  const flagged = predictions.filter((p) => p.at_risk).length;

  return (
    <>
      <div className="page-head">
        <h1>Model inputs and output</h1>
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
          options={mine.map((c) => ({ value: c.class_id, label: c.name }))} style={{ width: 190 }} />
        <Select aria-label="Prediction point" value={point.value} onChange={(v) => go({ point: v })}
          options={POINTS.map((p) => ({ value: p.value, label: p.label }))} style={{ width: 230 }} />
      </div>
      <div className="hint">
        Inputs: published Mid-term and End-term exam results for the model's nine subjects (CRE is the model's Religious
        Education) and attendance from the first day of the school year; a blank value is sent as missing. Output: the
        model's probability of academic risk, flagged when it reaches the model's threshold, and the factors that pushed it
        up (↑) or down (↓). The output is a signal for the class teacher to look into, not a judgement about the student.
      </div>
      {isAdmin && model && (
        <div className="hint">
          {model.available
            ? `Model in use: ${model.model_version} (${model.framework} ${model.xgboost_version}).`
            : `No model is available: ${model.message}`}
        </div>
      )}
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {readiness && (
        <>
          <div className="budget-row">
            <span>{readiness.class_name} · school year {readiness.academic_year} · {readiness.columns} inputs</span>
            <span>{readiness.complete} of {readiness.students.length} students have every input</span>
            {run ? (
              <span className={run.status === 'FAILED' ? 'warn' : ''}>
                Predictions: {RUN_TEXT[run.status] || run.status}
                {run.status === 'COMPLETE' && ` · ${run.at_risk} of ${run.students} flagged`}
                {run.status === 'COMPLETE' && run.targets_found != null &&
                  ` (targets: ${run.targets_found} DiCE, ${run.targets_fallback} peer progression, ${run.targets_maintain} keep current${run.targets_failed ? `, ${run.targets_failed} failed` : ''})`}
                {run.status === 'COMPLETE' && ` · ${run.model_version}`}
                {run.status === 'FAILED' && ` · ${run.error}`}
              </span>
            ) : (
              <span className="hint">No predictions yet: they are made when these results are published.</span>
            )}
            {isAdmin && term && (
              <button type="button" className="btn secondary" disabled={run && ['QUEUED', 'RUNNING'].includes(run.status)} onClick={rerun}>
                Run predictions again
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Adm no</th><th>Student</th><th>Missing results</th><th>Missing attendance</th>
                  <th>Model probability</th><th>Signal</th><th>Main factors</th><th>Target</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {readiness.students.map((s) => {
                  const p = byStudent.get(s.student_id);
                  return (
                    <tr key={s.student_id} className={s.student_id === selected ? 'row-dirty' : ''}>
                      <td>{s.admission_no}</td>
                      <td>{s.first_name} {s.last_name}</td>
                      <td>{s.missing_scores}</td>
                      <td>{s.missing_attendance ? <span className="warn">{s.missing_attendance}</span> : 0}</td>
                      <td>{p ? pct(p.probability) : <span className="hint">—</span>}</td>
                      <td>
                        {p ? (p.at_risk ? <b className="warn">At risk (≥ {pct(p.threshold)})</b> : 'Not flagged') : <span className="hint">—</span>}
                        {p && (p.missing_scores > 0 || p.missing_attendance > 0) && (
                          <div className="hint">{p.missing_scores + p.missing_attendance} inputs were missing</div>
                        )}
                      </td>
                      <td>
                        {p?.explained ? (
                          <span className="chips">
                            {p.top_factors.map((f) => (
                              <span key={f.group} className={`chip ${f.direction === 'RAISES' ? 'raises' : 'lowers'}`}
                                title={`${Math.round(f.share * 100)}% of the overall effect`}>
                                {f.all_missing ? `${f.group} (missing)` : f.group} {f.direction === 'RAISES' ? '↑' : '↓'}
                              </span>
                            ))}
                          </span>
                        ) : p ? <span className="hint">Not explained</span> : <span className="hint">—</span>}
                      </td>
                      <td>
                        {!p?.at_risk ? <span className="hint">—</span>
                          : p.targets_status === 'FOUND' || p.targets_status === 'FALLBACK' ? (
                            <span className="chips">
                              {p.best_target.map((c) => <span key={c.column} className="chip target">{targetText(c)}</span>)}
                              {p.targets_status === 'FALLBACK' && <span className="hint">from peer progress</span>}
                            </span>
                          )
                          : p.targets_status === 'MAINTAIN' ? <span className="hint">Keep current results</span>
                          : p.targets_status === 'NONE' ? <span className="hint">No target</span>
                          : p.targets_status === 'ERROR' ? <span className="warn">Not worked out</span>
                          : <span className="hint">Run predictions again</span>}
                      </td>
                      <td className="actions">
                        {p && <button type="button" className="btn link" onClick={() => explainFor(s)}>Explain</button>}
                        <button type="button" className="btn link" onClick={() => open(s)}>View inputs</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {flagged > 0 && <div className="hint">{flagged} student{flagged === 1 ? '' : 's'} flagged at {point.value}.</div>}
        </>
      )}

      {explanation && <RiskExplanation explanation={explanation} name={explanation.name} />}

      {features && (
        <div className="card stack">
          <h2>Inputs for {readiness.students.find((s) => s.student_id === features.student_id)?.first_name} at {features.prediction_point}</h2>
          <div className="feature-grid">
            {features.values.map((v) => (
              <div key={v.name} className={v.value == null ? 'missing' : ''}>
                <code>{v.name}</code>: {v.value == null ? 'missing' : v.value.toFixed(2)}
              </div>
            ))}
          </div>
        </div>
      )}

      {importance && (
        <div className="card stack">
          <h2>What drives the model at {point.value}</h2>
          <div className="hint">
            Mean absolute SHAP value per subject (all its checkpoints together) and for attendance: how much each one moves the
            model's estimate on average, in either direction. It describes the model, not what causes risk.
          </div>
          <div className="two-col">
            <div className="stack">
              <h3>The model{importance.model_version ? ` (${importance.model_version})` : ''}</h3>
              {importance.model ? (
                <>
                  <div className="hint">Measured on the {importance.model.rows} held-out students the model was evaluated on.</div>
                  <ImportanceBars items={importance.model.groups} />
                </>
              ) : (
                <div className="hint">This model package does not include global importance.</div>
              )}
            </div>
            <div className="stack">
              <h3>{readiness?.class_name || 'This class'}</h3>
              <div className="hint">Over the {importance.observed.students} prediction{importance.observed.students === 1 ? '' : 's'} made for this class at {point.value}.</div>
              <ImportanceBars items={importance.observed.groups} empty="No explained predictions yet." />
            </div>
          </div>
          {importance.model?.features?.length > 0 && (
            <details>
              <summary>The model's most important individual inputs</summary>
              <ImportanceBars items={importance.model.features} />
            </details>
          )}
        </div>
      )}
    </>
  );
}
