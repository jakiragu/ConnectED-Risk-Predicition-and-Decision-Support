import { assertTenant, assertAdmin, assertGradebookRole } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { attendancePeriods, PERIOD_LABEL, termStatus, todayIn, validateTerm } from '../../library/calendar.js';
import { validation, notFound, conflict } from '../../library/errors.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../library/client.js';
import { TABLE, pk, sk } from '../../library/keys.js';
import * as attendance from '../../library/attendanceRepo.js';
import * as calendar from '../../library/calendarRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id);

  switch (event.info.fieldName) {
    case 'listTerms':
      return listTerms(actor, args);
    case 'createTerm':
      return createTerm(actor, input);
    case 'updateTerm':
      return updateTerm(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const STALE = 'Someone else changed this term. Reload and try again.';
const zone = () => process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

export function termView(t, today = todayIn(zone())) {
  const periods = attendancePeriods(t).map((p) => ({ ...p, label: PERIOD_LABEL[p.period] }));
  return {
    term_id: t.term_id,
    school_id: t.school_id,
    name: t.name,
    academic_year: t.academic_year ?? null,
    term_number: t.term_number ?? null,
    start_date: t.start_date ?? null,
    mid_term_date: t.mid_term_date ?? null,
    end_date: t.end_date ?? null,
    closures: t.closures || [],
    status: termStatus(t, today),
    periods,
    school_days: periods.reduce((n, p) => n + p.school_days, 0),
    _version: t._version ?? 0,
  };
}

function readClosures(list) {
  return (list || []).map((c) => ({
    from: c.from,
    to: c.to || c.from,
    label: typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 60) : null,
  })).sort((a, b) => String(a.from).localeCompare(String(b.from)));
}

const firstError = (errors) => {
  if (errors.length) throw validation(errors[0].message, errors[0].field);
};

async function listTerms(actor, { school_id }) {
  assertGradebookRole(actor);
  return (await platform.listTerms(school_id)).map((t) => termView(t));
}

/** A new term gets a grading rule copied from the latest one, so results can be calculated in it. */
async function ensureGradeRule(schoolId, termId, actor) {
  if (await platform.gradeRule(schoolId, termId)) return;
  const terms = await platform.listTerms(schoolId);
  let template = null;
  for (const t of [...terms].reverse()) {
    if (t.term_id === termId) continue;
    template = await platform.gradeRule(schoolId, t.term_id);
    if (template) break;
  }
  const ts = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(schoolId),
        SK: sk.gradeRule(termId),
        entity: 'GradeRule',
        grade_rule_id: `gr_${termId}`,
        school_id: schoolId,
        term_id: termId,
        pass_mark: template?.pass_mark ?? 50,
        at_risk_threshold: template?.at_risk_threshold ?? 50,
        missing_score_policy: template?.missing_score_policy ?? 'EXCLUDE',
        bands: template?.bands ?? [],
        checkpoint_weights_version: 0,
        updated_at: ts,
        updated_by: actor.sub,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
  }
}

async function createTerm(actor, input) {
  assertAdmin(actor);
  const year = Number(input.academic_year);
  const number = Number(input.term_number);
  const candidate = {
    term_id: `term_${year}_${number}`,
    name: (typeof input.name === 'string' && input.name.trim()) || `Term ${number}, ${year}`,
    academic_year: year,
    term_number: number,
    start_date: input.start_date,
    mid_term_date: input.mid_term_date,
    end_date: input.end_date,
    closures: readClosures(input.closures),
  };
  const siblings = await platform.listTerms(input.school_id);
  firstError(validateTerm(candidate, siblings));
  const { item, created } = await calendar.createTerm(input.school_id, { ...candidate, status: termStatus(candidate, todayIn(zone())) }, actor);
  if (!created && (item.start_date !== candidate.start_date || item.end_date !== candidate.end_date)) {
    throw validation(`${item.name} already exists`, 'term_number');
  }
  await ensureGradeRule(input.school_id, item.term_id, actor);
  return termView(item);
}

async function updateTerm(actor, input) {
  assertAdmin(actor);
  const existing = await calendar.getTerm(input.school_id, input.term_id);
  if (!existing) throw notFound('Term not found');
  const merged = {
    ...existing,
    name: (typeof input.name === 'string' && input.name.trim()) || existing.name,
    start_date: input.start_date ?? existing.start_date,
    mid_term_date: input.mid_term_date ?? existing.mid_term_date,
    end_date: input.end_date ?? existing.end_date,
    closures: input.closures ? readClosures(input.closures) : existing.closures || [],
  };
  firstError(validateTerm(merged, await platform.listTerms(input.school_id)));

  for (const p of attendancePeriods(merged)) {
    const entries = await attendance.listPeriod(input.school_id, merged.term_id, p.period);
    const over = entries.filter((e) => e.days_attended + e.days_excused > p.school_days);
    if (over.length) {
      throw validation(
        `${over.length} attendance entr${over.length === 1 ? 'y has' : 'ies have'} more days than the ` +
          `${p.school_days} school days the "${PERIOD_LABEL[p.period].toLowerCase()}" period would have. Correct them first.`,
        'start_date'
      );
    }
  }

  try {
    const updated = await calendar.updateTerm(input.school_id, input.term_id, {
      name: merged.name,
      start_date: merged.start_date,
      mid_term_date: merged.mid_term_date,
      end_date: merged.end_date,
      closures: merged.closures,
      status: termStatus(merged, todayIn(zone())),
    }, input._version ?? 0, actor);
    return termView(updated);
  } catch (e) {
    if (e.name === calendar.STALE) throw conflict(STALE);
    throw e;
  }
}