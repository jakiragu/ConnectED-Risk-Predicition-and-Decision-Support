import { useEffect, useRef } from 'react';
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { db, dropFor } from '../offline/db.js';
import { useLive } from '../offline/useLive.js';
import { getState, startSync } from '../offline/syncEngine.js';
import SyncBar from './SyncBar.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { useSidebar, SIDEBAR } from '../hooks/useSidebar.js';

/**
 * Grouped by purpose rather than listed by feature. Every user: dashboard, classes, assessments, results.
 * Attendance, report cards and risk prediction: administrators and class teachers. School risk, teachers
 * and settings: administrators.
 */
const adminOrClassTeacher = ({ isAdmin, isClassTeacher }) => isAdmin || isClassTeacher;
const adminOnly = ({ isAdmin }) => isAdmin;
const NAV_GROUPS = [
  { label: 'Teaching', items: [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/classes', label: 'Classes' },
    { to: '/assessments', label: 'Assessments' },
    { to: '/attendance', label: 'Attendance', show: adminOrClassTeacher },
  ] },
  { label: 'Results', items: [
    { to: '/results', label: 'Results' },
    { to: '/report-cards', label: 'Report cards', show: adminOrClassTeacher },
  ] },
  { label: 'Insights', items: [
    { to: '/risk', label: 'Risk prediction', show: adminOrClassTeacher },
    { to: '/school-risk', label: 'School risk', show: adminOnly },
  ] },
  { label: 'Administration', items: [
    { to: '/teachers', label: 'Teachers', show: adminOnly },
    { to: '/settings', label: 'Settings', show: adminOnly },
  ] },
  { label: 'You', items: [{ to: '/profile', label: 'My Profile' }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

function breadcrumbsFor(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const home = { label: 'Dashboard', to: '/dashboard' };

  if (path === '/dashboard') {
    return [{ label: 'Dashboard' }];
  }

  if (path === '/classes') {
    return [home, { label: 'Classes' }];
  }

  const classStudents = path.match(/^\/classes\/([^/]+)\/students$/);
  if (classStudents) {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Class', to: `/classes/${classStudents[1]}` }, { label: 'Students' }];
  }

  if (/^\/classes\/[^/]+$/.test(path)) {
    return [home, { label: 'Classes', to: '/classes' }, { label: 'Class' }];
  }

  if (path.startsWith('/settings')) {
    return [home, { label: 'Settings' }];
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

  if (pathname.startsWith('/settings')) {
    return '/settings';
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

  // Sidebar: folding groups, hiding it, and dragging its edge to resize. Remembered on this device.
  const { width, setWidth, hidden, setHidden, collapsed, setGroupOpen } = useSidebar();
  const aside = useRef(null);
  const activeGroup = NAV_GROUPS.find((g) => g.items.some((i) => i.to === activeSection))?.label;
  // The group holding the current page always opens, so the highlighted link is never hidden.
  useEffect(() => { if (activeGroup) setGroupOpen(activeGroup, true); }, [activeGroup, setGroupOpen]);

  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = aside.current.getBoundingClientRect().left;
    const startX = e.clientX;
    let dragged = false;
    // A click without movement is not a resize (it would undo a double-click reset).
    const move = (ev) => {
      if (!dragged && Math.abs(ev.clientX - startX) < 3) return;
      dragged = true;
      setWidth(ev.clientX - left, false);
    };
    const end = (ev) => {
      if (dragged) setWidth(ev.clientX - left, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }
  function resizeByKey(e) {
    const step = e.shiftKey ? SIDEBAR.step * 3 : SIDEBAR.step;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width - step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width + step); }
    if (e.key === 'Home') { e.preventDefault(); setWidth(SIDEBAR.min); }
    if (e.key === 'End') { e.preventDefault(); setWidth(SIDEBAR.max); }
  }

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
    <div className={`shell${hidden ? ' nav-hidden' : ''}`} style={{ '--sidebar-w': `${width}px` }}>
      {!hidden && (
      <aside className="sidebar" id="sidebar" ref={aside}>
        <div className="brand">
          <div className="brand-name">ConnectED</div>
          <div className="brand-sub">Exam and Gradebook System</div>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((item) => !item.show || item.show({ isAdmin, isClassTeacher }));
            if (!items.length) return null;
            const open = !collapsed.has(group.label);
            const id = `nav-group-${group.label.toLowerCase()}`;
            return (
              <div key={group.label} className={`nav-group${open ? ' open' : ''}`}>
                <button type="button" className="nav-group-toggle" aria-expanded={open} aria-controls={id}
                  onClick={() => setGroupOpen(group.label, !open)}>
                  <span>{group.label}</span>
                  <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                {open && (
                  <div id={id} className="nav-group-items">
                    {items.map((item) => (
                      <Link key={item.to} to={item.to} aria-current={activeSection === item.to ? 'page' : undefined}>
                        {item.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <a href="#log-out" className="danger" onClick={logOut}>
            Log out
          </a>
        </nav>
        <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the menu"
          aria-valuemin={SIDEBAR.min} aria-valuemax={SIDEBAR.max} aria-valuenow={width} tabIndex={0}
          title="Drag to resize. Double-click to reset." onPointerDown={startResize} onKeyDown={resizeByKey}
          onDoubleClick={() => setWidth(SIDEBAR.default)} />
      </aside>
      )}

      <div className="main">
        <header className="topbar">
          <button type="button" className="menu-toggle" aria-controls="sidebar" aria-expanded={!hidden}
            aria-label={hidden ? 'Show the menu' : 'Hide the menu'} title={hidden ? 'Show the menu' : 'Hide the menu'}
            onClick={() => setHidden(!hidden)}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
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