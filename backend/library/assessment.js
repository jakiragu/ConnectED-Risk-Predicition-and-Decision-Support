export const ASSESSMENT_TYPES = ['Opener', 'Mid-term', 'End-term'];

export const TOTAL_WEIGHT = 100;

/**
 * @param {object} input              candidate assessment (new, or stored row merged with an edit)
 * @param {object} context
 * @param {Array}   context.siblings   other assessments for the same class+subject+term
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
  if (!input.subject) add('subject', 'Choose a subject');
  if (!ASSESSMENT_TYPES.includes(input.assessment_type)) {
    add('assessment_type', `Type must be one of ${ASSESSMENT_TYPES.join(', ')}`);
  }
  if (!(input.max_score > 0)) {
    add('max_score', 'Maximum score must be greater than zero');
  } else if (original && scoreCount > 0 && input.max_score !== original.max_score) {
    // A-15: a recorded 45 means "45 out of the max_score at the time".
    add('max_score', maxScoreFrozen(scoreCount, original.max_score));
  }
  if (!(input.weight > 0) || input.weight > TOTAL_WEIGHT) {
    add('weight', `Weight must be between 1 and ${TOTAL_WEIGHT}`);
  } else {
    const used = siblings
      .filter((a) => a.assessment_id !== input.assessment_id && !a._deleted)
      .reduce((total, a) => total + a.weight, 0);
    if (used + input.weight > TOTAL_WEIGHT) {
      add('weight', `Only ${TOTAL_WEIGHT - used}% of the term weighting is left for ${input.subject}`);
    }
  }
  return errors;
}

export const maxScoreFrozen = (scoreCount, maxScore) =>
  `${scoreCount} mark${scoreCount === 1 ? ' is' : 's are'} already recorded out of ${maxScore}. ` +
  'Changing the maximum would change what they mean.';

/** Weight still unassigned for a subject. */
export const weightRemaining = (siblings, subject, excludeId = null) =>
  TOTAL_WEIGHT -
  siblings
    .filter((a) => a.subject === subject && !a._deleted && a.assessment_id !== excludeId)
    .reduce((total, a) => total + a.weight, 0);


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