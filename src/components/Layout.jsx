import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const NAV = [
  { to: '/classes', label: 'Classes' },
  { to: '/assessments', label: 'Assessments' },
];

export default function Layout() {
  const { actor, signOut } = useAuth();
  const navigate = useNavigate();

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
          <a
            href="#log-out"
            className="danger"
            onClick={(e) => {
              e.preventDefault();
              signOut();
              navigate('/sign-in');
            }}
          >
            Log out
          </a>
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
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