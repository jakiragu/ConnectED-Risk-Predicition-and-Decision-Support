import { useCallback, useEffect, useState } from 'react';
import { gql } from '../api/graphql.js';
import { GET_GRADE_RULE, SET_CHECKPOINT_WEIGHTS } from '../api/operations.js';

const FIELDS = [
  { key: 'opener', label: 'Opener' },
  { key: 'midterm', label: 'Mid-term' },
  { key: 'endterm', label: 'End of term' },
];

export default function CheckpointWeights({ schoolId, termId, online }) {
  const [rule, setRule] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!termId || !online) return;
    const { getGradeRule } = await gql(GET_GRADE_RULE, { school_id: schoolId, term_id: termId });
    setRule(getGradeRule);
    setDraft(null);
  }, [schoolId, termId, online]);

  useEffect(() => {
    setError(null);
    load().catch((e) => setError(e.message));
  }, [load]);

  if (!online) return null;
  if (!rule) return error ? <div className="card error-card">{error}</div> : null;

  const current = rule.checkpoint_weights || {};
  const values = draft || { opener: current.opener ?? '', midterm: current.midterm ?? '', endterm: current.endterm ?? '' };
  const total = FIELDS.reduce((t, f) => t + (Number(values[f.key]) || 0), 0);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const { setCheckpointWeights } = await gql(SET_CHECKPOINT_WEIGHTS, {
        input: {
          school_id: schoolId,
          term_id: termId,
          opener: Number(values.opener),
          midterm: Number(values.midterm),
          endterm: Number(values.endterm),
          _version: rule.checkpoint_weights_version,
        },
      });
      setRule(setCheckpointWeights);
      setDraft(null);
    } catch (e) {
      setError(e.message);
      if (e.errorType === 'Conflict' || e.errorType === 'Locked') await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card weights-card">
      <div className="weights-head">
        <h2>Checkpoint weights</h2>
        <span className="hint">How much each exam counts towards the term result. They must total 100%.</span>
      </div>
      <div className="weights-row">
        {FIELDS.map((f) => (
          <label key={f.key} className="weight-input">
            <span>{f.label}</span>
            <input
              type="number"
              min="0"
              max="100"
              value={values[f.key]}
              disabled={rule.checkpoint_weights_locked}
              onChange={(e) => setDraft({ ...values, [f.key]: e.target.value })}
            />
            <span>%</span>
          </label>
        ))}
        <span className={`budget ${total === 100 ? '' : 'warn'}`}>Total: <b>{total}%</b></span>
        {!rule.checkpoint_weights_locked && (
          <button type="button" className="btn" disabled={!draft || saving} onClick={save}>
            {saving ? 'Saving' : 'Save weights'}
          </button>
        )}
      </div>
      {rule.checkpoint_weights_locked && <div className="hint">End of term results are published, so these are fixed.</div>}
      {!draft && rule.checkpoint_weights_problems.map((p) => <div key={p} className="hint warn">{p}</div>)}
      {error && <div className="error">{error}</div>}
    </div>
  );
}