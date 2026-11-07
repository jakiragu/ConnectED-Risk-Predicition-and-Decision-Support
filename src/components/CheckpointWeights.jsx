import { useCallback, useEffect, useState } from 'react';
import { gql } from '../api/graphql.js';
import { GET_GRADE_RULE, SET_CHECKPOINT_WEIGHTS } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCheckpointSetup } from '../offline/useCheckpointSetup.js';
import { Link } from 'react-router-dom';
import { Info } from './ui.jsx';

const FIELDS = [
  { key: 'opener', checkpoint: 'OPENER' },
  { key: 'midterm', checkpoint: 'MIDTERM' },
  { key: 'endterm', checkpoint: 'ENDTERM' },
];

/**
 * The term's exam setup: whether it holds an Opener and how much each
 * checkpoint counts towards the term result. Both apply to every class in the
 * term, so only an administrator changes them (Settings -> Exams and weights);
 * everyone else sees them read-only, for example on the Assessments page.
 * An Opener that is held may weigh 0%: it is then published and on report
 * cards, but does not count towards the term result.
 */
export default function CheckpointWeights({ schoolId, termId, online, onChanged, onDirtyChange, readOnly = false, title = 'Exams and weights this term' }) {
  const { isAdmin } = useAuth();
  const setup = useCheckpointSetup(schoolId, termId);
  const [rule, setRule] = useState(null);
  const [draft, setDraft] = useState(null);
  const [openerDraft, setOpenerDraft] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!termId || !online) return;
    const { getGradeRule } = await gql(GET_GRADE_RULE, { school_id: schoolId, term_id: termId });
    setRule(getGradeRule);
    setDraft(null);
    setOpenerDraft(null);
  }, [schoolId, termId, online]);

  useEffect(() => {
    setError(null);
    load().catch((e) => setError(e.message));
  }, [load]);

  const editable = isAdmin && !readOnly;
  const dirtyNow = Boolean(draft) || (openerDraft !== null && rule && openerDraft !== rule.opener_enabled);
  useEffect(() => { onDirtyChange?.(Boolean(dirtyNow)); }, [dirtyNow, onDirtyChange]);

  if (!online) return null;
  if (!rule) return error ? <div className="card error-card">{error}</div> : null;

  const locked = rule.checkpoint_weights_locked || !editable;
  const openerEnabled = openerDraft ?? rule.opener_enabled;
  const fields = FIELDS.filter((f) => openerEnabled || f.checkpoint !== 'OPENER');
  const current = rule.checkpoint_weights || {};
  const baseValues = draft || {
    opener: current.opener ?? '',
    midterm: current.midterm ?? '',
    endterm: current.endterm ?? '',
  };
  // No Opener this term: it weighs nothing.
  const effective = openerEnabled ? baseValues : { ...baseValues, opener: 0 };

  const unfilled = fields.filter((f) => effective[f.key] === '' || effective[f.key] == null);
  const enteredTotal = fields.reduce(
    (total, f) => total + (effective[f.key] === '' ? 0 : Number(effective[f.key]) || 0),
    0
  );
  const autoFilledKey = unfilled.length === 1 && enteredTotal <= 100 ? unfilled[0].key : null;
  const values = autoFilledKey ? { ...effective, [autoFilledKey]: 100 - enteredTotal } : effective;
  const total = fields.reduce((t, f) => t + (Number(values[f.key]) || 0), 0);
  const dirty = Boolean(draft) || (openerDraft !== null && openerDraft !== rule.opener_enabled);

  function toggleOpener(on) {
    setOpenerDraft(on);
    // Keep the weights consistent with the choice: a removed Opener gives its weight back.
    if (!on) setDraft({ ...baseValues, opener: 0 });
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const { setCheckpointWeights } = await gql(SET_CHECKPOINT_WEIGHTS, {
        input: {
          school_id: schoolId,
          term_id: termId,
          opener: Number(values.opener) || 0,
          midterm: Number(values.midterm),
          endterm: Number(values.endterm),
          ...(openerDraft !== null ? { opener_enabled: openerDraft } : {}),
          _version: rule.checkpoint_weights_version,
        },
      });
      setRule(setCheckpointWeights);
      setDraft(null);
      setOpenerDraft(null);
      await setup.reload();
      onChanged?.(setCheckpointWeights);
    } catch (e) {
      setError(e.message);
      if (e.errorType === 'Conflict' || e.errorType === 'Locked') await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  const openerName = setup.label('OPENER');

  // Everyone but an administrator in Settings sees the term's setup as a plain summary, not as disabled inputs.
  if (!editable) {
    const w = rule.checkpoint_weights;
    const set = rule.checkpoint_weights_problems.length === 0 && w;
    const parts = [
      ...(rule.opener_enabled ? [{ key: 'OPENER', weight: w?.opener }] : []),
      { key: 'MIDTERM', weight: w?.midterm },
      { key: 'ENDTERM', weight: w?.endterm },
    ];
    return (
      <div className="card weights-summary">
        <div className="weights-summary-head">
          <h2>How exams count this term</h2>
          {isAdmin && !rule.checkpoint_weights_locked && <Link to="/settings/exams">Change in Settings</Link>}
        </div>
        {set ? (
          <ul className="weight-chips" aria-label="Exam weights">
            {parts.map((p) => (
              <li key={p.key}>
                <span>{setup.label(p.key)}</span>
                <b>{p.weight ?? 0}%</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint warn">The weights for this term have not been set yet, so End-term results cannot be calculated.
            {isAdmin ? ' Set them in Settings, Exams and weights.' : ' An administrator sets them.'}</p>
        )}
        <p className="hint">
          {rule.opener_enabled ? `This term holds an ${openerName}. ` : `This term has no ${openerName}. `}
          {set && 'Each subject’s term result combines its exam results in these proportions.'}
          {rule.checkpoint_weights_locked && ' End-term results are published, so these are final.'}
        </p>
      </div>
    );
  }
  const canToggle = editable && !rule.checkpoint_weights_locked && !rule.opener_locked_reason;

  return (
    <div className="card weights-card">
      <div className="weights-head">
        <h2>{title}</h2>

        <Info label="About checkpoint weights">
          The weights decide how much each exam contributes to the term result, and must add up to 100%.
          An {openerName} can be held with a weight of 0%: its results are still published and printed on
          report cards, but do not count towards the term result. Whether the term holds an {openerName} can
          be changed by an administrator until results that depend on it are published.
        </Info>
      </div>

      <div className="weights-row">
        <label className="weight-input" title={!canToggle ? rule.opener_locked_reason || undefined : undefined}>
          <input
            type="checkbox"
            checked={openerEnabled}
            disabled={!canToggle}
            onChange={(e) => toggleOpener(e.target.checked)}
          />
          <span>This term holds an {openerName}</span>
        </label>
      </div>

      <div className="weights-row">
        {fields.map((f) => (
          <label key={f.key} className="weight-input">
            <span>{setup.label(f.checkpoint)}</span>
            <input
              type="number"
              min="0"
              max="100"
              value={values[f.key]}
              disabled={locked}
              onChange={(e) => setDraft({ ...effective, [f.key]: e.target.value })}
            />
            <span>%</span>
            {autoFilledKey === f.key && <small className="hint">Automatically calculated</small>}
          </label>
        ))}
        <span className={`budget ${total === 100 ? '' : 'warn'}`}>Total: <b>{total}%</b></span>
        {!locked && (
          <button type="button" className="btn" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving' : 'Save'}
          </button>
        )}
      </div>
      {openerEnabled && Number(values.opener) === 0 && (
        <div className="hint">The {openerName} is held but weighs 0%: it is reported, not counted.</div>
      )}
      {rule.checkpoint_weights_locked && <div className="hint">End of term results are published, so these are fixed.</div>}
      {editable && !rule.checkpoint_weights_locked && rule.opener_locked_reason && <div className="hint">{rule.opener_locked_reason}</div>}

      {!dirty && rule.checkpoint_weights_problems.map((p) => <div key={p} className="hint warn">{p}</div>)}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
