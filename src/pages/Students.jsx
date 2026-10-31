import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { CREATE_STUDENT, LIST_STUDENTS, SET_STUDENT_STATUS, TRANSFER_STUDENT, UPDATE_STUDENT } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { DangerButton, ActionIcon } from '../components/ui.jsx';

const EMPTY = { first_name: '', last_name: '', admission_no: '' };

export default function Students() {
  const { classId } = useParams();
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const klass = classes.find((c) => c.class_id === classId);
  const canManage = isAdmin || Boolean(klass?.is_class_teacher);

  const [students, setStudents] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [transfer, setTransfer] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    const { listStudents } = await gql(LIST_STUDENTS, { school_id: actor.schoolId, class_id: classId, include_inactive: true });
    setStudents(listStudents);
  }, [actor.schoolId, classId]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function run(mutation, input, done) {
    setError(null);
    setNotice(null);
    try {
      await gql(mutation, { input: { school_id: actor.schoolId, ...input } });
      setNotice(done);
      setEditing(null);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      await load().catch(() => {});
    }
  }

  async function add(e) {
    e.preventDefault();
    if (await run(CREATE_STUDENT, { class_id: classId, ...form }, `${form.first_name} ${form.last_name} added`)) setForm(EMPTY);
  }

  const shown = students.filter((s) => showInactive || s.status === 'ACTIVE');
  const inactive = students.filter((s) => s.status !== 'ACTIVE').length;
  const destinations = classes.filter((c) => c.class_id !== classId && c.status === 'CURRENT');

  if (!online) return <div className="notice">Managing students needs a connection.</div>;

  return (
    <>
      <div className="page-head">
        <Link to="/classes">Back</Link>
        <h1>{klass?.name || 'Class'}: students</h1>
        <span className="hint">{students.length - inactive} active{inactive ? `, ${inactive} deactivated` : ''}</span>
      </div>
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {!canManage && <div className="notice">Only the class teacher or an administrator can change this list.</div>}

      {canManage && klass?.status === 'CURRENT' && (
        <form className="card stack" onSubmit={add}>
          <h2>Add a student</h2>
          <div className="weights-row">
            <Field label="First name" htmlFor="s-first">
              <input id="s-first" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </Field>
            <Field label="Last name" htmlFor="s-last">
              <input id="s-last" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
            </Field>
            <Field label="Admission no" htmlFor="s-adm">
              <input id="s-adm" value={form.admission_no} onChange={(e) => setForm({ ...form, admission_no: e.target.value })} required />
            </Field>
            <button className="btn" type="submit">Add student</button>
          </div>
        </form>
      )}

      <label className="choice-inline">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated students
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Admission no</th><th>First name</th><th>Last name</th><th>Status</th><th>Risk</th>{canManage && <th>Action</th>}</tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr className="empty"><td colSpan={6}>No students.</td></tr>}
            {shown.map((s) =>
              editing === s.student_id ? (
                <tr key={s.student_id} className="row-dirty">
                  <td><input aria-label="Admission no" value={draft.admission_no} onChange={(e) => setDraft({ ...draft, admission_no: e.target.value })} /></td>
                  <td><input aria-label="First name" value={draft.first_name} onChange={(e) => setDraft({ ...draft, first_name: e.target.value })} /></td>
                  <td><input aria-label="Last name" value={draft.last_name} onChange={(e) => setDraft({ ...draft, last_name: e.target.value })} /></td>
                  <td />
                  <td />
                  <td className="actions">
                    <button type="button" className="btn link" aria-label="Save student changes" title="Save"
                      onClick={() => run(
                        UPDATE_STUDENT,
                        { student_id: s.student_id, ...draft, _version: s._version },
                        'Saved'
                      )}
                    >
                      <ActionIcon name="check" />
                    </button>

                    <button type="button" className="btn link" aria-label="Cancel student editing" title="Cancel"
                      onClick={() => setEditing(null)}
                    >
                      <ActionIcon name="x" />
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={s.student_id}>
                  <td>{s.admission_no}</td>
                  <td>{s.first_name}</td>
                  <td>{s.last_name}</td>
                  <td>{s.status === 'ACTIVE' ? 'Active' : <span className="warn">Deactivated</span>}</td>
                  <td><Link to={`/students/${s.student_id}/risk`} state={{ from: `/classes/${classId}/students` }}>Risk profile</Link></td>
                  {canManage && (
                    <td className="actions student-actions">
                    <div className="row-actions">
                      <button type="button" className="btn link" aria-label={`Edit ${s.first_name} ${s.last_name}`} title="Edit"
                        onClick={() => {
                          setEditing(s.student_id);
                          setDraft({
                            first_name: s.first_name,
                            last_name: s.last_name,
                            admission_no: s.admission_no
                          });
                        }}
                      >
                        <ActionIcon name="edit" />
                      </button>
                      {s.status === 'ACTIVE' ? (
                        <DangerButton className="link" aria-label={`Deactivate ${s.first_name} ${s.last_name}`} title="Deactivate"
                          onClick={() =>
                            window.confirm(
                              `Deactivate ${s.first_name} ${s.last_name}? They leave the class list; their marks and report cards stay.`
                            ) &&
                            run(
                              SET_STUDENT_STATUS,
                              { student_id: s.student_id, status: 'INACTIVE', _version: s._version },
                              'Student deactivated'
                            )
                          }
                        >
                          <ActionIcon name="archive" />
                        </DangerButton>
                      ) : (
                        <button type="button" className="btn link" aria-label={`Reactivate ${s.first_name} ${s.last_name}`} title="Reactivate"
                          onClick={() =>
                            run(
                              SET_STUDENT_STATUS,
                              { student_id: s.student_id, status: 'ACTIVE', _version: s._version },
                              'Student reactivated'
                            )
                          }
                        >
                          <ActionIcon name="restore" />
                        </button>
                      )}
                      {isAdmin && s.status === 'ACTIVE' && (
                        <>
                          <Select className="move-class-select" aria-label="Move to class" value={transfer[s.student_id] || ''}
                            onChange={(v) => setTransfer({ ...transfer, [s.student_id]: v })}
                            options={destinations.map((c) => ({ value: c.class_id, label: c.name }))} placeholder="Move to…" />
                          <button type="button" className="btn link" disabled={!transfer[s.student_id]}
                            onClick={() => window.confirm('Move this student? Marks already recorded stay with this class.')
                              && run(TRANSFER_STUDENT, { student_id: s.student_id, to_class_id: transfer[s.student_id], _version: s._version }, 'Student moved')}>
                            Move
                          </button>
                        </>
                      )}
                    </div>
                    </td>
                  )}
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}