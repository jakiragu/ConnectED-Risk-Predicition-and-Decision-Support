import { FREQUENCIES, FREQUENCY_LABEL, methodKey } from '@gradebook/domain/decision';
import { ActionIcon } from './ui.jsx';

/**
 * The parts of logging an intervention that the one-student form and the
 * several-students form share, so both read and behave the same: the fields,
 * and the methods other teachers in the school have used. The system suggests
 * from what teachers did; it never chooses an intervention.
 */

/** The intervention's fields. factors: show the subject picker with these choices. */
export function InterventionEditor({ value, onChange, factors, idPrefix, methodRef, factorNote }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="editor">
      {factors && (
        <label htmlFor={`${idPrefix}-factor`}>For
          <select id={`${idPrefix}-factor`} value={value.factor} onChange={set('factor')}>
            {factors.map((f) => <option key={f} value={f}>{factorNote ? factorNote(f) : f}</option>)}
          </select>
        </label>
      )}
      <label htmlFor={`${idPrefix}-method`} className="wide">What will be done
        <input id={`${idPrefix}-method`} ref={methodRef} value={value.method} onChange={set('method')} maxLength={200}
          placeholder="For example: weekly past papers, marked on Fridays" />
      </label>
      <label htmlFor={`${idPrefix}-frequency`}>How often
        <select id={`${idPrefix}-frequency`} value={value.frequency} onChange={set('frequency')}>
          {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
        </select>
      </label>
      <label htmlFor={`${idPrefix}-start`}>Starts
        <input id={`${idPrefix}-start`} type="date" value={value.started_on} onChange={set('started_on')} />
      </label>
      <label htmlFor={`${idPrefix}-expected`} className="wide">Expected outcome (optional)
        <input id={`${idPrefix}-expected`} value={value.expected_outcome ?? ''} onChange={set('expected_outcome')} maxLength={1000} />
      </label>
      <label htmlFor={`${idPrefix}-notes`} className="wide">Notes (optional)
        <textarea id={`${idPrefix}-notes`} rows={2} value={value.notes ?? ''} onChange={set('notes')} maxLength={1000} />
      </label>
    </div>
  );
}

/**
 * Methods teachers in the school have used for a subject. "Use" copies one into
 * the form; it does not save anything. ongoing: method keys this student
 * already has under way for the subject, shown instead of offered again.
 */
export function MethodSuggestions({ factor, methods, search, onSearch, current, onUse, ongoing = new Set() }) {
  const shown = methods.filter((m) => !search || m.method.toLowerCase().includes(search.toLowerCase()));
  const currentKey = methodKey(current || '');
  return (
    <aside className="card stack suggestions" aria-labelledby="suggestions-title">
      <div className="stack tight">
        <h2 id="suggestions-title">Used by teachers for {factor}</h2>
        <span className="hint">Choose one to copy it into the form. Nothing is saved until you save.</span>
      </div>
      {methods.length > 3 && (
        <input type="search" aria-label={`Search methods used for ${factor}`} placeholder="Search" value={search} onChange={(e) => onSearch(e.target.value)} />
      )}
      {methods.length === 0 && <div className="hint">No interventions recorded for {factor} yet. Yours will appear here for other teachers.</div>}
      {methods.length > 0 && shown.length === 0 && <div className="hint">Nothing matches “{search}”.</div>}
      <ul className="plain">
        {shown.map((m) => {
          const key = methodKey(m.method);
          const inForm = key === currentKey;
          const under = ongoing.has(key);
          return (
            <li key={m.method} className={`suggestion${inForm ? ' in-form' : ''}`}>
              <span className="what">
                {m.method}
                <span className="hint">Used by {m.teachers_used} teacher{m.teachers_used === 1 ? '' : 's'}</span>
              </span>
              {under ? (
                <span className="pill neutral" title="This student already has it under way">Ongoing</span>
              ) : inForm ? (
                <span className="pill recorded"><ActionIcon name="check" />In form</span>
              ) : (
                <button type="button" className="btn secondary small icon-text" aria-label={`Use “${m.method}”`} onClick={() => onUse(m.method)}>
                  <ActionIcon name="plus" />Use
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
