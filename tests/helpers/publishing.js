import assert from 'node:assert/strict';
import { CALCULATE_TERM_RESULTS, CREATE_ASSESSMENT, GET_CLASS_ROSTER, PUBLISH_RESULTS, SUBMIT_SCORES } from '../../src/api/operations.js';
import { ulid } from '../../backend/library/ids.js';
import { as, CLASS, SCHOOL } from './api.js';

/**
 * Calculating and publishing results for the test class, the way an administrator does.
 *
 * The seed already holds complete, scored papers for the test class (every model subject, at
 * 100% of each exam) for Term 1 Opener, Mid-term and End-term, Term 2 Mid-term and End-term, and
 * Term 3 Mid-term. These helpers publish THAT data and add nothing to it, so what is published
 * is exactly what the system was seeded with.
 *
 * The service publishes in order (Opener, then Mid-term, then End of term), so publishThrough()
 * publishes every earlier checkpoint that is not yet published.
 */
export const CHAIN = ['OPENER', 'MIDTERM', 'ENDTERM'];
export const scope = (term, checkpoint) => ({ school_id: SCHOOL, class_id: CLASS, term_id: term, checkpoint });

const RESULT_SETS = `
  query ListResultSets($school_id: ID!, $class_id: ID!, $term_id: ID!) {
    listResultSets(school_id: $school_id, class_id: $class_id, term_id: $term_id) {
      checkpoint status _version blocking issues { severity message }
    }
  }`;
const GRADE_RULE = `
  query GetGradeRule($school_id: ID!, $term_id: ID!) {
    getGradeRule(school_id: $school_id, term_id: $term_id) { checkpoint_weights_version checkpoint_weights_problems }
  }`;
const SET_WEIGHTS = `
  mutation SetCheckpointWeights($input: SetCheckpointWeightsInput!) {
    setCheckpointWeights(input: $input) { checkpoint_weights_problems }
  }`;

export const resultSet = async (term, checkpoint) =>
  (await as('john', RESULT_SETS, { school_id: SCHOOL, class_id: CLASS, term_id: term })).listResultSets.find((r) => r.checkpoint === checkpoint);

/** End of term results need checkpoint weights totalling 100; the seed leaves Terms 1 and 3 without. Set them only if missing. */
export async function ensureCheckpointWeights(term) {
  const rule = (await as('john', GRADE_RULE, { school_id: SCHOOL, term_id: term })).getGradeRule;
  assert.ok(rule, `${term} has no grading rule, so its results cannot be calculated`);
  if (rule.checkpoint_weights_problems.length) {
    await as('john', SET_WEIGHTS, { input: { school_id: SCHOOL, term_id: term, opener: 20, midterm: 30, endterm: 50, _version: rule.checkpoint_weights_version } });
  }
}

/** Calculates a checkpoint; blocking problems are reported with the service's own messages. */
export async function calculate(term, checkpoint) {
  const set = (await as('john', CALCULATE_TERM_RESULTS, { input: scope(term, checkpoint) })).calculateTermResults;
  if (set.blocking) {
    const why = set.issues.filter((i) => i.severity === 'BLOCKING').map((i) => i.message).join(' | ');
    throw new Error(`${checkpoint} of ${term} cannot be published, blocking problems: ${why}`);
  }
  return set;
}

/** Calculates then publishes one checkpoint. Returns the published set and the moment publishing was requested. */
export async function publish(term, checkpoint) {
  if (checkpoint === 'ENDTERM') await ensureCheckpointWeights(term);
  await calculate(term, checkpoint);
  const set = await resultSet(term, checkpoint);
  const publishedAt = Date.now();
  const published = (await as('john', PUBLISH_RESULTS, { input: { ...scope(term, checkpoint), _version: set._version } })).publishResults;
  return { set: published, publishedAt };
}

/**
 * The seed has Opener papers only for Term 1. An Opener with no papers cannot publish (and Mid-term
 * cannot publish before it), so for another term this adds ONE Kiswahili Opener paper at 100% with
 * a mark for every student, and only when the term's Opener has no papers at all.
 */
export async function ensureOpenerPapers(term) {
  const set = (await as('john', CALCULATE_TERM_RESULTS, { input: scope(term, 'OPENER') })).calculateTermResults;
  if (!set.issues.some((i) => i.code === 'NO_ASSESSMENTS')) return false;
  const students = (await as('jane', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: CLASS })).getClassRoster;
  const paper = (await as('jane', CREATE_ASSESSMENT, {
    input: {
      assessment_id: ulid(), school_id: SCHOOL, class_id: CLASS, term_id: term, subject: 'Kiswahili',
      title: 'Opener (test data)', assessment_type: 'Opener', paper_no: 1, weight: 100, max_score: 100,
    },
  })).createAssessment;
  await as('jane', SUBMIT_SCORES, {
    input: {
      school_id: SCHOOL, assessment_id: paper.assessment_id,
      entries: students.map((st, i) => ({ student_id: st.student_id, raw_score: 35 + ((i * 7) % 50), mark_status: 'SCORED' })),
    },
  });
  return true;
}

/** Publishes every not-yet-published checkpoint up to and including `upTo`. Returns { CHECKPOINT: publishedAt } for those it published. */
export async function publishThrough(term, upTo) {
  const done = {};
  for (const checkpoint of CHAIN.slice(0, CHAIN.indexOf(upTo) + 1)) {
    if ((await resultSet(term, checkpoint))?.status === 'PUBLISHED') continue;
    if (checkpoint === 'OPENER') await ensureOpenerPapers(term);
    done[checkpoint] = (await publish(term, checkpoint)).publishedAt;
  }
  return done;
}
