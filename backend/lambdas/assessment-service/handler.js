import {
  identityOf,
  assertTenant,
  assertClassAccess,
  assertCanLock,
  hasRole,
  ROLE,
} from '../../library/authz.js';
import { validateAssessment, deletionBlocker } from '../../library/assessment.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import * as assessments from '../../library/assessmentRepo,js';
import * as platform from '../../library/platformRepo.js';
import * as scores from '../../library/scoreRepo.js';

export async function handler(event) {
  const actor = identityOf(event);
  const args = event.arguments || {};
  const input = args.input || args;

  switch (event.info.fieldName) {
    case 'createAssessment':
      return createAssessment(actor, input);
    case 'updateAssessment':
      return updateAssessment(actor, input);
    case 'lockAssessment':
      return lockAssessment(actor, args);
    case 'deleteAssessment':
      return deleteAssessment(actor, input);
    case 'getAssessment':
      return getAssessment(actor, args);
    case 'listAssessmentsByClass':
      return listAssessmentsByClass(actor, args);
    case 'listMyClasses':
      return listMyClasses(actor, args);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

async function createAssessment(actor, input) {
  assertTenant(actor, input.school_id);
  assertClassAccess(actor, input.class_id, await platform.assignments(actor.schoolId, actor.sub));

  if (await assessments.termLocked(input.school_id, input.term_id)) {
    throw locked('Results for this term are published, so assessments are locked');
  }

  const candidate = { ...input, assessment_id: input.assessment_id || ulid() };

  const { items: siblings } = await assessments.listByClass(
    input.school_id,
    input.class_id,
    input.term_id,
    { limit: 100 }
  );
  const errors = validateAssessment(candidate, {
    siblings: siblings.filter((s) => s.subject === candidate.subject),
  });
  if (errors.length) throw validation(errors[0].message, errors[0].field);

  const { item, created } = await assessments.create(input.school_id, candidate, actor);

  if (!created && item && item.class_id !== candidate.class_id) {
    throw conflict('That assessment id is already in use');
  }
  return item;
}

async function updateAssessment(actor, input) {
  assertTenant(actor, input.school_id);

  const existing = await assessments.get(input.school_id, input.assessment_id);
  if (!existing) throw notFound('Assessment not found');
  assertClassAccess(actor, existing.class_id, await platform.assignments(actor.schoolId, actor.sub));
  if (existing.status === 'LOCKED') throw locked('This assessment is locked');
  if (await assessments.termLocked(input.school_id, existing.term_id)) {
    throw locked('Results for this term are published, so assessments are locked');
  }

  const { items: siblings } = await assessments.listByClass(
    input.school_id,
    existing.class_id,
    existing.term_id,
    { limit: 100 }
  );
  const merged = { ...existing, ...stripEmpty(input) };
  const errors = validateAssessment(merged, {
    siblings: siblings.filter((s) => s.subject === merged.subject),
  });
  if (errors.length) throw validation(errors[0].message, errors[0].field);

  try {
    return await assessments.update(
      input.school_id,
      input.assessment_id,
      {
        title: input.title,
        assessment_type: input.assessment_type,
        weight: input.weight,
        max_score: input.max_score,
        due_date: input.due_date,
      },
      input._version,
      actor
    );
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw conflict('Someone else changed this assessment. Reopen it and try again.');
    }
    throw e;
  }
}

async function lockAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  assertCanLock(actor);
  const existing = await assessments.get(school_id, assessment_id);
  if (!existing) throw notFound('Assessment not found');
  if (existing.status === 'LOCKED') return existing;
  return assessments.setStatus(school_id, assessment_id, 'LOCKED');
}

async function deleteAssessment(actor, input) {
  assertTenant(actor, input.school_id);

  const existing = await assessments.get(input.school_id, input.assessment_id);
  if (!existing) return input.assessment_id;
  assertClassAccess(actor, existing.class_id, await platform.assignments(actor.schoolId, actor.sub));
  if (existing._deleted) return input.assessment_id;

  const [scoreCount, termIsLocked] = await Promise.all([
    scores.countByAssessment(input.school_id, input.assessment_id),
    assessments.termLocked(input.school_id, existing.term_id),
  ]);
  const blocker = deletionBlocker(existing, { scoreCount, termLocked: termIsLocked });
  if (blocker) throw locked(blocker);

  try {
    await assessments.hardDelete(input.school_id, input.assessment_id, input._version);
    return input.assessment_id;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    if (!(await assessments.get(input.school_id, input.assessment_id))) return input.assessment_id;
    throw conflict('Someone else changed this assessment. Reload and try again.');
  }
}

async function getAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  const item = await assessments.get(school_id, assessment_id);
  if (!item) return null;
  assertClassAccess(actor, item.class_id, await platform.assignments(actor.schoolId, actor.sub));
  return item;
}

async function listAssessmentsByClass(actor, { school_id, class_id, term_id, limit, nextToken }) {
  assertTenant(actor, school_id);
  assertClassAccess(actor, class_id, await platform.assignments(actor.schoolId, actor.sub));
  return assessments.listByClass(school_id, class_id, term_id, { limit, nextToken });
}

async function listMyClasses(actor, { school_id }) {
  assertTenant(actor, school_id);
  const all = await platform.listClasses(school_id);
  if (hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER)) return all;
  const ids = await platform.assignments(actor.schoolId, actor.sub);
  return all.filter((c) => ids.includes(c.class_id));
}

const stripEmpty = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));