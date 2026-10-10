import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { dropFor } from '../offline/db.js';
import { getState, startSync } from '../offline/syncEngine.js';
import SyncBar from './SyncBar.jsx';

const NAV = [
  { to: '/classes', label: 'Classes' },
  { to: '/assessments', label: 'Assessments' },
  { to: '/results', label: 'Results' },
];

export default function Layout() {
  const { actor, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => startSync(actor), [actor.sub]); 
  
  async function logOut(e) {
    e.preventDefault();
    const { pending, failed, held } = await getState();
    const unsent = pending + failed + held;
    if (unsent && !window.confirm(
      `${unsent} mark${unsent === 1 ? ' has' : 's have'} not reached the server yet. ` +
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
          {NAV.map((item) => (
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
          <SyncBar />
          <div className="who">
            <span>{actor?.name}</span>
            <span>{actor?.groups?.join(', ')}</span>
          </div>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}