import { useCallback, useEffect, useState } from 'react';
import { normaliseSetup, MAX_NAME } from '@gradebook/domain/classSetup';
import { gql } from '../api/graphql.js';
import { LIST_SCHOOL_CLASSES } from '../api/operations.js';
import { GET_CLASS_SETUP, SAVE_CLASS_SETUP } from '../api/settingsOperations.js';
import { Notice } from './ui.jsx';

const pathsFor = (setup) => setup.progression_paths ?? [...new Set(setup.forms.map((f) => /^grade /i.test(f) ? 'GRADE' : 'FORM'))];
const fieldsFor = (setup) => ({ forms: setup.forms, streams: setup.streams, progression_paths: pathsFor(setup) });

/** A list of names edited as removable chips, with a box to add more. */
function ListEditor({ id, label, hint, values, onChange, placeholder }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim().replace(/\s+/g, ' ');
    if (!v) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setText('');
  };
  return (
    <div className="list-editor">
      <label htmlFor={id}><b>{label}</b></label>
      <p className="hint">{hint}</p>
      <ul className="chip-list" aria-label={label}>
        {values.map((v) => (
          <li key={v} className="chip">
            {v}
            <button type="button" className="chip-remove" aria-label={`Remove ${v}`} title={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </li>
        ))}
        {!values.length && <li className="hint">None yet.</li>}
      </ul>
      <div className="row">
        <input id={id} value={text} maxLength={MAX_NAME} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn secondary small" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
    </div>
  );
}

/**
 * The forms and streams classes are created with. Once saved, the class form
 * offers only these, so names stay consistent. Existing classes never change.
 */
export default function ClassSetupSettings({ schoolId, onDirtyChange }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [{ getClassSetup }, { listSchoolClasses }] = await Promise.all([
      gql(GET_CLASS_SETUP, { school_id: schoolId }),
      gql(LIST_SCHOOL_CLASSES, { school_id: schoolId }),
    ]);
    setSaved(getClassSetup);
    setForm(fieldsFor(getClassSetup));
    setClasses(listSchoolClasses);
  }, [schoolId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const dirty = Boolean(form && saved) && (saved.is_default || JSON.stringify(form) !== JSON.stringify(fieldsFor(saved)));
  useEffect(() => { onDirtyChange?.(Boolean(form && saved) && JSON.stringify(form) !== JSON.stringify(fieldsFor(saved))); }, [form, saved, onDirtyChange]);
  if (!form) return error ? <Notice tone="error">{error}</Notice> : <p className="hint">Loading…</p>;

  const { problems } = normaliseSetup(form);
  const lower = (list) => list.map((x) => x.toLowerCase());
  const outside = classes.filter((c) => c.status === 'CURRENT'
    && (!lower(form.forms).includes(String(c.grade).toLowerCase()) || !lower(form.streams).includes(String(c.stream).toLowerCase())));

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { saveClassSetup } = await gql(SAVE_CLASS_SETUP, { input: { school_id: schoolId, ...form, _version: saved._version } });
      setSaved(saveClassSetup);
      setForm(fieldsFor(saveClassSetup));
      setNotice('Forms and streams saved. New and edited classes now use these lists.');
    } catch (e) {
      setError(e.message);
      if (e.errorType === 'Conflict') await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="settings-intro">
        <p>
          The forms and streams your school runs. When a class is created or edited, its form and stream are chosen from these
          lists, so every class is named the same way. Existing classes keep their names when the lists change.
        </p>
      </div>
      {saved.is_default && (
        <Notice>These lists are taken from your existing classes and are not enforced yet. Save them to start using them.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      <div className="card settings-card two-col">
        <ListEditor id="forms-add" label="Forms" hint="Year groups, for example Form 1 to Form 4. Available class levels are independent of the progression paths below."
          values={form.forms} placeholder="Form 1" onChange={(forms) => setForm({ ...form, forms })} />
        <ListEditor id="streams-add" label="Streams" hint="The streams within each form, for example East and West."
          values={form.streams} placeholder="East" onChange={(streams) => setForm({ ...form, streams })} />
      </div>
      <div className="card settings-card stack"><h3>Academic progression paths</h3><p className="hint">Choose the curricula the school uses, including future levels. A passing student progresses one level at a time; only Form 4 or Grade 12 can graduate.</p>
        {[['FORM', 'Form 1 → Form 2 → Form 3 → Form 4 → Graduate'], ['GRADE', 'Grade 10 → Grade 11 → Grade 12 → Graduate']].map(([key, label]) => <label key={key}><input type="checkbox" checked={form.progression_paths.includes(key)} onChange={(e) => setForm({ ...form, progression_paths: e.target.checked ? [...form.progression_paths, key] : form.progression_paths.filter((p) => p !== key) })} /> {label}</label>)}
      </div>
      {outside.length > 0 && (
        <div className="card settings-card">
          <h3>Current classes outside these lists</h3>
          <p className="hint">They keep working as they are. To change one, edit it on the Classes page.</p>
          <p>{outside.map((c) => c.name).join(', ')}</p>
        </div>
      )}
      <div className={`card settings-card save-bar${dirty ? ' dirty' : ''}`}>
        <div className="grow">
          {dirty && problems.length > 0 && <div className="warn">{problems[0]}</div>}
          {dirty && !problems.length && <div className="hint">{saved.is_default ? 'Not saved yet.' : 'You have unsaved changes.'}</div>}
          {!dirty && <div className="hint">No unsaved changes.</div>}
        </div>
        {dirty && !saved.is_default && (
          <button type="button" className="btn secondary" disabled={saving} onClick={() => setForm(fieldsFor(saved))}>Undo changes</button>
        )}
        <button type="button" className="btn" disabled={!dirty || problems.length > 0 || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save forms and streams'}
        </button>
      </div>
    </div>
  );
}
