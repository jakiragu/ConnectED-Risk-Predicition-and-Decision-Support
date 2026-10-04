

export const ASSESSMENT_TYPES = ['Opener', 'Mid-term', 'End-term'];

export const TOTAL_WEIGHT = 100;

/**
 * @param {object} input     candidate assessment (new or merged edit)
 * @param {object} context
 * @param {Array}  context.siblings   other assessments for the same class+subject+term
 * @param {boolean} context.termLocked
 * @returns {Array<{field:string, message:string}>} empty means valid
 */
export function validateAssessment(input, { siblings = [], termLocked = false } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (termLocked) {
    add('term_id', 'Results for this term are published, so assessments are locked');
  }
  if (!input.title || input.title.trim().length < 2) {
    add('title', 'Give the assessment a name');
  }
  if (!input.subject) add('subject', 'Choose a subject');
  if (!ASSESSMENT_TYPES.includes(input.assessment_type)) {
    add('assessment_type', `Type must be one of ${ASSESSMENT_TYPES.join(', ')}`);
  }
  if (!(input.max_score > 0)) {
    add('max_score', 'Maximum score must be greater than zero');
  }
  if (!(input.weight > 0) || input.weight > TOTAL_WEIGHT) {
    add('weight', `Weight must be between 1 and ${TOTAL_WEIGHT}`);
  } else {
    const used = siblings
      .filter((a) => a.assessment_id !== input.assessment_id && !a._deleted)
      .reduce((total, a) => total + a.weight, 0);
    if (used + input.weight > TOTAL_WEIGHT) {
      add(
        'weight',
        `Only ${TOTAL_WEIGHT - used}% of the term weighting is left for ${input.subject}`
      );
    }
  }
  return errors;
}

export function deletionBlocker(assessment, { scoreCount = 0, termLocked = false } = {}) {
  if (termLocked) return 'Results for this term are published, so assessments are locked';
  if (assessment.status === 'LOCKED') return 'This assessment is locked';
  if (scoreCount > 0) {
    return (
      `${scoreCount} mark${scoreCount === 1 ? ' is' : 's are'} recorded against this ` +
      'assessment, so it can no longer be deleted'
    );
  }
  return null;
}
export const weightRemaining = (siblings, subject, excludeId = null) =>
  TOTAL_WEIGHT -
  siblings
    .filter((a) => a.subject === subject && !a._deleted && a.assessment_id !== excludeId)
    .reduce((total, a) => total + a.weight, 0);