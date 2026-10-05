import { identityOf, assertTenant, assertClassAccess } from '../../library/authz.js';
import { validateEntry, MAX_BATCH } from '../../library/score.js';
import { validation, notFound, locked } from '../../library/errors.js';
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
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const TERM_LOCKED = 'Results for this term are published, so marks can no longer be changed';
const CHANGED = 'Someone else changed this mark while you were editing. It now shows their value.';

async function loadOpenAssessment(actor, schoolId, assessmentId) {
  const assessment = await assessments.get(schoolId, assessmentId);
  if (!assessment || assessment._deleted) throw notFound('Assessment not found');
  assertClassAccess(actor, assessment.class_id, await platform.assignments(actor.schoolId, actor.sub));
  return assessment;
}

async function submitScores(actor, input) {
  assertTenant(actor, input.school_id);

  const entries = input.entries || [];
  if (!entries.length) throw validation('No marks to save', 'entries');
  if (entries.length > MAX_BATCH) throw validation(`Send at most ${MAX_BATCH} marks at a time`, 'entries');
  const ids = entries.map((e) => e.student_id);
  if (new Set(ids).size !== ids.length) throw validation('Each student may appear only once', 'entries');

  const assessment = await loadOpenAssessment(actor, input.school_id, input.assessment_id);
  if (assessment.status === 'LOCKED') throw locked('This assessment is locked');
  if (await assessments.termLocked(input.school_id, assessment.term_id)) throw locked(TERM_LOCKED);

  const [roster, existing] = await Promise.all([
    platform.roster(input.school_id, assessment.class_id),
    scores.listByAssessment(input.school_id, assessment.assessment_id),
  ]);
  const rosterIds = new Set(roster.map((s) => s.student_id));
  const byStudent = new Map(existing.map((s) => [s.student_id, s]));

  const results = new Map();
  const ops = [];

  for (const entry of entries) {
    const sid = entry.student_id;
    const check = validateEntry(entry, { assessment, roster: rosterIds });
    if (!check.ok) {
      results.set(sid, { student_id: sid, outcome: 'REJECTED', reason: check.reason, item: byStudent.get(sid) || null });
      continue;
    }

    const before = byStudent.get(sid) || null;
    const sent = entry._version ?? null;

    if (check.clear) {
      if (!before) {
        results.set(sid, { student_id: sid, outcome: 'APPLIED', item: null });
      } else if (sent !== before._version) {
        results.set(sid, { student_id: sid, outcome: 'CONFLICT', reason: CHANGED, item: before });
      } else {
        ops.push({ kind: 'clear', student_id: sid, before });
      }
      continue;
    }

    if (before && before.raw_score === check.value) {
      results.set(sid, { student_id: sid, outcome: 'APPLIED', item: before });
      continue;
    }
    if ((before?._version ?? null) !== sent) {
      results.set(sid, { student_id: sid, outcome: 'CONFLICT', reason: CHANGED, item: before });
      continue;
    }
    ops.push({
      kind: before ? 'update' : 'create',
      student_id: sid,
      before,
      value: check.value,
      normalized: check.normalized,
    });
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
      results.set(op.student_id, { student_id: op.student_id, outcome: 'APPLIED', item: op.kind === 'clear' ? null : op.item });
    }
    for (const op of outcome.conflicted) {
      const server = await scores.get(input.school_id, assessment.assessment_id, op.student_id);
      results.set(op.student_id, { student_id: op.student_id, outcome: 'CONFLICT', reason: CHANGED, item: server });
    }
  }

  const ordered = entries.map((e) => results.get(e.student_id));
  return {
    accepted: ordered.filter((r) => r.outcome === 'APPLIED').length,
    rejected: ordered.filter((r) => r.outcome === 'REJECTED').length,
    conflicted: ordered.filter((r) => r.outcome === 'CONFLICT').length,
    results: ordered,
  };
}

async function listScores(actor, { school_id, assessment_id }) {
  assertTenant(actor, school_id);
  await loadOpenAssessment(actor, school_id, assessment_id);
  return { items: await scores.listByAssessment(school_id, assessment_id), nextToken: null };
}