import { identityOf, assertTenant, assertClassAccess } from '../../library/authz.js';
import { validateEntry, MAX_BATCH } from '../../library/score.js';
import { resolveScoreConflict, RESOLUTION, CONFLICT_REVIEW } from '../../library/conflict.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import * as scores from '../../library/scoreRepo.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function handler(event) {
  const actor = identityOf(event);
  const args = event.arguments || {};

  switch (event.info.fieldName) {
    case 'submitScores':
      return submitScores(actor, args.input);
    case 'listScoresByAssessment':
      return listScores(actor, args);
    case 'syncScores':
      return syncScores(actor, args);
    case 'resolveScoreConflict':
      return resolveConflict(actor, args.input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const TERM_LOCKED = 'Results for this term are published, so marks can no longer be changed';
const RACED = 'This mark changed again while saving. It will be retried.';

async function loadOpenAssessment(actor, schoolId, assessmentId) {
  const assessment = await assessments.get(schoolId, assessmentId);
  if (!assessment || assessment._deleted) throw notFound('Assessment not found');
  assertClassAccess(actor, assessment.class_id, await platform.assignments(actor.schoolId, actor.sub));
  return assessment;
}

async function assertWritable(schoolId, assessment) {
  if (assessment.status === 'LOCKED') throw locked('This assessment is locked');
  if (await assessments.termLocked(schoolId, assessment.term_id)) throw locked(TERM_LOCKED);
}

/** The op that makes the server hold `value` (null = no mark), given what it holds now. */
function opFor(sid, before, check) {
  if (check.clear) return before ? { kind: 'clear', student_id: sid, before } : null;
  return { kind: before ? 'update' : 'create', student_id: sid, before, value: check.value, normalized: check.normalized };
}

async function submitScores(actor, input) {
  assertTenant(actor, input.school_id);

  const entries = input.entries || [];
  if (!entries.length) throw validation('No marks to save', 'entries');
  if (entries.length > MAX_BATCH) throw validation(`Send at most ${MAX_BATCH} marks at a time`, 'entries');
  const ids = entries.map((e) => e.student_id);
  if (new Set(ids).size !== ids.length) throw validation('Each student may appear only once', 'entries');

  const assessment = await loadOpenAssessment(actor, input.school_id, input.assessment_id);
  await assertWritable(input.school_id, assessment);

  const [roster, existing] = await Promise.all([
    platform.roster(input.school_id, assessment.class_id),
    scores.listByAssessment(input.school_id, assessment.assessment_id),
  ]);
  const rosterIds = new Set(roster.map((s) => s.student_id));
  const byStudent = new Map(existing.map((s) => [s.student_id, s]));

  const results = new Map();
  const ops = [];
  const done = (sid, outcome, item, reason = null) => results.set(sid, { student_id: sid, outcome, reason, item });

  for (const entry of entries) {
    const sid = entry.student_id;
    const check = validateEntry(entry, { assessment, roster: rosterIds });
    const before = byStudent.get(sid) || null;
    if (!check.ok) {
      done(sid, 'REJECTED', before, check.reason);
      continue;
    }

    const sent = entry._version ?? null;
    const local = check.clear ? null : check.value;
    const current = (before?._version ?? null) === sent && before?.status !== CONFLICT_REVIEW;

    if (current) {
      const op = opFor(sid, before, check);
      if (op && !(before && op.kind === 'update' && before.raw_score === local)) ops.push(op);
      else done(sid, 'APPLIED', before);
      continue;
    }

    const decision = resolveScoreConflict({ raw_score: local }, before, actor);
    if (decision.resolution === RESOLUTION.DISCARD) {
      done(sid, 'APPLIED', before, decision.reason);
    } else if (decision.resolution === RESOLUTION.HOLD) {
      done(sid, 'CONFLICT', before, decision.reason);
    } else if (decision.resolution === RESOLUTION.REVIEW) {
      ops.push({ kind: 'review', student_id: sid, before, proposed: local, reason: decision.reason });
    } else {
      const op = opFor(sid, before, check);
      if (op) ops.push({ ...op, reason: decision.reason, audit: before?.status === CONFLICT_REVIEW ? 'CONFLICT_RESOLVED' : undefined });
      else done(sid, 'APPLIED', before, decision.reason);
    }
  }

  if (ops.length) {
    const outcome = await scores.applyBatch(input.school_id, assessment, ops, actor);
    if (outcome.blocked === 'TERM') throw locked(TERM_LOCKED);
    if (outcome.blocked === 'ASSESSMENT') {
      const fresh = await assessments.get(input.school_id, assessment.assessment_id);
      if (!fresh || fresh._deleted) throw notFound('Assessment not found');
      throw locked('This assessment is locked');
    }
    for (const op of outcome.applied) {
      const item = op.kind === 'clear' ? null : op.item;
      done(op.student_id, op.kind === 'review' ? 'REVIEW' : 'APPLIED', item, op.reason ?? null);
    }
    for (const op of outcome.conflicted) {
      done(op.student_id, 'CONFLICT', await scores.get(input.school_id, assessment.assessment_id, op.student_id), RACED);
    }
  }

  const ordered = entries.map((e) => results.get(e.student_id));
  const count = (o) => ordered.filter((r) => r.outcome === o).length;
  return {
    accepted: count('APPLIED'),
    rejected: count('REJECTED'),
    review: count('REVIEW'),
    conflicted: count('CONFLICT'),
    results: ordered,
  };
}

async function resolveConflict(actor, input) {
  assertTenant(actor, input.school_id);
  const assessment = await loadOpenAssessment(actor, input.school_id, input.assessment_id);
  await assertWritable(input.school_id, assessment);

  const before = await scores.get(input.school_id, input.assessment_id, input.student_id);
  if (!before || before.status !== CONFLICT_REVIEW) throw conflict('This mark is not awaiting a decision');
  if (before._version !== input._version) throw conflict('This mark changed. Reload and decide again.');

  const roster = await platform.roster(input.school_id, assessment.class_id);
  const check = validateEntry(
    { student_id: input.student_id, raw_score: input.chosen_raw_score },
    { assessment, roster: new Set(roster.map((s) => s.student_id)) }
  );
  if (!check.ok) throw validation(check.reason, 'chosen_raw_score');

  const op = { ...opFor(input.student_id, before, check), audit: 'CONFLICT_RESOLVED' };
  const outcome = await scores.applyBatch(input.school_id, assessment, [op], actor);
  if (outcome.blocked === 'TERM') throw locked(TERM_LOCKED);
  if (outcome.blocked === 'ASSESSMENT') throw locked('This assessment is locked');
  if (outcome.conflicted.length) throw conflict('This mark changed. Reload and decide again.');
  return op.kind === 'clear' ? null : op.item;
}

async function listScores(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  await loadOpenAssessment(actor, school_id, assessment_id);
  return { items: await scores.listByAssessment(school_id, assessment_id), nextToken: null };
}

async function syncScores(actor, { school_id, class_id, lastSync, limit, nextToken }) {
  assertTenant(actor, school_id);
  assertClassAccess(actor, class_id, await platform.assignments(actor.schoolId, actor.sub));
  return scores.syncByClass(school_id, class_id, lastSync || 0, { limit: limit || 500, nextToken });
}