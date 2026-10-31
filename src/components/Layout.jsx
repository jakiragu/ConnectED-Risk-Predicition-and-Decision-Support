import { useEffect } from 'react';
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
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

function breadcrumbsFor(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const home = { label: 'Dashboard', to: '/dashboard' };

  if (path === '/dashboard') {
    return [{ label: 'Dashboard' }];
  }

  if (path === '/classes') {
    return [home, { label: 'Classes' }];
  }

  if (/^\/classes\/[^/]+\/students$/.test(path)) {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Students' }];
  }

  const studentMatch = path.match(/^\/students\/([^/]+)\/(risk|interventions)$/);
  if (studentMatch) {
    const [, studentId, page] = studentMatch;
    const crumbs = [
      home,
      { label: 'Classes', to: '/classes' },
      { label: 'Student profile', to: `/students/${studentId}/risk` },
    ];

    if (page === 'interventions') crumbs.push({ label: 'Interventions' });
    else crumbs[crumbs.length - 1] = { label: 'Student profile' };

    return crumbs;
  }

  if (path === '/assessments') {
    return [home, { label: 'Assessments' }];
  }

  if (path === '/assessments/new') {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'New assessment' }];
  }

  if (/^\/assessments\/[^/]+\/edit$/.test(path)) {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'Edit assessment' }];
  }

  if (/^\/assessments\/[^/]+\/scores$/.test(path)) {
    return [home, { label: 'Assessments', to: '/assessments' }, { label: 'Assessment marks' }];
  }

  const pages = {
    '/results': 'Results',
    '/attendance': 'Attendance',
    '/report-cards': 'Report cards',
    '/risk': 'Risk prediction',
    '/school-risk': 'School risk',
    '/teachers': 'Teachers',
    '/terms': 'Terms',
  };

  return pages[path]
    ? [home, { label: pages[path] }]
    : [home];
}

function activeSectionFor(pathname) {
  if (pathname.startsWith('/classes/') || pathname.startsWith('/students/')) {
    return '/classes';
  }

  if (pathname.startsWith('/assessments/')) {
    return '/assessments';
  }

  return NAV.find((item) =>
    pathname === item.to || pathname.startsWith(`${item.to}/`)
  )?.to || '/dashboard';
}

export default function Layout() {
  const { actor, isAdmin, signOut, displayName, schoolName } = useAuth();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const isClassTeacher = classes.some((c) => c.is_class_teacher);
  const navigate = useNavigate();
  const location = useLocation();
  const breadcrumbs = breadcrumbsFor(location.pathname);
  const activeSection = activeSectionFor(location.pathname);

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
            <Link key={item.to} to={item.to} aria-current={activeSection === item.to ? 'page' : undefined}>
              {item.label}
            </Link>
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
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <ol>
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`}>
                  {crumb.to ? (
                    <Link to={crumb.to}>{crumb.label}</Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <Outlet />
        </main>
      </div>
    </div>
  );
}