import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';

export default function Classes() {
  const { actor } = useAuth();
  const [error, setError] = useState(null);
  const classes = useLive(() => db().classes.toArray(), [], null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setError(e.message));
  }, [actor.schoolId]);

  const sorted = (classes || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="page-head">
        <h1>Your classes</h1>
      </div>

      {error && <div className="card error-card">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Form</th><th>Stream</th><th>Year</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {classes && sorted.length === 0 && (
              <tr className="empty">
                <td colSpan={5}>
                  No classes on this device yet. Connect once to download them, or ask your head teacher to
                  add you to a class.
                </td>
              </tr>
            )}
            {sorted.map((c) => (
              <tr key={c.class_id}>
                <td>{c.grade}</td>
                <td>{c.stream}</td>
                <td>{c.year}</td>
                <td>{c.status === 'CURRENT' ? 'Current' : 'Past'}</td>
                <td>
                  <Link to={`/assessments?class=${c.class_id}`}>View assessments</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}