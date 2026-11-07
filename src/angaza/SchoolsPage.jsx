import { useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { LIST_SCHOOLS } from '../api/platformOperations.js';
import { EmptyState, Info } from '../components/ui.jsx';
import { useAngaza } from './AngazaAuth.jsx';
import { LocalTime, SchoolStatus, useLoad, useNow } from './parts.jsx';

const VIEWS = [
  { id: 'all', label: 'All schools', test: () => true },
  { id: 'needs-admin', label: 'Need an administrator', test: (s) => s.status === 'ACTIVE' && !s.active_admin_count },
  { id: 'suspended', label: 'Suspended', test: (s) => s.status === 'SUSPENDED' },
];

const matches = (s, q) =>
  !q || [s.name, s.town, s.region].some((v) => v && v.toLowerCase().includes(q));

/**
 * Every school, grouped by country. Each country shows the time there, because
 * staff in other time zones mostly need to know whether now is a good moment to
 * call. Filters live in the address, so Back and shared links keep them.
 */
export default function SchoolsPage() {
  const { api } = useAngaza();
  const location = useLocation();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.id === params.get('show')) || VIEWS[0];
  const query = params.get('q') || '';
  const country = params.get('country') || '';
  const { data, error, loading, reload } = useLoad(async () => (await api(LIST_SCHOOLS)).listSchools, [api]);

  useEffect(() => { document.title = 'Schools: Angaza console'; }, []);

  const schools = data || [];
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const countries = useMemo(() => [...new Map(schools.map((s) => [s.country, s.country_name])).entries()]
    .map(([code, name]) => ({ value: code, label: name })), [schools]);

  const shown = schools.filter((s) => view.test(s) && (!country || s.country === country) && matches(s, query.trim().toLowerCase()));
  const groups = useMemo(() => {
    const byCountry = new Map();
    for (const s of shown) {
      if (!byCountry.has(s.country)) byCountry.set(s.country, []);
      byCountry.get(s.country).push(s);
    }
    return [...byCountry.values()];
  }, [shown]);
  const filtered = view.id !== 'all' || country || query;

  return (
    <>
      <div className="page-head">
        <h1>Schools</h1>
        <Link to="/angaza/schools/new" className="btn">Add a school</Link>
      </div>

      {error && (
        <div className="notice error" role="alert">
          The schools could not be loaded: {error.message}{' '}
          <button type="button" className="btn link" onClick={reload}>Try again</button>
        </div>
      )}

      {data && schools.length === 0 && (
        <EmptyState
          title="No schools yet"
          action={<Link to="/angaza/schools/new" className="btn">Add the first school</Link>}
        >
          Add a school, then its first administrator. The administrator sets up classes, terms and teachers from there.
        </EmptyState>
      )}

      {data && schools.length > 0 && (
        <>
          <div className="segmented" role="group" aria-label="Show">
            {VIEWS.map((v) => {
              const count = schools.filter(v.test).length;
              return (
                <button key={v.id} type="button" className={`seg${v.id === view.id ? ' active' : ''}`} aria-pressed={v.id === view.id}
                  onClick={() => setParam('show', v.id === 'all' ? '' : v.id)}>
                  {v.label} <span className="pill neutral">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="toolbar">
            <label className="sr-only" htmlFor="school-search">Search schools</label>
            <input id="school-search" type="search" placeholder="Search by name or place" value={query}
              onChange={(e) => setParam('q', e.target.value)} />
            {countries.length > 1 && (
              <>
                <label className="sr-only" htmlFor="school-country">Country</label>
                <select id="school-country" value={country} onChange={(e) => setParam('country', e.target.value)}>
                  <option value="">All countries</option>
                  {countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </>
            )}
            <Info label="About school hours">
              School hours here mean 8:00 to 17:00, Monday to Friday, at the school. Boarding schools can often be reached
              outside them. Times update by themselves.
            </Info>
          </div>

          {shown.length === 0 ? (
            <EmptyState title="No schools match"
              action={filtered && <button type="button" className="btn secondary" onClick={() => setParams({}, { replace: true })}>Show all schools</button>}>
              {view.id === 'needs-admin' ? 'Every active school has at least one administrator.' : view.id === 'suspended' ? 'No school is suspended.' : 'Try a different name, or check the country.'}
            </EmptyState>
          ) : groups.map((group) => {
            const first = group[0];
            return (
              <section key={first.country} className="country-group" aria-labelledby={`country-${first.country}`}>
                <div className="group-head">
                  <h2 id={`country-${first.country}`}>{first.country_name}</h2>
                  <span className="hint">{group.length} school{group.length === 1 ? '' : 's'}</span>
                  <LocalTime timeZone={first.time_zone} now={now} />
                </div>
                <div className="table-wrap">
                  <table className="schools-table">
                    <colgroup><col className="c-school" /><col className="c-region" /><col className="c-admins" /><col className="c-status" /></colgroup>
                    <thead>
                      <tr><th>School</th><th>{first.region_label}</th><th>Administrators</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {group.map((s) => (
                        <tr key={s.school_id}>
                          <td>
                            <Link className="school-link" to={`/angaza/schools/${s.school_id}`} state={{ from: `${location.pathname}${location.search}` }}>{s.name}</Link>
                            {s.town && <div className="hint">{s.town}</div>}
                          </td>
                          <td data-label={first.region_label}>{s.region}</td>
                          <td data-label="Administrators">{s.active_admin_count ? s.active_admin_count : <span className="warn">None yet</span>}</td>
                          <td data-label="Status"><SchoolStatus status={s.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}

      {loading && !data && <p className="hint" role="status">Loading schools…</p>}
    </>
  );
}
