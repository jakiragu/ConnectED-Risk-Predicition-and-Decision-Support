/** Fixed for now; an Admin-managed catalogue will replace this list later. */
export const SUBJECTS = [
  'Mathematics', 'English', 'Kiswahili', 'Biology', 'Physics', 'Chemistry',
  'Geography', 'History', 'CRE', 'Computer Studies',
];

/**
 * Each assessment is one component of a subject's checkpoint exam: a paper, a
 * CAT, a quiz, a practical or a project. Numbers restart for each kind, so an
 * exam can hold Paper 1, Paper 2, CAT 1, CAT 2 and Quiz 1 together. A number is
 * unique per class + term + subject + exam + kind (stored as paper_no).
 *
 * MAX_COMPONENTS caps all kinds together for one subject's exam. It comes from
 * publication: publishing a class checkpoint locks every component in one
 * DynamoDB transaction (at most 100 items, of which 96 can be components; see
 * resultsRepo.MAX_PUBLISH_PAPERS). 10 subjects x 8 = 80.
 */
export const MAX_COMPONENTS = 8;
/** The numbers a kind can use: 1 to MAX_COMPONENTS (also the most one kind could hold). */
export const PAPERS = Array.from({ length: MAX_COMPONENTS }, (_, i) => i + 1);

/** What kind of component an assessment is. It changes the name only; every kind is calculated the same way. */
export const COMPONENT_TYPES = ['PAPER', 'CAT', 'QUIZ', 'PRACTICAL', 'PROJECT'];
export const COMPONENT_LABEL = { PAPER: 'Paper', CAT: 'CAT', QUIZ: 'Quiz', PRACTICAL: 'Practical', PROJECT: 'Project' };
/** Rows created before component types existed are papers. */
export const componentTypeOf = (a) => (COMPONENT_TYPES.includes(a?.component_type) ? a.component_type : 'PAPER');
export const componentLabel = (a) => COMPONENT_LABEL[componentTypeOf(a)];
/** Display order: papers, then CATs, quizzes, practicals, projects; each by number. */
export const componentOrder = (a) =>
  COMPONENT_TYPES.indexOf(componentTypeOf(a)) * 100 + (a?.paper_no ?? 99);

/** The components of one subject in one checkpoint make up that exam: 100%. */
export const TOTAL_WEIGHT = 100;

/**
 * The checkpoint an assessment type belongs to. Older rows store the label
 * ('Mid-term'), newer ones the key ('MIDTERM'); both mean the same exam.
 */
export const checkpointOf = (assessmentType) => String(assessmentType || '').toUpperCase().replace(/[^A-Z]/g, '');

const live = (a) => !a._deleted;
const sameExam = (a, subject, type) =>
  live(a) && a.subject === subject && checkpointOf(a.assessment_type) === checkpointOf(type);

/** Weight already used by the other components of the same subject + checkpoint exam. */
export const weightUsed = (siblings, subject, type, excludeId = null) =>
  siblings
    .filter((a) => sameExam(a, subject, type) && a.assessment_id !== excludeId)
    .reduce((total, a) => total + Number(a.weight || 0), 0);

export const weightRemaining = (siblings, subject, type, excludeId = null) =>
  TOTAL_WEIGHT - weightUsed(siblings, subject, type, excludeId);

/** How many components a subject's exam already has, of any kind. */
export const componentsIn = (siblings, subject, type, excludeId = null) =>
  siblings.filter((a) => sameExam(a, subject, type) && a.assessment_id !== excludeId).length;

/** Numbers already taken by one kind in a subject + checkpoint exam (kind defaults to PAPER). */
export const papersTaken = (siblings, subject, type, excludeId = null, kind = 'PAPER') =>
  siblings
    .filter((a) => sameExam(a, subject, type) && a.assessment_id !== excludeId && a.paper_no
      && componentTypeOf(a) === kind)
    .map((a) => a.paper_no);

/** Weight totals per subject + checkpoint, for budgets and publication checks. assessment_type is the checkpoint key. */
export function examTotals(assessments) {
  const totals = new Map();
  for (const a of assessments.filter(live)) {
    const checkpoint = checkpointOf(a.assessment_type);
    const key = `${a.subject}|${checkpoint}`;
    const t = totals.get(key) || { subject: a.subject, assessment_type: checkpoint, weight: 0, papers: 0 };
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
 * @param {string[]} context.assessmentTypes  checkpoint keys held in this term (OPENER only when the Opener is held)
 * @param {object}  context.typeLabels the school's checkpoint names, for messages
 */
export function validateAssessment(
  input,
  { siblings = [], termLocked = false, original = null, scoreCount = 0, assessmentTypes = [], typeLabels = null } = {}
) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const checkpoint = checkpointOf(input.assessment_type);
  const examName = typeLabels?.[checkpoint] || input.assessment_type;

  if (termLocked) add('term_id', 'Results for this term are published, so assessments are locked');
  if (!input.title || input.title.trim().length < 2) add('title', 'Give the assessment a name');
  const legacySubject = original && original.subject === input.subject;
  if (!input.subject) add('subject', 'Choose a subject');
  else if (!SUBJECTS.includes(input.subject) && !legacySubject) add('subject', 'Choose a subject from the list');
  // An existing row keeps the exam it already belongs to, even if it was stored under an older name.
  const unchangedExam = original && original.assessment_type === input.assessment_type;
  if (!input.assessment_type || (!assessmentTypes.includes(checkpoint) && !unchangedExam)) {
    add('assessment_type', 'Choose an exam that is held this term');
  }
  if (input.component_type != null && !COMPONENT_TYPES.includes(input.component_type)) {
    add('component_type', `Choose ${COMPONENT_TYPES.map((t) => COMPONENT_LABEL[t]).join(', ')}`);
  }

  const kind = componentTypeOf(input);
  const kindName = COMPONENT_LABEL[kind];
  const paper = Number(input.paper_no);
  if (!PAPERS.includes(paper)) {
    add('paper_no', `Choose a number from 1 to ${MAX_COMPONENTS}`);
  } else if (input.subject && papersTaken(siblings, input.subject, input.assessment_type, input.assessment_id, kind).includes(paper)) {
    add('paper_no', `${input.subject} ${examName} already has ${kindName} ${paper}`);
  } else if (input.subject && componentsIn(siblings, input.subject, input.assessment_type, input.assessment_id) >= MAX_COMPONENTS) {
    add('paper_no', `${input.subject} ${examName} already has ${MAX_COMPONENTS} components, the most one exam can hold`);
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
      add('weight', `Only ${TOTAL_WEIGHT - used}% of the ${input.subject} ${examName} exam is left`);
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
