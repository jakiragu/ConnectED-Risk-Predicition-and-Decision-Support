import {
  identityOf,
  assertTenant,
  assertClassAccess,
  assertCanLock,
  assertAdmin,
  hasRole,
  ROLE,
} from '../../library/authz.js';
import {
  validateAssessment,
  deletionBlocker,
  recordingStatus,
  maxScoreFrozen,
  TOTAL_WEIGHT,
} from '../../library/assessment.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as scores from '../../library/scoreRepo.js';
import * as platform from '../../library/platformRepo.js';

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
    case 'unlockAssessment':
      return unlockAssessment(actor, args);
    case 'deleteAssessment':
      return deleteAssessment(actor, input);
    case 'softDeleteAssessment':
      return softDeleteAssessment(actor, input);
    case 'restoreAssessment':
      return restoreAssessment(actor, args);
    case 'getAssessment':
      return getAssessment(actor, args);
    case 'listAssessmentsByClass':
      return listAssessmentsByClass(actor, args);
    case 'listDeletedAssessments':
      return listDeletedAssessments(actor, args);
    case 'listMyClasses':
      return listMyClasses(actor, args);
    case 'getClassRoster':
      return getClassRoster(actor, args);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const STALE = 'Someone else changed this assessment. Reload and try again.';
const TERM_LOCKED = 'Results for this term are published, so assessments are locked';
const UNLOCK_TERM_LOCKED = 'Results for this term are published, so this assessment can no longer be unlocked';

const decorate = (a, rosterSize) => ({
  ...a,
  score_count: a.score_count || 0,
  status: recordingStatus(a, rosterSize),
});

async function decorateOne(a) {
  const roster = await platform.roster(a.school_id, a.class_id);
  return decorate(a, roster.length);
}

async function requireClassAccess(actor, classId) {
  assertClassAccess(actor, classId, await platform.assignments(actor.schoolId, actor.sub));
}

async function createAssessment(actor, input) {
  assertTenant(actor, input.school_id);
  await requireClassAccess(actor, input.class_id);
  if (await assessments.termLocked(input.school_id, input.term_id)) throw locked(TERM_LOCKED);

  const candidate = { ...input, assessment_id: input.assessment_id || ulid() };
  const { items: siblings } = await assessments.listByClass(input.school_id, input.class_id, input.term_id, { limit: 100 });
  const errors = validateAssessment(candidate, { siblings: siblings.filter((s) => s.subject === candidate.subject) });
  if (errors.length) throw validation(errors[0].message, errors[0].field);

  const { item, created } = await assessments.create(input.school_id, candidate, actor);
  if (!created && item && (item.class_id !== candidate.class_id || item._deleted)) {
    throw conflict('That assessment id is already in use');
  }
  return decorateOne(item);
}

async function updateAssessment(actor, input) {
  assertTenant(actor, input.school_id);

  const existing = await assessments.get(input.school_id, input.assessment_id);
  if (!existing || existing._deleted) throw notFound('Assessment not found');
  await requireClassAccess(actor, existing.class_id);
  if (existing.status === 'LOCKED') throw locked('This assessment is locked');
  if (await assessments.termLocked(input.school_id, existing.term_id)) throw locked(TERM_LOCKED);

  const { items: siblings } = await assessments.listByClass(input.school_id, existing.class_id, existing.term_id, { limit: 100 });
  const merged = { ...existing, ...stripEmpty(input) };
  const errors = validateAssessment(merged, {
    siblings: siblings.filter((s) => s.subject === merged.subject),
    original: existing,
    scoreCount: existing.score_count || 0,
  });
  if (errors.length) throw validation(errors[0].message, errors[0].field);

  const requireNoMarks = input.max_score != null && Number(input.max_score) !== existing.max_score;
  try {
    const updated = await assessments.update(
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
      actor,
      { requireNoMarks }
    );
    return decorateOne(updated);
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const fresh = await assessments.get(input.school_id, input.assessment_id);
    if (!fresh || fresh._deleted) throw notFound('Assessment not found');
    if (requireNoMarks && (fresh.score_count || 0) > 0) {
      throw validation(maxScoreFrozen(fresh.score_count, fresh.max_score), 'max_score');
    }
    throw conflict(STALE);
  }
}

async function lockAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  assertCanLock(actor);
  const existing = await assessments.get(school_id, assessment_id);
  if (!existing || existing._deleted) throw notFound('Assessment not found');
  if (existing.status === 'LOCKED') return decorateOne(existing);
  return decorateOne(await assessments.setStatus(school_id, assessment_id, 'LOCKED'));
}

async function unlockAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  assertAdmin(actor);

  const existing = await assessments.get(school_id, assessment_id);
  if (!existing || existing._deleted) throw notFound('Assessment not found');
  if (existing.status !== 'LOCKED') return decorateOne(existing);
  if (await assessments.termLocked(school_id, existing.term_id)) throw locked(UNLOCK_TERM_LOCKED);

  try {
    await assessments.unlock(school_id, existing, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (assessments.cancelledAt(e, 1)) throw locked(UNLOCK_TERM_LOCKED);
    // The assessment item failed: someone unlocked or deleted it in the meantime.
    const fresh = await assessments.get(school_id, assessment_id);
    if (!fresh || fresh._deleted) throw notFound('Assessment not found');
  }
  return decorateOne(await assessments.get(school_id, assessment_id));
}

async function deleteAssessment(actor, input) {
  assertTenant(actor, input.school_id);

  const existing = await assessments.get(input.school_id, input.assessment_id);
  if (!existing) return input.assessment_id;
  await requireClassAccess(actor, existing.class_id);
  if (existing._deleted) return input.assessment_id;

  const termIsLocked = await assessments.termLocked(input.school_id, existing.term_id);
  const blocker = deletionBlocker(existing, { termLocked: termIsLocked });
  if (blocker) throw locked(blocker);

  try {
    await assessments.hardDelete(input.school_id, input.assessment_id, input._version);
    return input.assessment_id;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const fresh = await assessments.get(input.school_id, input.assessment_id);
    if (!fresh) return input.assessment_id;
    const now = deletionBlocker(fresh);
    if (now) throw locked(now);
    throw conflict(STALE);
  }
}

async function softDeleteAssessment(actor, input) {
  assertTenant(actor, input.school_id);
  assertAdmin(actor);

  const existing = await assessments.get(input.school_id, input.assessment_id);
  if (!existing) throw notFound('Assessment not found');

  if (!existing._deleted) {
    if (existing.status === 'LOCKED') throw locked('This assessment is locked');
    try {
      await assessments.softDelete(input.school_id, existing, input._version, actor);
    } catch (e) {
      if (e.name !== 'TransactionCanceledException') throw e;
      if (assessments.cancelledAt(e, 1)) throw locked(TERM_LOCKED);
      const fresh = await assessments.get(input.school_id, input.assessment_id);
      if (!fresh) throw notFound('Assessment not found');
      if (fresh.status === 'LOCKED') throw locked('This assessment is locked');
      if (!fresh._deleted) throw conflict(STALE);
    }
  }

  await scores.setDeletedAll(input.school_id, input.assessment_id, true, actor);
  return input.assessment_id;
}

async function restoreAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  assertAdmin(actor);

  const existing = await assessments.get(school_id, assessment_id);
  if (!existing) throw notFound('Assessment not found');
  if (!existing._deleted) return decorateOne(existing);
  if (await assessments.termLocked(school_id, existing.term_id)) throw locked(TERM_LOCKED);

  const { items: siblings } = await assessments.listByClass(school_id, existing.class_id, existing.term_id, { limit: 100 });
  const used = siblings
    .filter((s) => s.subject === existing.subject && s.assessment_id !== assessment_id)
    .reduce((total, s) => total + s.weight, 0);
  if (used + existing.weight > TOTAL_WEIGHT) {
    throw validation(
      `Restoring needs ${existing.weight}% of ${existing.subject}, but only ${TOTAL_WEIGHT - used}% is unassigned. ` +
        'Reduce another assessment first.',
      'weight'
    );
  }

  await scores.setDeletedAll(school_id, assessment_id, false, actor);
  try {
    await assessments.restore(school_id, existing, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (assessments.cancelledAt(e, 1)) throw locked(TERM_LOCKED);
    const fresh = await assessments.get(school_id, assessment_id);
    if (!fresh || fresh._deleted) throw conflict(STALE);
    return decorateOne(fresh);
  }
  return decorateOne(await assessments.get(school_id, assessment_id));
}

async function getAssessment(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  const item = await assessments.get(school_id, assessment_id);
  if (!item || item._deleted) return null;
  await requireClassAccess(actor, item.class_id);
  return decorateOne(item);
}

async function listAssessmentsByClass(actor, { school_id, class_id, term_id, limit, nextToken }) {
  assertTenant(actor, school_id);
  await requireClassAccess(actor, class_id);
  const [page, roster] = await Promise.all([
    assessments.listByClass(school_id, class_id, term_id, { limit, nextToken }),
    platform.roster(school_id, class_id),
  ]);
  return { ...page, items: page.items.map((a) => decorate(a, roster.length)) };
}

async function listDeletedAssessments(actor, { school_id, class_id, term_id }) {
  assertTenant(actor, school_id);
  assertAdmin(actor);
  const [items, roster] = await Promise.all([
    assessments.listDeletedByClass(school_id, class_id, term_id),
    platform.roster(school_id, class_id),
  ]);
  return items.map((a) => decorate(a, roster.length));
}

async function listMyClasses(actor, { school_id }) {
  assertTenant(actor, school_id);
  const all = await platform.listClasses(school_id);
  if (hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER)) return all;
  const ids = await platform.assignments(actor.schoolId, actor.sub);
  return all.filter((c) => ids.includes(c.class_id));
}

async function getClassRoster(actor, { school_id, class_id }) {
  assertTenant(actor, school_id);
  await requireClassAccess(actor, class_id);
  return platform.roster(school_id, class_id);
}

const stripEmpty = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));