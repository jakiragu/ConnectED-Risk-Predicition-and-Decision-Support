import { useEffect, useMemo, useState } from 'react';
import { gql } from '../api/graphql.js';
import { ME, LIST_MY_CLASSES, UPDATE_MY_PROFILE, } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field } from '../components/Field.jsx';
import { useSync } from '../offline/useSync.js';

const formatDate = (value) => {
  if (!value) return '—';

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString();
};

const fullName = (person) =>
  [person?.first_name, person?.last_name]
    .filter(Boolean)
    .join(' ');

export default function Profile() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();

  const [profile, setProfile] = useState(null);
  const [classes, setClasses] = useState([]);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      setLoading(true);
      setError(null);

      try {
        const [{ me }, { listMyClasses }] = await Promise.all([
          gql(ME, { school_id: actor.schoolId }),
          gql(LIST_MY_CLASSES, { school_id: actor.schoolId }),
        ]);

        if (!active) return;

        setProfile(me);
        setClasses(listMyClasses || []);
        setFirstName(me.first_name || '');
        setLastName(me.last_name || '');
      } catch (e) {
        if (active) {
          setError(e.message || 'Unable to load your profile.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadProfile();

    return () => {
      active = false;
    };
  }, [actor.schoolId, online]);

  const classNames = useMemo(
    () => new Map(classes.map((c) => [c.class_id, c.name])),
    [classes]
  );

  const assignments = useMemo(() => {
    if (!profile?.assignments) return [];

    return [...profile.assignments].sort((a, b) => {
      const classA = classNames.get(a.class_id) || a.class_id;
      const classB = classNames.get(b.class_id) || b.class_id;

      return (
        classA.localeCompare(classB) ||
        a.subject.localeCompare(b.subject)
      );
    });
  }, [profile, classNames]);

  const classTeacherName = profile?.class_teacher_of
    ? classNames.get(profile.class_teacher_of) ||
      profile.class_teacher_of
    : null;

  const changed =
    firstName.trim() !== (profile?.first_name || '') ||
    lastName.trim() !== (profile?.last_name || '');

  const valid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0;

  async function saveProfile(e) {
    e.preventDefault();

    if (!profile || !changed || !valid || saving) return;

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const { updateMyProfile } = await gql(UPDATE_MY_PROFILE, {
        input: {
          school_id: actor.schoolId,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          _version: profile._version,
        },
      });

      setProfile(updateMyProfile);
      setFirstName(updateMyProfile.first_name || '');
      setLastName(updateMyProfile.last_name || '');
      setNotice('Your personal details have been updated.');
    } catch (e) {
      setError(
        e.message || 'Unable to update your personal details.'
      );
    } finally {
      setSaving(false);
    }
  }

  function cancelChanges() {
    setFirstName(profile?.first_name || '');
    setLastName(profile?.last_name || '');
    setError(null);
    setNotice(null);
  }

  if (loading) {
    return <div className="hint">Loading your profile…</div>;
  }

  if (!profile) {
    return (
      <div className="stack">
        <div className="page-head">
          <h1>My Profile</h1>
        </div>
        <div className="card error-card">
          {error || 'Your profile could not be loaded.'}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>My Profile</h1>
      </div>

      {!online && (
        <div className="notice">
          You are offline. Your profile is displayed from the information
          currently available, but you cannot update it.
        </div>
      )}

      {error && (
        <div className="card error-card">
          {error}
        </div>
      )}

      {notice && (
        <div className="notice success">
          {notice}
        </div>
      )}

      {/* Personal details: the only editable section */}
      <section className="card stack">
        <div className="weights-head">
          <h2>Personal Details</h2>
          <span className="hint">Editable</span>
        </div>

        <div className="hint">
          You can update your first and last names. Other account
          information and teaching responsibilities are managed separately.
        </div>

        <form className="stack" onSubmit={saveProfile}>
          <div className="weights-row">
            <Field label="First name" htmlFor="profile-first-name">
              <input
                id="profile-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                disabled={!online || saving}
              />
            </Field>

            <Field label="Last name" htmlFor="profile-last-name">
              <input
                id="profile-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                disabled={!online || saving}
              />
            </Field>
          </div>

          <div className="row">
            <button
              type="submit"
              className="btn"
              disabled={!online || !changed || !valid || saving}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>

            {changed && (
              <button
                type="button"
                className="btn secondary"
                onClick={cancelChanges}
                disabled={saving}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      {/* Account information: read-only */}
      <section className="card stack">
        <h2>Account Information</h2>

        <div className="hint">
          These details are associated with your school account and cannot
          be edited here.
        </div>

        <div className="two-col">
          <div className="stack">
            <Field label="School email">
              <input
                value={profile.email || '—'}
                readOnly
                disabled
              />
            </Field>

            <Field label="Role">
              <input
                value={profile.role || '—'}
                readOnly
                disabled
              />
            </Field>

            <Field label="Account status">
              <input
                value={
                  profile.status === 'ACTIVE'
                    ? 'Active'
                    : profile.status || '—'
                }
                readOnly
                disabled
              />
            </Field>

            <Field label="Teacher ID">
              <input
                value={profile.teacher_id || '—'}
                readOnly
                disabled
              />
            </Field>
          </div>

          <div className="stack">
            <Field label="School">
              <input
                value={profile.school_name || '—'}
                readOnly
                disabled
              />
            </Field>

            <Field label="Account created">
              <input
                value={formatDate(profile.created_at)}
                readOnly
                disabled
              />
            </Field>

            <Field label="Last updated">
              <input
                value={formatDate(profile.updated_at)}
                readOnly
                disabled
              />
            </Field>
          </div>
        </div>
      </section>

      {/* Teaching responsibilities: read-only */}
      <section className="card stack">
        <h2>Teaching Responsibilities</h2>

        <div className="hint">
          These responsibilities reflect the classes and subjects currently
          assigned to your account.
        </div>

        <div className="stack">
          <Field label="Class teacher of">
            <input
              value={classTeacherName || 'Not assigned'}
              readOnly
              disabled
            />
          </Field>
        </div>

        <h3>Assigned Classes and Subjects</h3>

        {isAdmin ? (
          <div className="notice">
            As an administrator, you have school-wide access to the
            gradebook and its academic records.
          </div>
        ) : assignments.length === 0 ? (
          <div className="hint">
            You currently have no teaching assignments.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Subject</th>
                </tr>
              </thead>

              <tbody>
                {assignments.map((assignment) => (
                  <tr
                    key={`${assignment.class_id}|${assignment.subject}`}
                  >
                    <td>
                      {classNames.get(assignment.class_id) ||
                        assignment.class_id}
                    </td>
                    <td>{assignment.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
