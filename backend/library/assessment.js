export const ASSESSMENT_TYPES = ['Opener', 'Mid-term', 'End-term'];

/** Fixed for now; an Admin-managed catalogue will replace this list later. */
export const SUBJECTS = [
  'Mathematics', 'English', 'Kiswahili', 'Biology', 'Physics', 'Chemistry',
  'Geography', 'History', 'CRE', 'Computer Studies',
];

/** Each assessment is one paper of a subject's checkpoint exam. */
export const PAPERS = [1, 2, 3];

/** The papers of one subject in one checkpoint make up that exam: 100%. */
export const TOTAL_WEIGHT = 100;

const live = (a) => !a._deleted;
const sameExam = (a, subject, type) => live(a) && a.subject === subject && a.assessment_type === type;

/** Weight already used by the other papers of the same subject + checkpoint exam. */
export const weightUsed = (siblings, subject, type, excludeId = null) =>
  siblings
    .filter((a) => sameExam(a, subject, type) && a.assessment_id !== excludeId)
    .reduce((total, a) => total + Number(a.weight || 0), 0);

export const weightRemaining = (siblings, subject, type, excludeId = null) =>
  TOTAL_WEIGHT - weightUsed(siblings, subject, type, excludeId);

/** Paper numbers already taken in a subject + checkpoint exam. */
export const papersTaken = (siblings, subject, type, excludeId = null) =>
  siblings
    .filter((a) => sameExam(a, subject, type) && a.assessment_id !== excludeId && a.paper_no)
    .map((a) => a.paper_no);

/** Weight totals per subject + checkpoint type, for budgets and publication checks. */
export function examTotals(assessments) {
  const totals = new Map();
  for (const a of assessments.filter(live)) {
    const key = `${a.subject}|${a.assessment_type}`;
    const t = totals.get(key) || { subject: a.subject, assessment_type: a.assessment_type, weight: 0, papers: 0 };
    t.weight += Number(a.weight || 0);
    t.papers += 1;
    totals.set(key, t);
  }
  return [...totals.values()];
}

/**
 * @param {object} input              candidate assessment (new, or stored row merged with an edit)
 * @param {object} context
 * @param {Array}   context.siblings   other assessments for the same class + term
 * @param {boolean} context.termLocked
 * @param {object}  context.original   the stored row, when this is an edit
 * @param {number}  context.scoreCount marks already recorded against it
 */
export function validateAssessment(
  input,
  { siblings = [], termLocked = false, original = null, scoreCount = 0 } = {}
) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (termLocked) add('term_id', 'Results for this term are published, so assessments are locked');
  if (!input.title || input.title.trim().length < 2) add('title', 'Give the assessment a name');
  const legacySubject = original && original.subject === input.subject;
  if (!input.subject) add('subject', 'Choose a subject');
  else if (!SUBJECTS.includes(input.subject) && !legacySubject) add('subject', 'Choose a subject from the list');
  if (!ASSESSMENT_TYPES.includes(input.assessment_type)) {
    add('assessment_type', `Type must be one of ${ASSESSMENT_TYPES.join(', ')}`);
  }

  const paper = Number(input.paper_no);
  if (!PAPERS.includes(paper)) {
    add('paper_no', `Choose paper ${PAPERS.join(', ')}`);
  } else if (input.subject && papersTaken(siblings, input.subject, input.assessment_type, input.assessment_id).includes(paper)) {
    add('paper_no', `${input.subject} ${input.assessment_type} already has a paper ${paper}`);
  }

  if (!(input.max_score > 0)) {
    add('max_score', 'Maximum score must be greater than zero');
  } else if (original && scoreCount > 0 && input.max_score !== original.max_score) {
    // A-15: a recorded 45 means "45 out of the max_score at the time".
    add('max_score', maxScoreFrozen(scoreCount, original.max_score));
  }
  if (!(input.weight > 0) || input.weight > TOTAL_WEIGHT) {
    add('weight', `Weight must be between 1 and ${TOTAL_WEIGHT}`);
  } else if (input.subject) {
    const used = weightUsed(siblings, input.subject, input.assessment_type, input.assessment_id);
    if (used + input.weight > TOTAL_WEIGHT) {
      add('weight', `Only ${TOTAL_WEIGHT - used}% of the ${input.subject} ${input.assessment_type} exam is left`);
    }
  }
  return errors;
}

export const maxScoreFrozen = (scoreCount, maxScore) =>
  `${scoreCount} mark${scoreCount === 1 ? ' is' : 's are'} already recorded out of ${maxScore}. ` +
  'Changing the maximum would change what they mean.';

export function recordingStatus(assessment, rosterSize) {
  if (assessment.status === 'LOCKED') return 'LOCKED';
  const n = assessment.score_count || 0;
  if (n === 0) return 'UNRECORDED';
  return rosterSize > 0 && n >= rosterSize ? 'RECORDED' : 'RECORDING';
}

export function deletionBlocker(assessment, { termLocked = false } = {}) {
  if (termLocked) return 'Results for this term are published, so assessments are locked';
  if (assessment.status === 'LOCKED') return 'This assessment is locked';
  const n = assessment.score_count || 0;
  if (n > 0) {
    return (
      `${n} mark${n === 1 ? ' is' : 's are'} recorded against this assessment. ` +
      'Only an administrator can delete it, and it can be restored afterwards.'
    );
  }
  return null;
}