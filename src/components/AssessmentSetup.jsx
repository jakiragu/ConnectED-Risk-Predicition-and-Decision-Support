import { useCallback, useEffect, useState } from 'react';
import { defaultWeightProblems, validateAssessmentScheme } from '@gradebook/domain/assessmentConfig';
import { gql } from '../api/graphql.js';
import { GET_ASSESSMENT_CONFIG, SAVE_ASSESSMENT_CONFIG } from '../api/operations.js';
import { repository } from '../offline/repository.js';
import { Info } from './ui.jsx';

const KEYS = [
  { key: 'OPENER', weight: 'opener', fallback: 'Opener' },
  { key: 'MIDTERM', weight: 'midterm', fallback: 'Mid-term' },
  { key: 'ENDTERM', weight: 'endterm', fallback: 'End-term' },
];

const formOf = (config) => {
  const byKey = new Map((config?.assessment_scheme || []).map((item) => [item.key, item]));
  const w = config?.default_checkpoint_weights;
  return {
    names: Object.fromEntries(KEYS.map((k) => [k.key, byKey.get(k.key)?.name || k.fallback])),
    opener: byKey.get('OPENER')?.enabled ?? true,
    useWeights: Boolean(w),
    weights: Object.fromEntries(KEYS.map((k) => [k.weight, w?.[k.weight] ?? ''])),
  };
};

/**
 * The school's assessment setup (administrators): what each checkpoint is
 * called, whether new terms hold an Opener, and default checkpoint weights for
 * new terms. Existing terms keep their own setting; change those on the
 * Assessments page.
 */
export default function AssessmentSetup({ schoolId }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { getAssessmentConfig } = await gql(GET_ASSESSMENT_CONFIG, { school_id: schoolId });
    setConfig(getAssessmentConfig);
    setForm(formOf(getAssessmentConfig));
  }, [schoolId]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  if (!form) return error ? <div className="card error-card">{error}</div> : null;

  const scheme = KEYS.map((k) => ({ key: k.key, name: form.names[k.key], enabled: k.key === 'OPENER' ? form.opener : true }));
  const weights = form.useWeights
    ? {
        OPENER: form.opener ? Number(form.weights.opener) || 0 : 0,
        MIDTERM: Number(form.weights.midterm),
        ENDTERM: Number(form.weights.endterm),
      }
    : null;
  const problems = [...validateAssessmentScheme(scheme), ...defaultWeightProblems(weights, scheme)];
  const total = weights ? weights.OPENER + (weights.MIDTERM || 0) + (weights.ENDTERM || 0) : null;

  const setName = (key) => (e) => setForm({ ...form, names: { ...form.names, [key]: e.target.value } });
  const setWeight = (key) => (e) => setForm({ ...form, weights: { ...form.weights, [key]: e.target.value } });

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { saveAssessmentConfig } = await gql(SAVE_ASSESSMENT_CONFIG, {
        input: {
          school_id: schoolId,
          assessment_scheme: scheme,
          default_checkpoint_weights: weights
            ? { opener: weights.OPENER, midterm: weights.MIDTERM, endterm: weights.ENDTERM }
            : null,
          _version: config._version,
        },
      });
      setConfig(saveAssessmentConfig);
      setForm(formOf(saveAssessmentConfig));
      setNotice('Assessment setup saved');
      repository.loadAssessmentConfig(schoolId).catch(() => {}); // refresh the copy other pages read
    } catch (e) {
      setError(e.message);
      if (e.errorType === 'Conflict') await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card weights-card">
      <div className="weights-head">
        <h2>Assessment setup</h2>
        <Info label="About the assessment setup">
          Every term has a Mid-term and an End-term exam, and may have an Opener. Here you choose what the
          school calls them, whether new terms hold an Opener, and the checkpoint weights new terms start with.
          Terms that already exist keep their own setting: change it on the Assessments page. CATs, practicals
          and projects are not separate exams: add them to an exam as a component with a weight.
        </Info>
      </div>

      <div className="weights-row">
        {KEYS.map((k) => (
          <label key={k.key} className="weight-input">
            <span>{k.fallback} is called</span>
            <input value={form.names[k.key]} maxLength={40} onChange={setName(k.key)}
              aria-label={`Name for ${k.fallback}`} />
          </label>
        ))}
      </div>

      <div className="weights-row">
        <label className="weight-input">
          <input type="checkbox" checked={form.opener} onChange={(e) => setForm({ ...form, opener: e.target.checked })} />
          <span>New terms hold an {form.names.OPENER || 'Opener'}</span>
        </label>
        <label className="weight-input">
          <input type="checkbox" checked={form.useWeights} onChange={(e) => setForm({ ...form, useWeights: e.target.checked })} />
          <span>Give new terms default weights</span>
        </label>
      </div>

      {form.useWeights && (
        <div className="weights-row">
          {KEYS.filter((k) => form.opener || k.key !== 'OPENER').map((k) => (
            <label key={k.key} className="weight-input">
              <span>{form.names[k.key] || k.fallback}</span>
              <input type="number" min="0" max="100" value={form.weights[k.weight]} onChange={setWeight(k.weight)} />
              <span>%</span>
            </label>
          ))}
          <span className={`budget ${total === 100 ? '' : 'warn'}`}>Total: <b>{total}%</b></span>
        </div>
      )}

      <div className="weights-row">
        <button type="button" className="btn" disabled={saving || problems.length > 0} onClick={save}>
          {saving ? 'Saving' : 'Save setup'}
        </button>
      </div>
      {problems.length > 0 && <div className="hint warn">{problems[0]}</div>}
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
