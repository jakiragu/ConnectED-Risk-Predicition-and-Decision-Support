import { attendancePeriods } from './calendar.js';
import { cumulativeAttendance } from './attendance.js';

export const MODEL_SUBJECTS = [
  'Mathematics', 'English', 'Kiswahili', 'Chemistry', 'Biology', 'Physics', 'History', 'Geography', 'Religious_Education',
];

/** Gradebook subject -> model subject. Subjects not listed (e.g. Computer Studies) are not model inputs. */
export const SUBJECT_TO_MODEL = {
  Mathematics: 'Mathematics',
  English: 'English',
  Kiswahili: 'Kiswahili',
  Chemistry: 'Chemistry',
  Biology: 'Biology',
  Physics: 'Physics',
  History: 'History',
  Geography: 'Geography',
  CRE: 'Religious_Education',
};

/** The five points at which the model predicts. Opener is not one; Term 3 End-term is the outcome. */
export const PREDICTION_POINTS = [
  { point: 'T1M', term_number: 1, checkpoint: 'MIDTERM' },
  { point: 'T1F', term_number: 1, checkpoint: 'ENDTERM' },
  { point: 'T2M', term_number: 2, checkpoint: 'MIDTERM' },
  { point: 'T2F', term_number: 2, checkpoint: 'ENDTERM' },
  { point: 'T3M', term_number: 3, checkpoint: 'MIDTERM' },
];
export const POINT_NAMES = PREDICTION_POINTS.map((p) => p.point);

export const pointOf = (point) => PREDICTION_POINTS.find((p) => p.point === point) || null;

/**
 * The checkpoint after each prediction point, for counterfactual targets, and
 * the attendance period that leads up to it (term_number, period). T3F is the
 * Term 3 End-term: the outcome, judged by the pass-mark rule, not by a model.
 */
export const NEXT_CHECKPOINT = {
  T1M: { point: 'T1F', term_number: 1, period: 'ENDTERM' },
  T1F: { point: 'T2M', term_number: 2, period: 'MIDTERM' },
  T2M: { point: 'T2F', term_number: 2, period: 'ENDTERM' },
  T2F: { point: 'T3M', term_number: 3, period: 'MIDTERM' },
  T3M: { point: 'T3F', term_number: 3, period: 'ENDTERM' },
};

/** The school days of the attendance period before the next checkpoint, or null if that term is not set up. */
export function nextPeriodSchoolDays(point, termsByNumber) {
  const next = NEXT_CHECKPOINT[point];
  const term = next && termsByNumber.get(next.term_number);
  return term ? attendancePeriods(term).find((p) => p.period === next.period)?.school_days ?? null : null;
}

/** The prediction point a published checkpoint corresponds to, or null (Opener, Term 3 End-term). */
export const pointFor = (termNumber, checkpoint) =>
  PREDICTION_POINTS.find((p) => p.term_number === Number(termNumber) && p.checkpoint === checkpoint)?.point ?? null;

export const pointsUpTo = (point) => PREDICTION_POINTS.slice(0, POINT_NAMES.indexOf(point) + 1);

export const scoreColumn = (point, subject) => `${point}_${subject}`;
export const attendanceColumn = (point) => `Attendance_${point}`;

/** Column order for one prediction point: every score block in order, then the attendance columns. */
export function columnsFor(point) {
  if (!pointOf(point)) throw new Error(`Unknown prediction point ${point}`);
  const upTo = pointsUpTo(point);
  return [
    ...upTo.flatMap((p) => MODEL_SUBJECTS.map((s) => scoreColumn(p.point, s))),
    ...upTo.map((p) => attendanceColumn(p.point)),
  ];
}

export const FEATURE_CONTRACT = Object.fromEntries(POINT_NAMES.map((p) => [p, columnsFor(p)]));

/** Columns in the training snapshots that are not model inputs. */
export const NON_FEATURE_COLUMNS = ['prediction_point', 'student_id', 'academic_risk', 'noise_1', 'noise_2', 'noise_3'];

/** Attendance period keys from the start of the year up to a prediction point. */
function attendanceKeysUpTo(point, termsByNumber) {
  const target = pointOf(point);
  const keys = [];
  for (const n of [1, 2, 3]) {
    if (n > target.term_number) break;
    const term = termsByNumber.get(n);
    if (!term) return { keys: null, problem: `Term ${n} is not set up` };
    const periods = attendancePeriods(term);
    if (!periods.length) return { keys: null, problem: `${term.name} has no Mid-term date` };
    for (const p of periods) {
      keys.push({ key: `${term.term_id}#${p.period}`, school_days: p.school_days, label: `${term.name} ${p.period === 'MIDTERM' ? 'to Mid-term' : 'Mid-term to end'}` });
      if (n === target.term_number && p.period === target.checkpoint) return { keys };
    }
  }
  return { keys };
}

/** The latest published row for a term and checkpoint (a transferred student may have one per class). */
function resultFor(history, termId, checkpoint) {
  return history
    .filter((r) => r.term_id === termId && r.checkpoint === checkpoint)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0] || null;
}

/**
 * @param {object} input
 * @param {string} input.point                    T1M | T1F | T2M | T2F | T3M
 * @param {Map<number, object>} input.termsByNumber   the school year's terms by term_number
 * @param {object[]} input.history                the student's StudentResult rows
 * @param {object[]} input.attendance             the student's attendance entries for the year
 * @returns {{columns:string[], values:object, missing:{scores:string[], attendance:string[], notes:string[]}, sources:object,
 *           attendance_totals:object}}  attendance_totals: per point, {attended, counted} behind the year-to-date percentage
 */
export function buildFeatureRow({ point, termsByNumber, history, attendance }) {
  const columns = columnsFor(point);
  const values = Object.fromEntries(columns.map((c) => [c, null]));
  const missing = { scores: [], attendance: [], notes: [] };
  const sources = {};
  const attendanceTotals = {};

  const byPeriod = new Map(attendance.map((e) => [`${e.term_id}#${e.period}`, e]));
  for (const p of pointsUpTo(point)) {
    const term = termsByNumber.get(p.term_number);
    const row = term ? resultFor(history, term.term_id, p.checkpoint) : null;
    if (!term) missing.notes.push(`Term ${p.term_number} is not set up`);
    else if (!row) missing.notes.push(`No published ${p.point} results`);
    if (row) sources[p.point] = { class_id: row.class_id, calculation_id: row.calculation_id, published_at: row.published_at };

    for (const subject of MODEL_SUBJECTS) {
      const col = scoreColumn(p.point, subject);
      const found = row?.subjects?.find((s) => SUBJECT_TO_MODEL[s.subject] === subject);
      const score = found?.score;
      if (Number.isFinite(score)) values[col] = score;
      else missing.scores.push(col);
    }

    const col = attendanceColumn(p.point);
    const { keys, problem } = attendanceKeysUpTo(p.point, termsByNumber);
    if (!keys) {
      missing.attendance.push(col);
      if (problem && !missing.notes.includes(problem)) missing.notes.push(problem);
      continue;
    }
    const result = cumulativeAttendance(keys, byPeriod);
    if (result.percentage === null) {
      missing.attendance.push(col);
      for (const k of result.missing) {
        const label = keys.find((x) => x.key === k)?.label ?? k;
        const note = `No attendance entered for ${label}`;
        if (!missing.notes.includes(note)) missing.notes.push(note);
      }
    } else {
      values[col] = result.percentage;
      attendanceTotals[p.point] = { attended: result.attended, counted: result.counted };
    }
  }
  return { columns, values, missing, sources, attendance_totals: attendanceTotals };
}

/** One CSV line in the contract's column order; missing values are empty. */
export function csvLine(point, studentId, values) {
  return [point, studentId, ...columnsFor(point).map((c) => (values[c] == null ? '' : String(values[c])))].join(',');
}

export const csvHeader = (point) => ['prediction_point', 'student_id', ...columnsFor(point)].join(',');