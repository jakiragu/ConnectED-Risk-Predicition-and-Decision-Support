import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { LIST_MY_CLASSES } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * The classes this user may open.
 *
 * The server derives this from the same assignment data the authorization check
 * uses, so a class shown here can always be opened, and a class not shown here
 * would be refused if the user typed its id into the URL.
 */
export default function Classes() {
  const { actor } = useAuth();
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    gql(LIST_MY_CLASSES, { school_id: actor.schoolId })
      .then((res) => live && setClasses(res.listMyClasses))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [actor.schoolId]);

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
            {!loading && classes.length === 0 && (
              <tr className="empty">
                <td colSpan={5}>
                  No classes are assigned to you yet. Ask your head teacher to add you to a class.
                </td>
              </tr>
            )}
            {classes.map((c) => (
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