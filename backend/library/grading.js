import { bandProblems, gradeFor, MISSING_POLICIES } from './results.js';

/**
 * A school's grading rules: the grade bands, the pass mark and what happens to
 * a missing mark. They exist at two levels:
 *
 *   school default (GRADEPOLICY#DEFAULT)  --copied when a term is created-->  the term's GradeRule
 *
 * A term's rules can change until any of its results are published; after that
 * they are fixed, so published grades never change silently. Changing the
 * default only affects terms created afterwards.
 *
 * Shared by the Lambda services and the React client, so the settings form and
 * the server run exactly the same checks.
 */

/** The scale the project was seeded with; a school replaces it in Settings. */
export const DEFAULT_BANDS = [
  { grade: 'A', min_score: 91, max_score: 100 },
  { grade: 'A-', min_score: 81, max_score: 90 },
  { grade: 'B', min_score: 71, max_score: 80 },
  { grade: 'B-', min_score: 61, max_score: 70 },
  { grade: 'C', min_score: 51, max_score: 60 },
  { grade: 'C-', min_score: 41, max_score: 50 },
  { grade: 'D', min_score: 31, max_score: 40 },
  { grade: 'D-', min_score: 21, max_score: 30 },
  { grade: 'E', min_score: 0, max_score: 20 },
];

/** Used when a school has never saved its own default. */
export const DEFAULT_GRADING = Object.freeze({
  pass_mark: 50,
  missing_score_policy: 'EXCLUDE',
  bands: DEFAULT_BANDS,
});

export const MISSING_POLICY_LABEL = {
  EXCLUDE: 'Left out of the calculation',
  ZERO: 'Counted as 0',
};

export const MISSING_POLICY_HELP = {
  EXCLUDE: 'A student’s average uses only the papers they sat. Missing papers do not pull the average down.',
  ZERO: 'A missing mark counts as 0, so it lowers the student’s average.',
};

export const MAX_BANDS = 15;
export const MAX_GRADE_LENGTH = 4;

const isWhole = (x) => Number.isInteger(x);

/**
 * Builds the full bands from the lowest mark of each grade. Only the lower
 * marks are entered; each band then runs up to one below the band above it,
 * and the top band runs to 100. Gaps and overlaps cannot happen this way.
 *
 * @param {{grade:string, min_score:number|string}[]} entries
 * @returns {{bands: {grade,min_score,max_score}[], problems: string[]}}
 */
export function bandsFromLowerBounds(entries) {
  const problems = [];
  const rows = (entries || []).map((e) => ({
    grade: String(e?.grade ?? '').trim(),
    min_score: e?.min_score === '' || e?.min_score == null ? NaN : Number(e.min_score),
  }));

  if (rows.length < 2) problems.push('Add at least two grades');
  if (rows.length > MAX_BANDS) problems.push(`Use at most ${MAX_BANDS} grades`);

  const seen = new Set();
  for (const r of rows) {
    if (!r.grade) { problems.push('Every grade needs a name, for example A or B+'); break; }
    if (r.grade.length > MAX_GRADE_LENGTH) problems.push(`Grade “${r.grade}” is too long (at most ${MAX_GRADE_LENGTH} characters)`);
    const key = r.grade.toUpperCase();
    if (seen.has(key)) problems.push(`Grade “${r.grade}” appears more than once`);
    seen.add(key);
  }
  for (const r of rows) {
    if (!Number.isFinite(r.min_score) || !isWhole(r.min_score) || r.min_score < 0 || r.min_score > 100) {
      problems.push(`The lowest mark for ${r.grade || 'each grade'} must be a whole number from 0 to 100`);
      break;
    }
  }
  const mins = rows.map((r) => r.min_score).filter(Number.isFinite);
  if (new Set(mins).size !== mins.length) problems.push('Two grades start at the same mark');
  if (mins.length && !mins.includes(0)) problems.push('The lowest grade must start at 0, so every mark gets a grade');

  if (problems.length) return { bands: [], problems: [...new Set(problems)] };

  const sorted = [...rows].sort((a, b) => b.min_score - a.min_score);
  const bands = sorted.map((r, i) => ({
    grade: r.grade,
    min_score: r.min_score,
    max_score: i === 0 ? 100 : sorted[i - 1].min_score - 1,
  }));
  return { bands, problems: bandProblems(bands) };
}

/** Problems with a complete set of grading rules; empty when they are valid. */
export function gradingProblems({ pass_mark, missing_score_policy, bands }) {
  const problems = [];
  const pm = Number(pass_mark);
  if (pass_mark === '' || pass_mark == null || !Number.isFinite(pm) || pm < 0 || pm > 100) {
    problems.push('The pass mark must be a number from 0 to 100');
  }
  if (!MISSING_POLICIES.includes(missing_score_policy)) problems.push('Choose what happens to a missing mark');
  problems.push(...bandProblems(bands));
  return problems;
}

/**
 * Validates form input and returns the rules to store. `bands` in the input are
 * lower bounds only ({grade, min_score}).
 */
export function normaliseGrading(input) {
  const { bands, problems: bandIssues } = bandsFromLowerBounds(input?.bands);
  const rules = {
    pass_mark: input?.pass_mark === '' || input?.pass_mark == null ? null : Number(input.pass_mark),
    missing_score_policy: input?.missing_score_policy ?? null,
    bands,
  };
  const problems = bandIssues.length
    ? [...gradingProblems({ ...rules, bands: DEFAULT_BANDS }), ...bandIssues]
    : gradingProblems(rules);
  return { rules, problems: [...new Set(problems)] };
}

/** True when two sets of rules would grade every mark the same way. */
export function sameGrading(a, b) {
  if (!a || !b) return false;
  if (Number(a.pass_mark) !== Number(b.pass_mark) || a.missing_score_policy !== b.missing_score_policy) return false;
  const key = (bands) => JSON.stringify([...(bands || [])].sort((x, y) => y.min_score - x.min_score)
    .map((x) => [x.grade, x.min_score, x.max_score]));
  return key(a.bands) === key(b.bands);
}

/**
 * How a set of marks would be graded under the current and the proposed bands.
 * Used to preview a change before it is saved.
 *
 * @returns {{changed:number, total:number, moves:{from:string,to:string,count:number}[], counts:{grade,current,proposed}[]}}
 */
export function gradingPreview(marks, currentBands, proposedBands) {
  const values = (marks || []).filter((m) => Number.isFinite(m));
  const moves = new Map();
  const current = new Map();
  const proposed = new Map();
  let changed = 0;
  for (const m of values) {
    const before = gradeFor(m, currentBands || []) ?? '—';
    const after = gradeFor(m, proposedBands || []) ?? '—';
    current.set(before, (current.get(before) || 0) + 1);
    proposed.set(after, (proposed.get(after) || 0) + 1);
    if (before !== after) {
      changed += 1;
      const k = `${before}→${after}`;
      moves.set(k, { from: before, to: after, count: (moves.get(k)?.count || 0) + 1 });
    }
  }
  const order = [...(proposedBands || [])].sort((a, b) => b.min_score - a.min_score).map((b) => b.grade);
  for (const g of [...current.keys()]) if (!order.includes(g)) order.push(g);
  return {
    changed,
    total: values.length,
    moves: [...moves.values()].sort((a, b) => b.count - a.count),
    counts: order.map((grade) => ({ grade, current: current.get(grade) || 0, proposed: proposed.get(grade) || 0 })),
  };
}
