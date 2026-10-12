import { MARK } from './score.js';
import { TOTAL_WEIGHT } from './assessment.js';


export const CHECKPOINT = { OPENER: 'OPENER', MIDTERM: 'MIDTERM', ENDTERM: 'ENDTERM' };
export const CHECKPOINTS = [CHECKPOINT.OPENER, CHECKPOINT.MIDTERM, CHECKPOINT.ENDTERM];
export const CHECKPOINT_LABEL = { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End of term' };
export const CHECKPOINT_TYPE = { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End-term' };
export const PREVIOUS = { OPENER: null, MIDTERM: CHECKPOINT.OPENER, ENDTERM: CHECKPOINT.MIDTERM };
export const checkpointsUpTo = (checkpoint) => CHECKPOINTS.slice(0, CHECKPOINTS.indexOf(checkpoint) + 1);

export const RESULT_KIND = { INTERIM: 'INTERIM', FINAL: 'FINAL' };
export const kindOf = (checkpoint) => (checkpoint === CHECKPOINT.ENDTERM ? RESULT_KIND.FINAL : RESULT_KIND.INTERIM);

export const SEVERITY = { BLOCKING: 'BLOCKING', WARNING: 'WARNING' };
export const MISSING_POLICIES = ['EXCLUDE', 'ZERO'];
export const PAPER_MISSING = 'MISSING';

/** Half-up rounding that is not fooled by binary representation (1.005 -> 1.01). */
export function roundHalfUp(x, dp = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  const scaled = Number((Math.abs(x) * f).toPrecision(15));
  return (Math.sign(x) * Math.floor(scaled + 0.5)) / f;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const mean = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

/** Bands must map every whole score 0..100 to exactly one grade. */
export function bandProblems(bands) {
  if (!Array.isArray(bands) || bands.length === 0) return ['The grading scale has no bands'];
  for (const b of bands) {
    if (!b?.grade || !Number.isFinite(b.min_score) || !Number.isFinite(b.max_score) || b.min_score > b.max_score) {
      return [`Grade band ${b?.grade ?? '?'} has an invalid range`];
    }
  }
  const problems = [];
  for (let s = 0; s <= TOTAL_WEIGHT; s++) {
    const hits = bands.filter((b) => s >= b.min_score && s <= b.max_score).length;
    if (hits !== 1) problems.push(`A score of ${s} falls in ${hits === 0 ? 'no' : hits} grade bands`);
  }
  return problems.slice(0, 3);
}

export function gradeFor(score, bands) {
  if (score === null || score === undefined) return null;
  const whole = roundHalfUp(score, 0);
  return bands.find((b) => whole >= b.min_score && whole <= b.max_score)?.grade ?? null;
}

/** Checkpoint weights decide how much each checkpoint exam counts towards the term result. */
export function checkpointWeightProblems(weights) {
  if (!weights) return ['Checkpoint weights have not been set for this term'];
  const values = CHECKPOINTS.map((c) => weights[c]);
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > TOTAL_WEIGHT)) {
    return [`Each checkpoint weight must be between 0 and ${TOTAL_WEIGHT}`];
  }
  const total = roundHalfUp(values.reduce((t, v) => t + v, 0), 2);
  if (!near(total, TOTAL_WEIGHT)) return [`Checkpoint weights add up to ${total}%. They must total ${TOTAL_WEIGHT}%.`];
  return [];
}

const issue = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });

function checkConfiguration({ checkpoint, inScope, gradeRule, roster, previousPublished }) {
  const out = [];
  const block = (code, message, extra) => out.push(issue(SEVERITY.BLOCKING, code, message, extra));

  const previous = PREVIOUS[checkpoint];
  if (previous && !previousPublished) {
    block('PREVIOUS_NOT_PUBLISHED',
      `${CHECKPOINT_LABEL[previous]} results must be published before ${CHECKPOINT_LABEL[checkpoint]} results`);
  }
  if (!gradeRule) {
    block('RULE_MISSING', 'No grading rule is set for this term');
  } else {
    if (!MISSING_POLICIES.includes(gradeRule.missing_score_policy)) {
      block('RULE_INVALID_POLICY', `Missing-mark policy must be one of ${MISSING_POLICIES.join(', ')}`);
    }
    if (checkpoint === CHECKPOINT.ENDTERM) {
      for (const p of bandProblems(gradeRule.bands)) block('RULE_INVALID_BANDS', p);
      for (const p of checkpointWeightProblems(gradeRule.checkpoint_weights)) block('CHECKPOINT_WEIGHTS_INVALID', p);
    }
  }
  if (!roster.length) block('NO_STUDENTS', 'No students are enrolled in this class');
  if (!inScope.length) block('NO_ASSESSMENTS', `There are no ${CHECKPOINT_TYPE[checkpoint]} papers to calculate`);

  for (const a of inScope) {
    if (!(Number.isFinite(a.max_score) && a.max_score > 0)) {
      block('INVALID_MAX_SCORE', `"${a.title}" has no valid maximum score`, { assessment_id: a.assessment_id });
    }
    if (!(Number.isFinite(a.weight) && a.weight > 0 && a.weight <= TOTAL_WEIGHT)) {
      block('INVALID_WEIGHT', `"${a.title}" has an invalid weight`, { assessment_id: a.assessment_id });
    }
  }

  const totals = new Map();
  for (const a of inScope) totals.set(a.subject, (totals.get(a.subject) || 0) + (Number(a.weight) || 0));
  for (const [subject, total] of totals) {
    const t = roundHalfUp(total, 2);
    if (!near(t, TOTAL_WEIGHT)) {
      block('PAPER_WEIGHTS_INVALID',
        `${subject} ${CHECKPOINT_TYPE[checkpoint]} papers add up to ${t}%. They must total ${TOTAL_WEIGHT}%.`, { subject });
    }
  }
  return out;
}

/** One paper's line for one student. */
function paperLine(a, row) {
  const status = row ? row.mark_status || MARK.SCORED : PAPER_MISSING;
  const scored = status === MARK.SCORED;
  const percent = scored ? (row.raw_score / a.max_score) * 100 : null;
  return {
    line: {
      assessment_id: a.assessment_id,
      title: a.title,
      paper_no: a.paper_no ?? null,
      max_score: a.max_score,
      weight: a.weight,
      mark_status: status,
      raw_score: scored ? row.raw_score : null,
      percent: roundHalfUp(percent),
      contribution: scored ? roundHalfUp((percent * a.weight) / 100) : status === MARK.ABSENT ? 0 : null,
    },
    status,
    contribution: scored ? (percent * a.weight) / 100 : 0,
  };
}

/** The subject's term result from its checkpoint scores. */
export function combineCheckpoints(scores, weights) {
  const components = CHECKPOINTS.map((c) => ({ checkpoint: c, score: scores[c] ?? null, weight: weights[c] }));
  const counted = components.filter((c) => c.score !== null && c.weight > 0);
  const applied = counted.reduce((t, c) => t + c.weight, 0);
  const termScore = applied > 0 ? counted.reduce((t, c) => t + c.score * c.weight, 0) / applied : null;
  return { components, weight_applied: roundHalfUp(applied), term_score: roundHalfUp(termScore) };
}

/**
 * @param {object}   input
 * @param {string}   input.checkpoint          OPENER | MIDTERM | ENDTERM
 * @param {object[]} input.assessments         the class's live assessments for the term
 * @param {Map<string, object[]>} input.scoresByAssessment  score rows per in-scope assessment
 * @param {object[]} input.roster              active students
 * @param {object|null} input.gradeRule
 * @param {boolean}  input.previousPublished   the preceding checkpoint is published for this class
 * @param {object}   input.previousRows        ENDTERM only: { OPENER: Map(student -> row), MIDTERM: Map(...) }
 */
export function calculateCheckpoint({
  checkpoint, assessments, scoresByAssessment, roster, gradeRule, previousPublished = false, previousRows = {},
}) {
  if (!CHECKPOINTS.includes(checkpoint)) throw new Error(`Unknown checkpoint ${checkpoint}`);
  const kind = kindOf(checkpoint);
  const type = CHECKPOINT_TYPE[checkpoint];
  const inScope = assessments
    .filter((a) => !a._deleted && a.assessment_type === type)
    .sort((a, b) => a.subject.localeCompare(b.subject) || (a.paper_no ?? 9) - (b.paper_no ?? 9)
      || a.assessment_id.localeCompare(b.assessment_id));
  const examSubjects = [...new Set(inScope.map((a) => a.subject))];

  const issues = checkConfiguration({ checkpoint, inScope, gradeRule, roster, previousPublished });
  const basis = inScope.map((a) => ({
    assessment_id: a.assessment_id,
    subject: a.subject,
    paper_no: a.paper_no ?? null,
    weight: a.weight,
    max_score: a.max_score,
    score_count: a.score_count || 0,
    _version: a._version,
    _lastChangedAt: a._lastChangedAt,
  }));

  // End of term: every subject that appears in any checkpoint gets a term result.
  const subjects = new Set(examSubjects);
  if (kind === RESULT_KIND.FINAL) {
    for (const rows of Object.values(previousRows)) {
      for (const r of rows.values()) for (const s of r.subjects) subjects.add(s.subject);
    }
  }
  const subjectList = [...subjects].sort((a, b) => a.localeCompare(b));

  if (issues.some((i) => i.severity === SEVERITY.BLOCKING)) {
    return { kind, subjects: subjectList, basis, issues, blocking: true, rows: [] };
  }

  const policy = gradeRule.missing_score_policy;
  const bands = gradeRule.bands;
  const weights = gradeRule.checkpoint_weights;
  const rosterIds = new Set(roster.map((s) => s.student_id));

  const marks = new Map();
  for (const a of inScope) {
    const byStudent = new Map();
    for (const row of scoresByAssessment.get(a.assessment_id) || []) {
      if (row._deleted || !rosterIds.has(row.student_id)) continue;
      byStudent.set(row.student_id, row);
      if (row.status === 'CONFLICT_REVIEW') {
        issues.push(issue(SEVERITY.BLOCKING, 'UNRESOLVED_CONFLICT',
          `"${a.title}" has a disputed mark that needs a decision`,
          { assessment_id: a.assessment_id, student_id: row.student_id }));
      }
      const scored = (row.mark_status || MARK.SCORED) === MARK.SCORED;
      if (scored && !(Number.isFinite(row.raw_score) && row.raw_score >= 0 && row.raw_score <= a.max_score)) {
        issues.push(issue(SEVERITY.BLOCKING, 'SCORE_OUT_OF_RANGE', `"${a.title}" holds a mark outside 0 to ${a.max_score}`,
          { assessment_id: a.assessment_id, student_id: row.student_id }));
      }
    }
    marks.set(a.assessment_id, byStudent);
    const missing = roster.length - byStudent.size;
    if (missing > 0) {
      issues.push(issue(SEVERITY.WARNING, 'MISSING_MARKS',
        `"${a.title}": ${missing} student${missing === 1 ? ' has' : 's have'} no mark ` +
          `(${policy === 'ZERO' ? 'counted as 0' : 'left out of the calculation'})`,
        { assessment_id: a.assessment_id, subject: a.subject }));
    }
  }

  const zeroCovered = new Map();
  const partialTerm = new Map();
  const rows = roster.map((student) => {
    const subjectRows = subjectList.map((subject) => {
      let earned = 0;
      let covered = 0;
      const counts = { assessed_count: 0, absent_count: 0, not_assessed_count: 0, missing_count: 0 };
      const papers = [];
      for (const a of inScope.filter((x) => x.subject === subject)) {
        const { line, status, contribution } = paperLine(a, marks.get(a.assessment_id).get(student.student_id));
        papers.push(line);
        if (status === MARK.SCORED) {
          earned += contribution;
          covered += a.weight;
          counts.assessed_count++;
        } else if (status === MARK.ABSENT) {
          covered += a.weight;
          counts.absent_count++;
        } else if (status === MARK.NOT_ASSESSED) {
          counts.not_assessed_count++;
        } else {
          counts.missing_count++;
          if (policy === 'ZERO') covered += a.weight;
        }
      }
      const inExam = papers.length > 0;
      if (inExam && covered === 0) zeroCovered.set(subject, (zeroCovered.get(subject) || 0) + 1);
      const out = {
        subject,
        papers,
        earned: roundHalfUp(earned),
        covered: roundHalfUp(covered),
        score: covered > 0 ? roundHalfUp((earned / covered) * 100) : null,
        ...counts,
        term: null,
      };
      if (kind === RESULT_KIND.FINAL) {
        const scoreOf = (c) =>
          previousRows[c]?.get(student.student_id)?.subjects.find((s) => s.subject === subject)?.score ?? null;
        const term = combineCheckpoints(
          { OPENER: scoreOf(CHECKPOINT.OPENER), MIDTERM: scoreOf(CHECKPOINT.MIDTERM), ENDTERM: out.score },
          weights
        );
        if (term.term_score !== null && term.weight_applied < TOTAL_WEIGHT) {
          partialTerm.set(subject, (partialTerm.get(subject) || 0) + 1);
        }
        out.term = { ...term, grade: gradeFor(term.term_score, bands) };
      }
      return out;
    });

    const examScores = subjectRows.filter((s) => s.papers.length && s.score !== null).map((s) => s.score);
    const result = {
      student_id: student.student_id,
      kind,
      subjects: subjectRows,
      checkpoint_average: roundHalfUp(mean(examScores)),
      term_average: null,
      term_grade: null,
    };
    if (kind === RESULT_KIND.FINAL) {
      const termScores = subjectRows.filter((s) => s.term.term_score !== null).map((s) => s.term.term_score);
      result.term_average = roundHalfUp(mean(termScores));
      result.term_grade = gradeFor(result.term_average, bands);
    }
    return result;
  });

  for (const [subject, n] of zeroCovered) {
    issues.push(issue(SEVERITY.WARNING, 'ZERO_COVERED',
      `${subject}: ${n} student${n === 1 ? ' has' : 's have'} no counted paper, so no ${type} result is shown`, { subject }));
  }
  for (const [subject, n] of partialTerm) {
    issues.push(issue(SEVERITY.WARNING, 'PARTIAL_TERM',
      `${subject}: ${n} student${n === 1 ? ' has' : 's have'} no result in at least one checkpoint; ` +
        'their term result uses the checkpoints they have', { subject }));
  }

  return {
    kind,
    subjects: subjectList,
    basis,
    issues,
    blocking: issues.some((i) => i.severity === SEVERITY.BLOCKING),
    rows,
  };
}

/**
 * Cumulative report card content: every published checkpoint up to and
 * including this one. Interim cards carry exam scores only; the End of term
 * card adds checkpoint weights, term scores and grades.
 *
 * @param {object} input
 * @param {string} input.checkpoint
 * @param {{set: object, row: object}[]} input.entries  one per checkpoint up to `checkpoint`, in order
 */
export function reportCardModel({ checkpoint, school, term, klass, student, entries }) {
  const current = entries.find((e) => e.set.checkpoint === checkpoint);
  const kind = kindOf(checkpoint);
  const included = entries.filter((e) => checkpointsUpTo(checkpoint).includes(e.set.checkpoint));
  const subjects = [...new Set(included.flatMap((e) => e.row.subjects.map((s) => s.subject)))].sort((a, b) => a.localeCompare(b));

  return {
    kind,
    checkpoint,
    school_name: school?.name || current.set.school_id,
    term_name: term?.name || current.set.term_id,
    class_name: klass?.name || current.set.class_id,
    student_name: student ? `${student.first_name} ${student.last_name}` : current.row.student_id,
    admission_no: student?.admission_no ?? null,
    published_at: current.set.published_at,
    calculation_id: current.set.calculation_id,
    checkpoint_weights: kind === RESULT_KIND.FINAL ? current.set.basis_checkpoint_weights : null,
    subjects: subjects.map((subject) => {
      const own = current.row.subjects.find((s) => s.subject === subject);
      return {
        subject,
        checkpoints: included.map((e) => {
          const s = e.row.subjects.find((x) => x.subject === subject);
          return {
            checkpoint: e.set.checkpoint,
            label: CHECKPOINT_LABEL[e.set.checkpoint],
            papers: s?.papers || [],
            score: s?.score ?? null,
          };
        }),
        term_score: kind === RESULT_KIND.FINAL ? own?.term?.term_score ?? null : null,
        grade: kind === RESULT_KIND.FINAL ? own?.term?.grade ?? null : null,
      };
    }),
    checkpoint_average: current.row.checkpoint_average,
    term_average: kind === RESULT_KIND.FINAL ? current.row.term_average : null,
    term_grade: kind === RESULT_KIND.FINAL ? current.row.term_grade : null,
  };
}

/**
 * The integration contract with the risk layer. Identifiers only: consumers
 * read results through the authorised API. The consumer decides what each
 * checkpoint_type means for it.
 */
export function resultsPublishedEvent(set) {
  return {
    source: 'csg.gradebook',
    detail_type: 'ResultsPublished',
    detail: {
      event_id: set.event_id,
      schema_version: 1,
      school_id: set.school_id,
      class_id: set.class_id,
      term_id: set.term_id,
      checkpoint_type: set.checkpoint,
      result_kind: set.kind,
      calculation_id: set.calculation_id,
      result_set_version: set._version,
      published_at: set.published_at,
      published_by: set.published_by,
      assessment_ids: (set.basis || []).map((b) => b.assessment_id),
      student_ids: set.student_ids || [],
    },
  };
}