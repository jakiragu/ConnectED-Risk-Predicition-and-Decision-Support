import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  bandsFromLowerBounds, gradingPreview, gradingProblems, sameGrading,
  MISSING_POLICY_LABEL, MISSING_POLICY_HELP, MAX_BANDS, MAX_GRADE_LENGTH,
} from '@gradebook/domain/grading';
import { RISK_OUTCOME } from '@gradebook/domain/features';
import { gql } from '../api/graphql.js';
import { GET_GRADE_RULE } from '../api/operations.js';
import { LIST_TERMS_FULL } from '../api/calendarOperations.js';
import { GET_GRADING_POLICY, GET_GRADING_PREVIEW, SAVE_GRADING_POLICY, SET_TERM_GRADING } from '../api/settingsOperations.js';
import { ActionIcon, Notice } from './ui.jsx';
import { Field, Select } from './Field.jsx';
import { ScaleBar } from './charts.jsx';

const DEFAULT = 'default';
let rowKey = 0;
const toRows = (bands) => [...(bands || [])]
  .sort((a, b) => b.min_score - a.min_score)
  .map((b) => ({ key: ++rowKey, grade: b.grade, min_score: String(b.min_score) }));
const formOf = (rules) => ({
  pass_mark: rules?.pass_mark ?? '',
  missing_score_policy: rules?.missing_score_policy ?? 'EXCLUDE',
  rows: toRows(rules?.bands),
});
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/**
 * Grading rules at two levels, chosen at the top:
 *   - the school default, which every new term copies;
 *   - one term's own rules, which can change until any of its results are published.
 * Only the lowest mark of each grade is entered, so the scale cannot have gaps
 * or overlaps. Before saving, a preview shows how many students' grades in the
 * latest published term would change.
 */
export default function GradingSettings({ schoolId, onDirtyChange }) {
  const [terms, setTerms] = useState([]);
  const [target, setTarget] = useState(DEFAULT);
  const [policy, setPolicy] = useState(null);
  const [rule, setRule] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [offerTerm, setOfferTerm] = useState(null);
  const [saving, setSaving] = useState(false);

  const isDefault = target === DEFAULT;
  const saved = isDefault ? policy : rule;

  const load = useCallback(async () => {
    setError(null);
    const [{ getGradingPolicy }, { listTerms }] = await Promise.all([
      gql(GET_GRADING_POLICY, { school_id: schoolId }),
      gql(LIST_TERMS_FULL, { school_id: schoolId }),
    ]);
    setPolicy(getGradingPolicy);
    setTerms([...listTerms].sort((a, b) => (b.academic_year - a.academic_year) || (b.term_number - a.term_number)));
    return getGradingPolicy;
  }, [schoolId]);

  const loadRule = useCallback(async (termId) => {
    const { getGradeRule } = await gql(GET_GRADE_RULE, { school_id: schoolId, term_id: termId });
    setRule(getGradeRule);
    return getGradeRule;
  }, [schoolId]);

  useEffect(() => {
    load().then((p) => setForm(formOf(p))).catch((e) => setError(e.message));
    gql(GET_GRADING_PREVIEW, { school_id: schoolId }).then((d) => setPreview(d.getGradingPreview)).catch(() => setPreview(null));
  }, [load, schoolId]);

  // Switching between the default and a term loads that level's rules into the form.
  async function choose(next) {
    setNotice(null);
    setOfferTerm(null);
    setError(null);
    setTarget(next);
    if (next === DEFAULT) {
      setRule(null);
      setForm(formOf(policy));
      return;
    }
    setForm(null);
    try {
      setForm(formOf(await loadRule(next)));
    } catch (e) {
      setError(e.message);
    }
  }

  const built = useMemo(() => (form ? bandsFromLowerBounds(form.rows) : { bands: [], problems: [] }), [form]);
  const proposed = form ? { pass_mark: form.pass_mark === '' ? null : Number(form.pass_mark), missing_score_policy: form.missing_score_policy, bands: built.bands } : null;
  const problems = form
    ? [...new Set([...built.problems, ...(built.problems.length ? [] : gradingProblems(proposed)), ...(form.pass_mark === '' ? ['Enter a pass mark'] : [])])]
    : [];
  const dirty = Boolean(form && saved) && !sameGrading(proposed, saved);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const lockedReason = !isDefault ? rule?.grading_locked_reason : null;
  const termName = (id) => terms.find((t) => t.term_id === id)?.name ?? id;
  const current = terms.find((t) => t.status === 'CURRENT') ?? null;

  const effect = useMemo(() => {
    if (!preview?.marks?.length || !saved || !built.bands.length || built.problems.length) return null;
    return gradingPreview(preview.marks, saved.bands, built.bands);
  }, [preview, saved, built]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (key, patch) => setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const removeRow = (key) => setForm((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== key) }));
  const addRow = () => setForm((f) => ({ ...f, rows: [...f.rows, { key: ++rowKey, grade: '', min_score: '' }] }));
  const upperOf = (row) => built.bands.find((b) => b.grade === row.grade.trim())?.max_score;

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setOfferTerm(null);
    const input = {
      school_id: schoolId,
      pass_mark: Number(form.pass_mark),
      missing_score_policy: form.missing_score_policy,
      bands: form.rows.map((r) => ({ grade: r.grade.trim(), min_score: Number(r.min_score) })),
    };
    try {
      if (isDefault) {
        const { saveGradingPolicy } = await gql(SAVE_GRADING_POLICY, { input: { ...input, _version: policy._version } });
        setPolicy(saveGradingPolicy);
        setForm(formOf(saveGradingPolicy));
        setNotice('Default grading rules saved. New terms will use them.');
        // The current term keeps its own rules; offer to bring it in line while that is still possible.
        if (current) {
          const r = await loadRule(current.term_id).catch(() => null);
          if (r && !r.grading_locked_reason && !sameGrading(r, saveGradingPolicy)) setOfferTerm(current);
        }
      } else {
        const { setTermGrading } = await gql(SET_TERM_GRADING, { input: { ...input, term_id: target, _version: rule.grading_version } });
        setRule((r) => ({ ...r, ...setTermGrading }));
        setForm(formOf(setTermGrading));
        setNotice(`Grading rules for ${termName(target)} saved.`);
      }
    } catch (e) {
      setError(e.message);
      if (e.errorType === 'Conflict' || e.errorType === 'Locked') {
        if (isDefault) await load().then((p) => setForm(formOf(p))).catch(() => {});
        else await loadRule(target).then((r) => setForm(formOf(r))).catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  }

  async function applyToTerm(term) {
    setSaving(true);
    setError(null);
    try {
      const r = await loadRule(term.term_id);
      await gql(SET_TERM_GRADING, {
        input: {
          school_id: schoolId, term_id: term.term_id, pass_mark: policy.pass_mark, missing_score_policy: policy.missing_score_policy,
          bands: policy.bands.map((b) => ({ grade: b.grade, min_score: b.min_score })), _version: r.grading_version,
        },
      });
      setOfferTerm(null);
      setNotice(`${term.name} now uses the default grading rules too.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const options = [
    { value: DEFAULT, label: 'School default (used by new terms)' },
    ...terms.map((t) => ({ value: t.term_id, label: `${t.name}${t.status === 'CURRENT' ? ' (current)' : ''}` })),
  ];

  const lastChanged = isDefault
    ? (policy?.is_default ? 'Built-in scale: not changed by the school yet.' : policy?.updated_at && `Last changed ${when(policy.updated_at)}${policy.updated_by_name ? ` by ${policy.updated_by_name}` : ''}.`)
    : (rule?.grading_updated_at ? `Last changed ${when(rule.grading_updated_at)}${rule.grading_updated_by_name ? ` by ${rule.grading_updated_by_name}` : ''}.` : 'Copied when the term was created.');

  return (
    <div className="stack">
      <div className="settings-intro">
        <p>
          Grades, the pass mark and what happens to missing marks. The school default is copied into each new term;
          a term’s own rules can change until any of its results are published, then they are fixed so published grades never change.
        </p>
      </div>

      <div className="card settings-card">
        <Field label="Rules for" htmlFor="grading-target">
          <Select id="grading-target" value={target} onChange={choose} options={options} />
        </Field>
        {lastChanged && <p className="hint">{lastChanged}</p>}
        {lockedReason && <Notice tone="warn">{lockedReason}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        {offerTerm && (
          <div className="notice offer">
            <span>{offerTerm.name} still uses its earlier rules.</span>
            <button type="button" className="btn small" disabled={saving} onClick={() => applyToTerm(offerTerm)}>
              Apply the new default to {offerTerm.name} too
            </button>
          </div>
        )}
      </div>

      {!form && !error && <p className="hint">Loading…</p>}

      {form && (
        <fieldset className="plain-fieldset" disabled={Boolean(lockedReason) || saving}>
          <div className="card settings-card">
            <div className="settings-section-head">
              <h3>Grade bands</h3>
              <span className="hint">Enter the lowest mark for each grade. Each grade runs up to the one above it.</span>
            </div>

            {built.bands.length > 0 && !built.problems.length && <ScaleBar bands={built.bands} passMark={proposed.pass_mark} />}

            <div className="table-wrap">
              <table className="band-table">
                <thead>
                  <tr><th scope="col">Grade</th><th scope="col">From (mark)</th><th scope="col">To</th><th scope="col"><span className="sr-only">Remove</span></th></tr>
                </thead>
                <tbody>
                  {form.rows.map((r, i) => (
                    <tr key={r.key}>
                      <td>
                        <input className="band-grade" value={r.grade} maxLength={MAX_GRADE_LENGTH} aria-label={`Grade ${i + 1} name`}
                          onChange={(e) => setRow(r.key, { grade: e.target.value })} />
                      </td>
                      <td>
                        <input className="band-min" type="number" min="0" max="100" step="1" value={r.min_score}
                          aria-label={`Lowest mark for ${r.grade || `grade ${i + 1}`}`}
                          onChange={(e) => setRow(r.key, { min_score: e.target.value })} />
                      </td>
                      <td className="num">{upperOf(r) ?? '—'}</td>
                      <td className="actions">
                        <button type="button" className="btn link danger" aria-label={`Remove grade ${r.grade || i + 1}`} title="Remove"
                          disabled={form.rows.length <= 2} onClick={() => removeRow(r.key)}>
                          <ActionIcon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button type="button" className="btn secondary small" disabled={form.rows.length >= MAX_BANDS} onClick={addRow}>Add a grade</button>
            </div>
          </div>

          <div className="card settings-card">
            <div className="settings-section-head"><h3>Pass mark</h3></div>
            <div className="row">
              <input id="pass-mark" className="pass-input" type="number" min="0" max="100" value={form.pass_mark}
                aria-describedby="pass-help" aria-label="Pass mark" onChange={(e) => set({ pass_mark: e.target.value })} />
              <span>%</span>
            </div>
            <p className="hint" id="pass-help">
              Used for pass rates on class pages and in the rules teachers see. It does not change risk estimates: those flag
              students heading for {RISK_OUTCOME.description}, the definition the model was trained on.
            </p>
          </div>

          <div className="card settings-card">
            <div className="settings-section-head"><h3>When a mark is missing</h3></div>
            <div className="choices" role="radiogroup" aria-label="When a mark is missing">
              {Object.keys(MISSING_POLICY_LABEL).map((k) => (
                <label key={k} className={`choice${form.missing_score_policy === k ? ' active' : ''}`}>
                  <input type="radio" name="missing-policy" value={k} checked={form.missing_score_policy === k}
                    onChange={() => set({ missing_score_policy: k })} />
                  <span><b>{MISSING_POLICY_LABEL[k]}</b><br /><span className="hint">{MISSING_POLICY_HELP[k]}</span></span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>
      )}

      {form && (
        <div className={`card settings-card save-bar${dirty ? ' dirty' : ''}`}>
          <div className="grow">
            {problems.length > 0 && dirty && <div className="warn">{problems[0]}</div>}
            {!problems.length && dirty && effect && (
              <div>
                {effect.changed === 0
                  ? `No grades from ${preview.term_name} would change.`
                  : `${effect.changed} of ${effect.total} term results from ${preview.term_name} would get a different grade` +
                    ` (${effect.moves.slice(0, 3).map((m) => `${m.count} ${m.from} → ${m.to}`).join(', ')}${effect.moves.length > 3 ? ', …' : ''}).`}
                {!isDefault ? '' : ' Published grades are not changed; this shows the effect on terms that use these rules.'}
              </div>
            )}
            {!problems.length && dirty && !effect && <div className="hint">You have unsaved changes.</div>}
            {!dirty && <div className="hint">No unsaved changes.</div>}
          </div>
          {dirty && (
            <button type="button" className="btn secondary" disabled={saving} onClick={() => setForm(formOf(saved))}>Undo changes</button>
          )}
          <button type="button" className="btn" disabled={!dirty || problems.length > 0 || saving || Boolean(lockedReason)} onClick={save}>
            {saving ? 'Saving…' : isDefault ? 'Save default' : `Save for ${termName(target)}`}
          </button>
        </div>
      )}
    </div>
  );
}
