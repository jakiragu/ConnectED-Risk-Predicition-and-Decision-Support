export const PERIODS = ['MIDTERM', 'ENDTERM'];
export const PERIOD_LABEL = { MIDTERM: 'Start of term to Mid-term', ENDTERM: 'Mid-term to end of term' };
export const TERM_NUMBERS = [1, 2, 3];
export const MAX_CLOSURES = 20;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in the school's time zone. */
export function todayIn(timeZone = 'Africa/Nairobi', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const closed = (date, closures) => (closures || []).some((c) => c.from <= date && date <= c.to);

/** Monday-Friday dates from `from` to `to` inclusive that are not closed. */
export function schoolDays(from, to, closures = []) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6 && !closed(d, closures)) n += 1;
  }
  return n;
}

/** The term's two attendance periods with their school days. */
export function attendancePeriods(term) {
  const ok = isIsoDate(term?.start_date) && isIsoDate(term?.mid_term_date) && isIsoDate(term?.end_date);
  if (!ok) return [];
  const closures = term.closures || [];
  const endtermFrom = addDays(term.mid_term_date, 1);
  return [
    { period: 'MIDTERM', from: term.start_date, to: term.mid_term_date, school_days: schoolDays(term.start_date, term.mid_term_date, closures) },
    { period: 'ENDTERM', from: endtermFrom, to: term.end_date, school_days: schoolDays(endtermFrom, term.end_date, closures) },
  ];
}

export const periodOf = (term, period) => attendancePeriods(term).find((p) => p.period === period) || null;

export function termStatus(term, today) {
  if (!term?.start_date || !term?.end_date) return term?.status ?? null;
  if (today < term.start_date) return 'UPCOMING';
  if (today > term.end_date) return 'PAST';
  return 'CURRENT';
}

/**
 * @param {object} input        the term as it would be saved
 * @param {object[]} siblings   other terms of the same school (any year)
 * @returns {{field:string, message:string}[]}
 */
export function validateTerm(input, siblings = []) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const year = Number(input.academic_year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) add('academic_year', 'Enter a school year such as 2026');
  if (!TERM_NUMBERS.includes(Number(input.term_number))) add('term_number', 'Choose term 1, 2 or 3');
  for (const field of ['start_date', 'mid_term_date', 'end_date']) {
    if (!isIsoDate(input[field])) add(field, 'Choose a date');
  }
  if (errors.length) return errors;
  if (!(input.start_date < input.mid_term_date)) add('mid_term_date', 'The Mid-term date must be after the start of term');
  if (!(input.mid_term_date < input.end_date)) add('end_date', 'The end of term must be after the Mid-term date');

  const closures = input.closures || [];
  if (closures.length > MAX_CLOSURES) add('closures', `List at most ${MAX_CLOSURES} closures`);
  closures.forEach((c, i) => {
    if (!isIsoDate(c.from) || !isIsoDate(c.to) || c.to < c.from) add('closures', `Closure ${i + 1} needs a valid from and to date`);
    else if (c.from < input.start_date || c.to > input.end_date) add('closures', `Closure ${i + 1} is outside the term`);
  });

  const others = siblings.filter((t) => t.term_id !== input.term_id);
  if (others.some((t) => Number(t.academic_year) === year && Number(t.term_number) === Number(input.term_number))) {
    add('term_number', `Term ${input.term_number} of ${year} already exists`);
  }
  const overlap = others.find((t) => t.start_date && t.end_date && t.start_date <= input.end_date && input.start_date <= t.end_date);
  if (overlap) add('start_date', `These dates overlap ${overlap.name}`);
  const sameYear = others.filter((t) => Number(t.academic_year) === year);
  for (const t of sameYear) {
    const before = Number(t.term_number) < Number(input.term_number);
    if (before && t.end_date >= input.start_date) add('start_date', `Term ${input.term_number} must start after ${t.name} ends`);
    if (!before && t.start_date <= input.end_date) add('end_date', `Term ${input.term_number} must end before ${t.name} starts`);
  }
  if (!errors.length && attendancePeriods(input).some((p) => p.school_days === 0)) {
    add('mid_term_date', 'Each half of the term needs at least one school day');
  }
  return errors;
}