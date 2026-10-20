import { assertTenant, assertClassTeacherOrAdmin, isAdmin, isClassTeacherOf } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { attendancePeriods, periodOf, PERIODS, PERIOD_LABEL } from '../../library/calendar.js';
import { cumulativeAttendance, periodSummary, validateAttendance } from '../../library/attendance.js';
import { validation, notFound, locked } from '../../library/errors.js';
import * as attendance from '../../library/attendanceRepo.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id);

  switch (event.info.fieldName) {
    case 'getClassAttendance':
      return getClassAttendance(actor, args);
    case 'submitAttendance':
      return submitAttendance(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const MAX_ENTRIES = 200;
const TERM_LOCKED = 'End of term results for this class are published, so its attendance for the term is locked';
const RACED = 'Someone else changed this entry. The saved entry is shown.';

const entryView = (e, schoolDays) => e && {
  ...periodSummary(e, schoolDays),
  recorded_by_name: e.recorded_by_name ?? null,
  recorded_at: e.recorded_at ?? null,
  _version: e._version,
};

async function loadClass(schoolId, classId) {
  const klass = await platform.klass(schoolId, classId);
  if (!klass) throw notFound('Class not found');
  return klass;
}

async function loadPeriod(schoolId, termId, period) {
  if (!PERIODS.includes(period)) throw validation(`Period must be one of ${PERIODS.join(', ')}`, 'period');
  const term = await platform.term(schoolId, termId);
  if (!term) throw notFound('Term not found');
  const p = periodOf(term, period);
  if (!p) throw validation(`${term.name} has no Mid-term date yet. An administrator sets it on the Terms page.`, 'term_id');
  if (!term.academic_year || !term.term_number) throw validation(`${term.name} has no school year or term number`, 'term_id');
  return { term, p };
}

/** The periods of the school year from its first term up to and including `term`/`period`. */
async function yearPeriodsUpTo(schoolId, term, period) {
  const terms = (await platform.listTerms(schoolId))
    .filter((t) => Number(t.academic_year) === Number(term.academic_year) && Number(t.term_number) <= Number(term.term_number))
    .sort((a, b) => Number(a.term_number) - Number(b.term_number));
  const out = [];
  for (const t of terms) {
    for (const p of attendancePeriods(t)) {
      out.push({ key: `${t.term_id}#${p.period}`, term_id: t.term_id, period: p.period, school_days: p.school_days });
      if (t.term_id === term.term_id && p.period === period) return out;
    }
  }
  return out;
}

async function getClassAttendance(actor, { school_id, class_id, term_id, period }) {
  const klass = await loadClass(school_id, class_id);
  // Attendance belongs to the class teacher: reading it is limited the same way as recording it.
  assertClassTeacherOrAdmin(actor, class_id);
  const { term, p } = await loadPeriod(school_id, term_id, period);
  const [roster, isLocked, yearPeriods] = await Promise.all([
    platform.roster(school_id, class_id),
    assessments.termLocked(school_id, term.term_id, class_id),
    yearPeriodsUpTo(school_id, term, period),
  ]);

  // Every period of the year so far, so each student's year-to-date figure can be shown.
  const byPeriod = new Map();
  for (const yp of yearPeriods) {
    const entries = await attendance.listPeriod(school_id, yp.term_id, yp.period);
    byPeriod.set(yp.key, new Map(entries.map((e) => [e.student_id, e])));
  }
  const current = byPeriod.get(`${term.term_id}#${period}`) || new Map();

  const students = roster.map((s) => {
    const mine = new Map(yearPeriods.filter((yp) => byPeriod.get(yp.key)?.has(s.student_id))
      .map((yp) => [yp.key, byPeriod.get(yp.key).get(s.student_id)]));
    const ytd = cumulativeAttendance(yearPeriods, mine);
    return {
      student_id: s.student_id,
      admission_no: s.admission_no,
      first_name: s.first_name,
      last_name: s.last_name,
      entry: entryView(current.get(s.student_id), p.school_days) || null,
      year_to_date: ytd.percentage,
      year_to_date_missing: ytd.missing.length,
    };
  });

  return {
    class_id,
    class_name: klass.name,
    term_id: term.term_id,
    term_name: term.name,
    academic_year: term.academic_year,
    period,
    period_label: PERIOD_LABEL[period],
    from: p.from,
    to: p.to,
    school_days: p.school_days,
    locked: isLocked,
    can_edit: !isLocked && klass.status === 'CURRENT' && (isAdmin(actor) || isClassTeacherOf(actor, class_id)),
    students,
  };
}

/** Runs tasks with a small concurrency limit, keeping input order. */
async function inPool(items, size, run) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function submitAttendance(actor, input) {
  const klass = await loadClass(input.school_id, input.class_id);
  assertClassTeacherOrAdmin(actor, input.class_id);
  if (klass.status !== 'CURRENT') throw validation(`${klass.name} is archived`, 'class_id');
  const { term, p } = await loadPeriod(input.school_id, input.term_id, input.period);
  if (await assessments.termLocked(input.school_id, term.term_id, input.class_id)) throw locked(TERM_LOCKED);

  const entries = input.entries || [];
  if (!entries.length) throw validation('No entries to save', 'entries');
  if (entries.length > MAX_ENTRIES) throw validation(`Send at most ${MAX_ENTRIES} entries at a time`, 'entries');
  const ids = entries.map((e) => e.student_id);
  if (new Set(ids).size !== ids.length) throw validation('Each student may appear only once', 'entries');

  const [roster, existing] = await Promise.all([
    platform.roster(input.school_id, input.class_id),
    attendance.listPeriod(input.school_id, term.term_id, input.period),
  ]);
  const rosterIds = new Set(roster.map((s) => s.student_id));
  const saved = new Map(existing.map((e) => [e.student_id, e]));

  const results = await inPool(entries, 8, async (entry) => {
    const sid = entry.student_id;
    const before = saved.get(sid) || null;
    const view = () => entryView(before, p.school_days);
    if (!rosterIds.has(sid)) return { student_id: sid, outcome: 'REJECTED', reason: 'Student is not in this class', entry: view() };
    const check = validateAttendance(entry, p.school_days);
    if (!check.ok) return { student_id: sid, outcome: 'REJECTED', reason: check.reason, entry: view() };

    const same = before && before.days_attended === check.days_attended && before.days_excused === check.days_excused;
    if ((entry._version ?? null) !== (before?._version ?? null)) {
      return same
        ? { student_id: sid, outcome: 'APPLIED', reason: null, entry: view() }
        : { student_id: sid, outcome: 'CONFLICT', reason: RACED, entry: view() };
    }
    if (same) return { student_id: sid, outcome: 'APPLIED', reason: null, entry: view() };

    const res = await attendance.putEntry(input.school_id, {
      term, period: input.period, classId: input.class_id, studentId: sid,
      daysAttended: check.days_attended, daysExcused: check.days_excused, schoolDays: p.school_days,
    }, before?._version ?? null, actor);
    if (res.ok) return { student_id: sid, outcome: 'APPLIED', reason: null, entry: entryView(res.item, p.school_days) };
    if (res.reason === 'TERM_LOCKED') return { student_id: sid, outcome: 'REJECTED', reason: TERM_LOCKED, entry: view() };
    const fresh = await attendance.getEntry(input.school_id, term.term_id, input.period, sid);
    return { student_id: sid, outcome: 'CONFLICT', reason: RACED, entry: entryView(fresh, p.school_days) };
  });

  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { accepted: count('APPLIED'), rejected: count('REJECTED'), conflicted: count('CONFLICT'), results };
}