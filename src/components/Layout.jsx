import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
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

function labelForPath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';

  if (path === '/dashboard') return 'Dashboard';
  if (path === '/classes') return 'Classes';

  if (/^\/classes\/[^/]+\/students$/.test(path)) {
    return 'Students';
  }

  if (path === '/interventions/new') {
    return [home, { label: 'Log an intervention' }];
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


  if (/^\/students\/[^/]+\/risk$/.test(path)) {
    return 'Student profile';
  }

  if (/^\/students\/[^/]+\/interventions$/.test(path)) {
    return 'Interventions';
  }

  if (path === '/assessments') return 'Assessments';
  if (path === '/assessments/new') return 'New assessment';

  if (/^\/assessments\/[^/]+\/edit$/.test(path)) {
    return 'Edit assessment';
  }

  if (/^\/assessments\/[^/]+\/scores$/.test(path)) {
    return 'Assessment marks';
  }

  const pages = {
    '/results': 'Results',
    '/attendance': 'Attendance',
    '/report-cards': 'Report cards',
    '/risk': 'Risk prediction',
    '/school-risk': 'School risk',
    '/teachers': 'Teachers',
    '/terms': 'Terms',
    '/profile': 'My Profile',
  };

  return pages[path] || 'Page';
}

function breadcrumbsForTrail(trail, pathname, search) {
  const section = activeSectionFor(pathname);
  const sectionItem = NAV.find((item) => item.to === section);
  const sectionLabel = sectionItem?.label || 'Dashboard';

  const currentHref = `${pathname}${search}`;

  const sectionTrail = trail.filter(
    (entry) => activeSectionFor(entry.pathname) === section
  );

  const hasSectionRoot = sectionTrail.some(
    (entry) => entry.pathname === section
  );

  const crumbs = [];

  // The sidebar section is the first breadcrumb.
  // Avoid duplicating it when the user is already on its root page.
  if (!hasSectionRoot) {
    crumbs.push({
      label: sectionLabel,
      to: section,
    });
  }

  sectionTrail.forEach((entry) => {
    const href = `${entry.pathname}${entry.search}`;

    crumbs.push({
      label: labelForPath(entry.pathname),
      to: href === currentHref ? undefined : href,
    });
  });

  return crumbs;
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
  const navigationType = useNavigationType();

  const activeSection = activeSectionFor(location.pathname);

  const [routeTrail, setRouteTrail] = useState(() => [
    {
      key: location.key,
      pathname: location.pathname,
      search: location.search,
    },
  ]);

  const previousLocation = useRef(location);

  useEffect(() => {
    const previous = previousLocation.current;

    if (previous.key === location.key) return;

    const current = {
      key: location.key,
      pathname: location.pathname,
      search: location.search,
    };

    const previousSection = activeSectionFor(previous.pathname);
    const currentSection = activeSectionFor(current.pathname);

    setRouteTrail((trail) => {
      const currentHref = `${current.pathname}${current.search}`;

      // Switching sidebar sections starts a completely new trail.
      if (previousSection !== currentSection) {
        return [current];
      }

      // Find whether the destination already exists in the breadcrumb trail.
      const existingIndex = trail.findIndex((entry) => {
        return `${entry.pathname}${entry.search}` === currentHref;
      });

      // The destination is already in the trail:
      // return to it and discard everything after it.
      if (existingIndex >= 0) {
        return [
          ...trail.slice(0, existingIndex),
          current,
        ];
      }

      // Browser Back or Forward.
      if (navigationType === 'POP') {
        const historyIndex = trail.findIndex(
          (entry) => entry.key === location.key
        );

        // The browser returned to an entry in our trail.
        if (historyIndex >= 0) {
          return trail.slice(0, historyIndex + 1);
        }

        // The browser returned to a page outside our tracked trail.
        // Rebuild a sensible trail instead of appending it.
        return [current];
      }

      // React Router replaced the current history entry.
      if (navigationType === 'REPLACE') {
        return [...trail.slice(0, -1), current];
      }

      // A genuinely new page within the same sidebar section.
      return [...trail, current];
    });

    previousLocation.current = location;
  }, [location, navigationType]);

  const breadcrumbs = breadcrumbsForTrail(
    routeTrail,
    location.pathname,
    location.search
  );

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