import { useCallback, useEffect, useMemo, useState } from 'react';
import { attendancePeriods, validateTerm } from '@gradebook/domain/calendar';
import { gql } from '../api/graphql.js';
import { CREATE_TERM, LIST_TERMS_FULL, UPDATE_TERM } from '../api/calendarOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';
import '../styles/calendar.css';

const EMPTY_CLOSURE = { from: '', to: '', label: '' };
const blankTerm = (year) => ({
  academic_year: year, term_number: '1', start_date: '', mid_term_date: '', end_date: '', closures: [], name: '',
});

function TermEditor({ term, siblings, onSave, onCancel, busy }) {
  const [form, setForm] = useState(() => ({
    ...term,
    term_number: String(term.term_number ?? ''),
    closures: (term.closures || []).map((c) => ({ from: c.from, to: c.to, label: c.label || '' })),
  }));
  const isNew = !term.term_id;
  const candidate = {
    ...form,
    term_id: term.term_id,
    academic_year: Number(form.academic_year),
    term_number: Number(form.term_number),
    closures: form.closures.filter((c) => c.from).map((c) => ({ from: c.from, to: c.to || c.from, label: c.label || null })),
  };
  const problems = validateTerm(candidate, siblings);
  const periods = problems.length ? [] : attendancePeriods(candidate);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target ? e.target.value : e });
  const setClosure = (i, patch) => setForm({ ...form, closures: form.closures.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <form className="card term-card" onSubmit={(e) => { e.preventDefault(); onSave(candidate); }}>
      <h2>{isNew ? 'Add a term' : `Edit ${term.name}`}</h2>
      <div className="term-dates">
        {isNew && (
          <>
            <Field label="School year" htmlFor="t-year">
              <input id="t-year" type="number" value={form.academic_year} onChange={set('academic_year')} required />
            </Field>
            <Field label="Term" htmlFor="t-number">
              <Select id="t-number" value={form.term_number} onChange={set('term_number')}
                options={[{ value: '1', label: 'Term 1' }, { value: '2', label: 'Term 2' }, { value: '3', label: 'Term 3' }]} />
            </Field>
          </>
        )}
        <Field label="Opens" htmlFor="t-start">
          <input id="t-start" type="date" value={form.start_date || ''} onChange={set('start_date')} required />
        </Field>
        <Field label="Mid-term" htmlFor="t-mid" hint="Last day of the first attendance period">
          <input id="t-mid" type="date" value={form.mid_term_date || ''} onChange={set('mid_term_date')} required />
        </Field>
        <Field label="Closes" htmlFor="t-end">
          <input id="t-end" type="date" value={form.end_date || ''} onChange={set('end_date')} required />
        </Field>
      </div>

      <div className="stack">
        <h3>Days the school is closed</h3>
        <div className="hint">Weekends are never school days. List half-term breaks and public holidays that fall on weekdays.</div>
        {form.closures.map((c, i) => (
          <div className="closure-row" key={i}>
            <input type="date" aria-label="Closed from" value={c.from} onChange={(e) => setClosure(i, { from: e.target.value })} />
            <span>to</span>
            <input type="date" aria-label="Closed to" value={c.to} onChange={(e) => setClosure(i, { to: e.target.value })} />
            <input aria-label="Reason" placeholder="e.g. Half-term break" value={c.label} onChange={(e) => setClosure(i, { label: e.target.value })} />
            <button type="button" className="btn link danger" onClick={() => setForm({ ...form, closures: form.closures.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="btn link" onClick={() => setForm({ ...form, closures: [...form.closures, EMPTY_CLOSURE] })}>Add a closure</button></div>
      </div>

      {problems.length > 0 ? (
        <div className="error">{problems[0].message}</div>
      ) : (
        <div className="budget-row">
          {periods.map((p) => (
            <span key={p.period} className="period-chip">
              {p.period === 'MIDTERM' ? 'Start to Mid-term' : 'Mid-term to end'}: <b>{p.school_days}</b> school days ({p.from} to {p.to})
            </span>
          ))}
        </div>
      )}

      <div className="weights-row">
        <button className="btn" type="submit" disabled={busy || problems.length > 0}>{isNew ? 'Add term' : 'Save dates'}</button>
        <button type="button" className="btn link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Terms() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [terms, setTerms] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { listTerms } = await gql(LIST_TERMS_FULL, { school_id: actor.schoolId });
    setTerms(listTerms);
    repository.loadTerms(actor.schoolId).catch(() => {}); // keep the cached term list in step
  }, [actor.schoolId]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  const years = useMemo(() => [...new Set(terms.map((t) => t.academic_year))].sort((a, b) => b - a), [terms]);
  const nextYear = years.length ? Math.max(...years) + 1 : new Date().getFullYear();

  async function save(candidate) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const isNew = !editing.term_id;
    try {
      const closures = candidate.closures;
      if (isNew) {
        await gql(CREATE_TERM, {
          input: {
            school_id: actor.schoolId, academic_year: candidate.academic_year, term_number: candidate.term_number,
            start_date: candidate.start_date, mid_term_date: candidate.mid_term_date, end_date: candidate.end_date,
            closures, name: candidate.name || null,
          },
        });
      } else {
        await gql(UPDATE_TERM, {
          input: {
            school_id: actor.schoolId, term_id: editing.term_id, start_date: candidate.start_date,
            mid_term_date: candidate.mid_term_date, end_date: candidate.end_date, closures, _version: editing._version,
          },
        });
      }
      setNotice(isNew ? 'Term added' : 'Term saved');
      setEditing(null);
    } catch (e) {
      setError(e.message);
    } finally {
      await load().catch(() => {});
      setBusy(false);
    }
  }

  if (!online) return <div className="notice">Managing the calendar needs a connection.</div>;

  return (
    <>
      <div className="page-head">
        <h1>Terms</h1>
        {!editing && <button type="button" className="btn" onClick={() => setEditing(blankTerm(nextYear))}>Add a term</button>}
      </div>
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {editing && <TermEditor term={editing} siblings={terms} busy={busy} onSave={save} onCancel={() => setEditing(null)} />}

      {years.map((year) => (
        <div key={year} className="stack">
          <h2>School year {year}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Term</th><th>Opens</th><th>Mid-term</th><th>Closes</th><th>Closures</th><th>School days</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                {terms.filter((t) => t.academic_year === year).sort((a, b) => a.term_number - b.term_number).map((t) => (
                  <tr key={t.term_id}>
                    <td>{t.name}</td>
                    <td>{t.start_date}</td>
                    <td>{t.mid_term_date || <span className="warn">Not set</span>}</td>
                    <td>{t.end_date}</td>
                    <td>{t.closures.length ? t.closures.map((c) => c.label || `${c.from}`).join(', ') : '—'}</td>
                    <td>{t.periods.length ? `${t.periods[0].school_days} + ${t.periods[1].school_days} = ${t.school_days}` : '—'}</td>
                    <td>{t.status === 'CURRENT' ? <b>Current</b> : t.status === 'PAST' ? 'Past' : 'Upcoming'}</td>
                    <td className="actions">
                      <button type="button" className="btn link" onClick={() => setEditing(t)}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}