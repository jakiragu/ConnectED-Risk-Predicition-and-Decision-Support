/**
 * Which forms (year groups) and streams a school runs, set in Settings ->
 * Classes. New and edited classes must use them, so "Form 2 Est" cannot be
 * created by a typo. Existing classes are never changed when the lists change:
 * a class keeps the form, stream and name it was created with, so past results
 * and report cards stay as they were.
 *
 * Shared by the services and the React client.
 */

export const MAX_ENTRIES = 30;
export const MAX_NAME = 30;

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Tidies one list and returns it with any problem found. */
export function normaliseList(values, what) {
  const out = [];
  const seen = new Set();
  const problems = [];
  for (const raw of values || []) {
    const v = clean(raw);
    if (!v) continue;
    if (v.length > MAX_NAME) { problems.push(`“${v}” is too long for a ${what} name (at most ${MAX_NAME} characters)`); continue; }
    const key = v.toLowerCase();
    if (seen.has(key)) { problems.push(`${what[0].toUpperCase()}${what.slice(1)} “${v}” is listed twice`); continue; }
    seen.add(key);
    out.push(v);
  }
  if (!out.length) problems.push(`Add at least one ${what}`);
  if (out.length > MAX_ENTRIES) problems.push(`Use at most ${MAX_ENTRIES} ${what}s`);
  return { values: out, problems };
}

export function normaliseSetup(input) {
  const forms = normaliseList(input?.forms, 'form');
  const streams = normaliseList(input?.streams, 'stream');
  return { setup: { forms: forms.values, streams: streams.values }, problems: [...forms.problems, ...streams.problems] };
}

/** Forms and streams already used by a school's classes: the starting lists before the school saves its own. */
export function setupFromClasses(classes) {
  const distinct = (key) => [...new Set((classes || []).map((c) => clean(c[key])).filter(Boolean))].sort(natural);
  return { forms: distinct('grade'), streams: distinct('stream') };
}

/**
 * Why a class's form or stream is not allowed, or null. Only enforced once the
 * school has saved its own lists (setup._version > 0); until then any value is
 * accepted, as before.
 */
export function classFieldProblem(setup, { grade, stream }) {
  if (!setup || !(setup._version > 0)) return null;
  const has = (list, v) => list.some((x) => x.toLowerCase() === clean(v).toLowerCase());
  if (grade != null && !has(setup.forms, grade)) return { field: 'grade', reason: `“${clean(grade)}” is not one of the school’s forms. An administrator can add it in Settings, Classes.` };
  if (stream != null && !has(setup.streams, stream)) return { field: 'stream', reason: `“${clean(stream)}” is not one of the school’s streams. An administrator can add it in Settings, Classes.` };
  return null;
}

/**
 * The school's own spelling of a form and stream ("form 1" -> "Form 1"), so
 * class names stay consistent however they were typed. Values not in the lists
 * (or lists not yet saved) are returned unchanged.
 */
export function canonicalClassFields(setup, fields) {
  if (!setup || !(setup._version > 0)) return fields;
  const pick = (list, v) => (v == null ? v : list.find((x) => x.toLowerCase() === clean(v).toLowerCase()) ?? v);
  return { ...fields, ...(fields.grade != null ? { grade: pick(setup.forms, fields.grade) } : {}), ...(fields.stream != null ? { stream: pick(setup.streams, fields.stream) } : {}) };
}
