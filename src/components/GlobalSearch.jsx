import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { here } from '../navigation.js';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useTerms } from '../offline/useTerms.js';

/**
 * The top bar's search: students, classes and assessments, as in the
 * wireframes. It searches what is already on this device, so it works offline,
 * and only within what the person may see: administrators every class; a
 * teacher the classes they are class teacher of or teach a subject in. The
 * first time it is opened it fetches the rosters and this term's assessments it
 * does not have yet.
 *
 * Students open their risk profile (with a quick link to log an intervention),
 * classes their student list, assessments their mark entry. Arrow keys move,
 * Enter opens, Escape closes.
 */
const LIMIT = { student: 6, class: 3, assessment: 4 };

export default function GlobalSearch() {
  const { actor, isAdmin } = useAuth();
  const { defaultTermId } = useTerms(actor.schoolId);
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const primed = useRef(false);
  const box = useRef(null);

  const classes = useLive(() => db().classes.toArray(), [], []);
  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher || (c.my_subjects || []).length),
    [classes, isAdmin]
  );
  const ids = useMemo(() => new Set(mine.map((c) => c.class_id)), [mine]);
  const students = useLive(() => db().students.toArray(), [], []);
  const assessments = useLive(() => db().assessments.toArray(), [], []);

  // Fetch what search needs once per session, the first time it is used.
  function prime() {
    if (primed.current || !mine.length) return;
    primed.current = true;
    for (const c of mine) {
      repository.loadRoster(actor.schoolId, c.class_id).catch(() => {});
      if (defaultTermId) repository.loadAssessments(actor.schoolId, c.class_id, defaultTermId).catch(() => {});
    }
  }

  const className = useMemo(() => new Map(classes.map((c) => [c.class_id, c.name])), [classes]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const has = (...xs) => xs.some((x) => String(x ?? '').toLowerCase().includes(q));
    const found = [
      ...students
        .filter((s) => ids.has(s.class_id) && (s.status ?? 'ACTIVE') === 'ACTIVE' && has(`${s.first_name} ${s.last_name}`, s.last_name, s.admission_no))
        .slice(0, LIMIT.student)
        .map((s) => ({
          kind: 'student', key: `s${s.student_id}`, title: `${s.first_name} ${s.last_name}`,
          meta: `${s.admission_no} · ${className.get(s.class_id) ?? ''}`,
          to: `/students/${s.student_id}/risk`, extra: { label: 'Log intervention', to: `/students/${s.student_id}/interventions` },
        })),
      ...mine.filter((c) => has(c.name)).slice(0, LIMIT.class)
        .map((c) => ({ kind: 'class', key: `c${c.class_id}`, title: c.name, meta: 'Class', to: `/classes/${c.class_id}/students` })),
      ...assessments
        .filter((a) => ids.has(a.class_id) && !a._deleted && has(a.title))
        .slice(0, LIMIT.assessment)
        .map((a) => ({
          kind: 'assessment', key: `a${a.assessment_id}`, title: a.title, meta: `${className.get(a.class_id) ?? ''} · ${a.subject}`,
          to: `/assessments/${a.assessment_id}/scores?class=${a.class_id}&term=${a.term_id}`,
        })),
    ];
    return found;
  }, [query, students, assessments, mine, ids, className]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function go(to) {
    setOpen(false);
    setQuery('');
    navigate(to, { state: { from: here(location) } });
  }

  function onKey(e) {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    if (e.key === 'Enter') { e.preventDefault(); go(results[active].to); }
  }

  const groups = ['student', 'class', 'assessment'].map((kind) => [kind, results.filter((r) => r.kind === kind)]).filter(([, rs]) => rs.length);
  const title = { student: 'Students', class: 'Classes', assessment: 'Assessments' };

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        role="combobox"
        aria-expanded={open && query.trim().length >= 2}
        aria-controls="search-results"
        aria-label="Search for a student, class or assessment"
        placeholder="Search for a student, class or assessment"
        value={query}
        onFocus={() => { prime(); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
      />
      {open && query.trim().length >= 2 && (
        <div className="search-results" id="search-results" role="listbox">
          {!results.length && <div className="search-empty">Nothing matches “{query.trim()}” in your classes.</div>}
          {groups.map(([kind, rs]) => (
            <div key={kind}>
              <div className="search-group">{title[kind]}</div>
              {rs.map((r) => {
                const i = results.indexOf(r);
                return (
                  <div key={r.key} role="option" aria-selected={i === active} className={`search-item${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}>
                    <button type="button" className="search-main" onClick={() => go(r.to)}>
                      <b>{r.title}</b><span>{r.meta}</span>
                    </button>
                    {r.extra && <button type="button" className="btn link small" onClick={() => go(r.extra.to)}>{r.extra.label}</button>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
