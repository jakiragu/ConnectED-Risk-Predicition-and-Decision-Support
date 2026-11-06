import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { CREATE_CLASS, DELETE_CLASS, LIST_SCHOOL_CLASSES, UPDATE_CLASS } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Offline, DangerButton, ActionIcon } from '../components/ui.jsx';
import { Field, Select } from '../components/Field.jsx';
import { GET_CLASS_SETUP } from '../api/settingsOperations.js';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';

const EMPTY = { grade: '', stream: '', year: new Date().getFullYear() };

/**
 * A form or stream field: a choice from the school's lists once they are saved
 * in Settings (the server then only accepts those), otherwise free text. A
 * class created before the lists keeps its value as an extra choice.
 */
function ClassField({ id, label, kind, value, onChange, setup, placeholder, inTable = false }) {
  const list = setup?._version > 0 ? setup[kind] : null;
  const control = list ? (
    <Select id={id} aria-label={inTable ? label : undefined} value={value} onChange={onChange} placeholder={`Choose a ${label.toLowerCase()}`}
      options={value && !list.includes(value) ? [...list, value] : list} required />
  ) : (
    <input id={id} aria-label={inTable ? label : undefined} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} required />
  );
  return inTable ? control : <Field label={label} htmlFor={id}>{control}</Field>;
}

/** Teachers: the classes they work in, and what they teach there. Works offline from the cache. */
function MyClasses({ schoolId }) {
  const [error, setError] = useState(null);
  const classes = useLive(() => db().classes.toArray(), [], null);

  useEffect(() => {
    repository.loadClasses(schoolId).catch((e) => setError(e.message));
  }, [schoolId]);

  const sorted = (classes || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="page-head"><h1>Your classes</h1></div>
      {error && <div className="card error-card">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Class</th><th>Year</th><th>You teach</th><th>Role</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {classes && sorted.length === 0 && (
              <tr className="empty">
                <td colSpan={6}>No classes yet. Ask an administrator to assign you a subject in a class.</td>
              </tr>
            )}
            {sorted.map((c) => (
              <tr key={c.class_id}>
                <td><Link to={`/classes/${c.class_id}`}>{c.name}</Link></td>
                <td>{c.year}</td>
                <td>{(c.my_subjects || []).join(', ') || <span className="hint">No subjects</span>}</td>
                <td>{c.is_class_teacher ? <b>Class teacher</b> : 'Subject teacher'}</td>
                <td>{c.status === 'CURRENT' ? 'Current' : 'Past'}</td>
                <td className="actions">
                  <Link to={`/assessments?class=${c.class_id}`}>Assessments</Link>
                  <Link to={`/classes/${c.class_id}/students`}>{c.is_class_teacher ? 'Manage students' : 'Students'}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EditRow({ klass, setup, onSave, onCancel }) {
  const [f, setF] = useState({ name: klass.name, grade: klass.grade, stream: klass.stream, year: klass.year });
  return (
    <tr className="row-dirty">
      <td><input aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></td>
      <td><ClassField inTable id={`e-grade-${klass.class_id}`} label="Form" kind="forms" setup={setup} value={f.grade} onChange={(v) => setF({ ...f, grade: v })} /></td>
      <td><ClassField inTable id={`e-stream-${klass.class_id}`} label="Stream" kind="streams" setup={setup} value={f.stream} onChange={(v) => setF({ ...f, stream: v })} /></td>
      <td><input aria-label="Year" type="number" value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} /></td>
      <td colSpan={3} />
      <td className="actions">
        <button type="button" className="btn link" onClick={() => onSave(f)}>Save</button>
        <button type="button" className="btn link" onClick={onCancel}>Cancel</button>
      </td>
    </tr>
  );
}

/** Admin: every class, with create, edit, archive and delete-when-empty. */
function SchoolClasses({ schoolId }) {
  const { online } = useSync();
  const [classes, setClasses] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [setup, setSetup] = useState(null);
  useEffect(() => {
    gql(GET_CLASS_SETUP, { school_id: schoolId }).then((d) => setSetup(d.getClassSetup)).catch(() => setSetup(null));
  }, [schoolId]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    const { listSchoolClasses } = await gql(LIST_SCHOOL_CLASSES, { school_id: schoolId });
    setClasses(listSchoolClasses);
    repository.loadClasses(schoolId).catch(() => {}); // keep the offline cache in step
  }, [schoolId]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function run(mutation, input, done) {
    setError(null);
    setNotice(null);
    let succeeded = false;
    try {
      await gql(mutation, { input: { school_id: schoolId, ...input } });
      succeeded = true;
      setNotice(done);
      setEditing(null);
    } catch (e) {
      setError(e.message);
    } finally {
      await load().catch(() => {});
    }
    return succeeded;
  }

  async function create(e) {
    e.preventDefault();
    const created = await run(CREATE_CLASS, { ...form, year: Number(form.year) }, `${form.grade} ${form.stream} added`);
    if (created) setForm(EMPTY);
  }

  if (!online) return <Offline what="Managing classes" />;

  return (
    <>
      <div className="page-head"><h1>Classes</h1></div>
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <form className="card stack" onSubmit={create}>
        <h2>Add a class</h2>
        <div className="weights-row">
          <ClassField id="c-grade" label="Form" kind="forms" setup={setup} placeholder="Form 4" value={form.grade} onChange={(v) => setForm({ ...form, grade: v })} />
          <ClassField id="c-stream" label="Stream" kind="streams" setup={setup} placeholder="South" value={form.stream} onChange={(v) => setForm({ ...form, stream: v })} />
          <Field label="Year" htmlFor="c-year">
            <input id="c-year" type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} required />
          </Field>
          <button className="btn" type="submit">Add class</button>
        </div>
        {setup && !(setup._version > 0) && (
          <p className="hint">Tip: list your school’s forms and streams in <Link to="/settings/classes">Settings, Classes</Link> to choose them here instead of typing.</p>
        )}
        <div className="hint">Assign subject teachers and the class teacher from the Teachers page.</div>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Class</th><th>Form</th><th>Stream</th><th>Year</th><th>Class teacher</th><th>Students</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {classes.map((c) =>
              editing === c.class_id ? (
                <EditRow key={c.class_id} klass={c} setup={setup} onCancel={() => setEditing(null)}
                  onSave={(f) => run(UPDATE_CLASS, { class_id: c.class_id, ...f, _version: c._version }, `${f.name} saved`)} />
              ) : (
                <tr key={c.class_id}>
                  <td><Link to={`/classes/${c.class_id}`}>{c.name}</Link></td>
                  <td>{c.grade}</td>
                  <td>{c.stream}</td>
                  <td>{c.year}</td>
                  <td>{c.class_teacher_name || <span className="hint">None</span>}</td>
                  <td>{c.student_count}</td>
                  <td>{c.status === 'CURRENT' ? 'Current' : 'Past'}</td>
                  <td className="actions">
                    <Link to={`/classes/${c.class_id}/students`}
                      className="btn link" aria-label={`View students in ${c.name}`} title="Students"
                    >
                      <ActionIcon name="users" />
                    </Link>

                    <Link to={`/assessments?class=${c.class_id}`}
                      className="btn link" aria-label={`View assessments for ${c.name}`} title="Assessments"
                    >
                      <ActionIcon name="clipboard" />
                    </Link>

                    <button type="button" className="btn link" aria-label={`Edit ${c.name}`} title="Edit"
                      onClick={() => setEditing(c.class_id)}
                    >
                      <ActionIcon name="edit" />
                    </button>

                    <button type="button" className="btn link" aria-label={c.status === 'CURRENT' ? `Archive ${c.name}` : `Restore ${c.name}`} title={c.status === 'CURRENT' ? 'Archive' : 'Restore'}
                      onClick={() =>
                        run(
                          UPDATE_CLASS,
                          {
                            class_id: c.class_id,
                            status: c.status === 'CURRENT' ? 'PAST' : 'CURRENT',
                            _version: c._version,
                          },
                          c.status === 'CURRENT'
                            ? `${c.name} archived`
                            : `${c.name} restored`
                        )
                      }
                    >
                      <ActionIcon name={c.status === 'CURRENT' ? 'archive' : 'restore'} />
                    </button>

                    <DangerButton className="link" aria-label={`Delete ${c.name}`} title="Delete"
                      onClick={() =>
                        window.confirm(`Delete ${c.name}? Only an empty class can be deleted.`)
                        && run(
                          DELETE_CLASS,
                          { class_id: c.class_id, _version: c._version },
                          `${c.name} deleted`
                        )
                      }
                    >
                      <ActionIcon name="trash" />
                    </DangerButton>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Classes() {
  const { actor, isAdmin } = useAuth();
  return isAdmin ? <SchoolClasses schoolId={actor.schoolId} /> : <MyClasses schoolId={actor.schoolId} />;
}