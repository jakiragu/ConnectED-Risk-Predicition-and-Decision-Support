import {
  CHECKPOINT,
  CHECKPOINTS,
  CHECKPOINT_LABEL,
  OPTIONAL_CHECKPOINTS,
  checkpointWeightProblems,
  checkpointsFor,
} from './results.js';
import { checkpointOf } from './assessment.js';

/**
 * The school's assessment setup. Pure: shared by the services and the screens.
 *
 * What a school may set:
 *   - a name for each of the three checkpoints ("End-term" -> "Final exam"),
 *   - whether new terms hold an Opener by default,
 *   - default checkpoint weights for new terms.
 * The checkpoints themselves are fixed (Opener, Mid-term, End-term); see
 * results.js for why.
 *
 * Whether a particular term holds an Opener lives on that term's GradeRule
 * (opener_enabled), next to its checkpoint weights, so a past term's results
 * keep the setup they were published under. A new term copies the school
 * defaults (calendar-service). A GradeRule written before this setting existed
 * falls back to the school default; see openerEnabledFor.
 *
 * Stored shape (AssessmentConfig item):
 *   assessment_scheme: [{ key: 'OPENER'|'MIDTERM'|'ENDTERM', name, enabled }]
 *   default_checkpoint_weights: { OPENER, MIDTERM, ENDTERM } | null
 * Older stored schemes (other fields, or no OPENER entry) are read through
 * effectiveScheme: a missing OPENER entry means "no Opener by default".
 */

export const DEFAULT_ASSESSMENT_SCHEME = [
  { key: CHECKPOINT.OPENER, name: 'Opener', enabled: true },
  { key: CHECKPOINT.MIDTERM, name: 'Mid-term', enabled: true },
  { key: CHECKPOINT.ENDTERM, name: 'End-term', enabled: true },
];

const NAME_MIN = 2;
const NAME_MAX = 40;

/** The three checkpoints in order, with the school's names and default Opener choice. Never throws. */
export function effectiveScheme(config) {
  const stored = Array.isArray(config?.assessment_scheme) ? config.assessment_scheme : null;
  if (!stored) return DEFAULT_ASSESSMENT_SCHEME.map((item, i) => ({ ...item, order: i + 1 }));
  const byKey = new Map(stored.filter((item) => item && item.key).map((item) => [checkpointOf(item.key), item]));
  return CHECKPOINTS.map((key, i) => {
    const item = byKey.get(key);
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : CHECKPOINT_LABEL[key];
    const optional = OPTIONAL_CHECKPOINTS.includes(key);
    return { key, name, order: i + 1, enabled: optional ? Boolean(item) && item.enabled !== false : true };
  });
}

/** { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'Final exam' } */
export const labelsOf = (config) => Object.fromEntries(effectiveScheme(config).map((item) => [item.key, item.name]));

/** Whether new terms hold an Opener. */
export const openerDefault = (config) => effectiveScheme(config).find((item) => item.key === CHECKPOINT.OPENER).enabled;

/** Whether this term holds an Opener: its own setting, else the school default. */
export const openerEnabledFor = (gradeRule, config) =>
  typeof gradeRule?.opener_enabled === 'boolean' ? gradeRule.opener_enabled : openerDefault(config);

/** The checkpoint keys assessments may be created under in a term. */
export const assessmentTypesFor = (openerEnabled) => checkpointsFor(openerEnabled);

/** Valid default weights, or null when none are set. */
export function defaultWeightsOf(config) {
  const w = config?.default_checkpoint_weights;
  if (!w) return null;
  return checkpointWeightProblems(w, { openerEnabled: openerDefault(config) }).length ? null : w;
}

/** @returns {string[]} problems; empty when the scheme can be saved */
export function validateAssessmentScheme(scheme) {
  if (!Array.isArray(scheme) || scheme.length === 0) return ['Name the school\'s checkpoints'];
  const errors = [];
  const seen = new Set();
  const names = new Set();
  for (const item of scheme) {
    const key = item?.key;
    if (!CHECKPOINTS.includes(key)) {
      errors.push(`${key || 'An entry'} is not a checkpoint. The checkpoints are ${CHECKPOINTS.join(', ')}. ` +
        'Add CATs, practicals and projects as components of a checkpoint exam instead.');
      continue;
    }
    if (seen.has(key)) errors.push(`${key} is listed more than once`);
    seen.add(key);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      errors.push(`The name for ${CHECKPOINT_LABEL[key]} must be ${NAME_MIN} to ${NAME_MAX} characters`);
    } else if (names.has(name.toLowerCase())) {
      errors.push(`Two checkpoints are called "${name}"`);
    } else {
      names.add(name.toLowerCase());
    }
    if (item.enabled === false && !OPTIONAL_CHECKPOINTS.includes(key)) {
      errors.push(`${CHECKPOINT_LABEL[key]} is always held: the term result and the risk predictions depend on it`);
    }
  }
  for (const key of CHECKPOINTS) {
    if (!OPTIONAL_CHECKPOINTS.includes(key) && !seen.has(key)) errors.push(`Name the ${CHECKPOINT_LABEL[key]}`);
  }
  return errors;
}

/** The scheme as stored: all three checkpoints, in order. */
export function normalizeAssessmentScheme(scheme) {
  const byKey = new Map(scheme.map((item) => [item.key, item]));
  return CHECKPOINTS.map((key) => {
    const item = byKey.get(key);
    return {
      key,
      name: item ? item.name.trim() : CHECKPOINT_LABEL[key],
      enabled: OPTIONAL_CHECKPOINTS.includes(key) ? Boolean(item) && item.enabled !== false : true,
    };
  });
}

/** Problems with the default weights, judged against the scheme's default Opener choice. null weights are allowed. */
export function defaultWeightProblems(weights, scheme) {
  if (weights == null) return [];
  const openerEnabled = normalizeAssessmentScheme(scheme).find((item) => item.key === CHECKPOINT.OPENER).enabled;
  return checkpointWeightProblems(weights, { openerEnabled, labels: labelsOf({ assessment_scheme: scheme }) });
}
