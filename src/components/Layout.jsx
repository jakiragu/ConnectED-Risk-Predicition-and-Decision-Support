import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { db, dropFor } from '../offline/db.js';
import { useLive } from '../offline/useLive.js';
import { getState, startSync } from '../offline/syncEngine.js';
import SyncBar from './SyncBar.jsx';
import GlobalSearch from './GlobalSearch.jsx';

/**
 * Every user: dashboard, classes, assessments, results. School risk: administrators. Attendance, report cards and model
 * inputs: administrators and class teachers. Teachers and terms: administrators.
 */
const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/classes', label: 'Classes' },
  { to: '/assessments', label: 'Assessments' },
  { to: '/results', label: 'Results' },
  { to: '/attendance', label: 'Attendance', show: ({ isAdmin, isClassTeacher }) => isAdmin || isClassTeacher },
  { to: '/report-cards', label: 'Report cards', show: ({ isAdmin, isClassTeacher }) => isAdmin || isClassTeacher },
  { to: '/risk', label: 'Risk prediction', show: ({ isAdmin, isClassTeacher }) => isAdmin || isClassTeacher },
  { to: '/school-risk', label: 'School risk', show: ({ isAdmin }) => isAdmin },
  { to: '/teachers', label: 'Teachers', show: ({ isAdmin }) => isAdmin },
  { to: '/terms', label: 'Terms', show: ({ isAdmin }) => isAdmin },
  { to: '/profile', label: 'My Profile' },
];

export default function Layout() {
  const { actor, isAdmin, signOut, displayName, schoolName } = useAuth();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const isClassTeacher = classes.some((c) => c.is_class_teacher);
  const navigate = useNavigate();

  useEffect(() => startSync(actor), [actor.sub]);

  async function logOut(e) {
    e.preventDefault();
    const { pending, failed, held } = await getState();
    const unsent = pending + failed + held;
    if (unsent && !window.confirm(
      `${unsent} change${unsent === 1 ? ' has' : 's have'} (marks or interventions) not reached the server yet. ` +
      'They will stay on this device and be sent the next time you sign in. Log out?'
    )) return;
    const sub = actor.sub;
    signOut();
    navigate('/sign-in');
    if (!unsent) await dropFor(sub);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">ConnectED</div>
          <div className="brand-sub">Exam and Gradebook System</div>
        </div>
        <nav className="nav">
          {NAV.filter((item) => !item.show || item.show({ isAdmin, isClassTeacher })).map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
          <a href="#log-out" className="danger" onClick={logOut}>
            Log out
          </a>
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <GlobalSearch />
          <SyncBar />
          <NavLink to="/profile" className="who profile-link">
            <span>{displayName}</span>
            <span>{schoolName || 'School profile unavailable'}</span>
          </NavLink>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}