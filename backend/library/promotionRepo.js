import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';
import { INTERVENTION_STATUS } from './decisionSupport.js';
import { ACTION, STUDENT_STATUS } from './promotion.js';
import * as interventions from './interventionRepo.js';

/**
 * Storage for year-end promotion.
 *
 *   PROMOTIONLOCK#<fromYear>            one per school year: run_id, status (APPLYING | APPLIED | REVERTED)
 *   PROMOTION#<runId>                   the run: what was decided, what was created, teacher changes, outcome
 *   PROMOTIONMOVE#<runId>#<studentId>   one per student: action, from class, to class
 *
 * The run and its moves are written BEFORE anything changes, so a run that is
 * interrupted is finished from what was stored, never re-planned from a half-moved
 * school. Every change below is a single conditional update that is safe to repeat:
 * when its condition fails, the item is read back and counted as done if it is
 * already in the state this run wanted, or as skipped (with why) if someone else
 * changed it.
 */
const nowIso = () => new Date().toISOString();
const isCondition = (e) => e?.name === 'ConditionalCheckFailedException';

async function queryAll(params) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const get = async (schoolId, SK) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK }, ConsistentRead: true }))).Item || null;

const prefix = (schoolId, p) => queryAll({
  TableName: TABLE,
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  ExpressionAttributeValues: { ':p': pk(schoolId), ':s': p },
});

async function batchPut(items) {
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the promotion records');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- lock and run

export const RUN_STATUS = { APPLYING: 'APPLYING', APPLIED: 'APPLIED', REVERTED: 'REVERTED' };

export const getLock = (schoolId, fromYear) => get(schoolId, sk.promotionLock(fromYear));
export const listLocks = (schoolId) => prefix(schoolId, sk.promotionLockPrefix());

/** @returns {Promise<boolean>} false: the year is already promoted or being promoted */
export async function claimLock(schoolId, fromYear, run) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(schoolId), SK: sk.promotionLock(fromYear), entity: 'PromotionLock', school_id: schoolId,
        from_year: fromYear, run_id: run.run_id, status: RUN_STATUS.APPLYING, idempotency_key: run.idempotency_key,
        created_at: nowIso(), created_by: run.created_by,
      },
      ConditionExpression: 'attribute_not_exists(PK) OR #st = :reverted',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':reverted': RUN_STATUS.REVERTED },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

export const setLockStatus = (schoolId, fromYear, runId, status) => ddb.send(new UpdateCommand({
  TableName: TABLE,
  Key: { PK: pk(schoolId), SK: sk.promotionLock(fromYear) },
  UpdateExpression: 'SET #st = :s, updated_at = :ts',
  ConditionExpression: 'run_id = :r',
  ExpressionAttributeNames: { '#st': 'status' },
  ExpressionAttributeValues: { ':s': status, ':ts': nowIso(), ':r': runId },
}));

export const getRun = (schoolId, runId) => get(schoolId, sk.promotionRun(runId));
export const listRuns = async (schoolId) =>
  (await prefix(schoolId, sk.promotionRunPrefix())).filter((r) => !r.pending_claim).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

/** The run and its moves, written before anything is changed. Idempotent. */
export async function saveRun(schoolId, run, moves) {
  // Publish the run only after its complete decision snapshot is durable.
  await batchPut(moves.map((m) => ({
    PK: pk(schoolId), SK: sk.promotionMove(run.run_id, m.student_id), entity: 'PromotionMove', school_id: schoolId,
    run_id: run.run_id, ...m,
  })));
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: pk(schoolId), SK: sk.promotionRun(run.run_id), entity: 'PromotionRun', school_id: schoolId, ...run },
    ConditionExpression: 'attribute_not_exists(PK)',
  })).catch((e) => { if (!isCondition(e)) throw e; });
}

export const listMoves = (schoolId, runId) => prefix(schoolId, sk.promotionMovePrefix(runId));

export async function updateRun(schoolId, runId, patch) {
  const names = {};
  const values = { ':ts': nowIso() };
  const sets = ['updated_at = :ts'];
  for (const [k, v] of Object.entries(patch)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.promotionRun(runId) },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes;
}

// ------------------------------------------------------------------- classes

/** A destination class this run creates. Retrying finds the class already there. */
export async function createClassForRun(schoolId, klass, runId, actor) {
  const ts = nowIso();
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(schoolId), SK: sk.klass(klass.class_id), entity: 'Class', school_id: schoolId,
        class_id: klass.class_id, name: klass.name, grade: klass.grade, stream: klass.stream, year: klass.year,
        status: 'CURRENT', promoted_from_class_id: klass.promoted_from_class_id ?? null,
        ...(klass.class_teacher_id ? { class_teacher_id: klass.class_teacher_id, class_teacher_set_by_promotion: runId } : {}),
        created_by_promotion: runId, created_at: ts, created_by: actor.sub, updated_at: ts, _version: 1,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return 'DONE';
  } catch (e) {
    if (!isCondition(e)) throw e;
    const existing = await get(schoolId, sk.klass(klass.class_id));
    return existing?.created_by_promotion === runId ? 'ALREADY' : 'SKIPPED';
  }
}

/** An existing destination class gets the class teacher that follows their class, only if it has none. */
export async function setClassTeacherForRun(schoolId, classId, teacherId, runId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(classId) },
      UpdateExpression: 'SET class_teacher_id = :t, class_teacher_set_by_promotion = :r, updated_at = :ts, #v = #v + :one',
      ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(class_teacher_id) OR class_teacher_id = :null OR class_teacher_id = :t)',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: { ':t': teacherId, ':r': runId, ':ts': nowIso(), ':one': 1, ':null': null },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

export async function clearClassTeacherForRun(schoolId, classId, runId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(classId) },
      UpdateExpression: 'SET updated_at = :ts, #v = #v + :one REMOVE class_teacher_id, class_teacher_set_by_promotion',
      ConditionExpression: 'class_teacher_set_by_promotion = :r',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: { ':r': runId, ':ts': nowIso(), ':one': 1 },
    }));
  } catch (e) {
    if (!isCondition(e)) throw e;
  }
}

/** Archive: the class keeps who its class teacher was, so the archive still shows it. */
export async function archiveClassForRun(schoolId, source, runId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(source.class_id) },
      UpdateExpression:
        'SET #st = :past, archived_at = :ts, archived_by_promotion = :r, promoted_to_class_id = :to, ' +
        'former_class_teacher_id = :ct, updated_at = :ts, #v = #v + :one REMOVE class_teacher_id',
      ConditionExpression: 'attribute_exists(PK) AND #st = :current',
      ExpressionAttributeNames: { '#st': 'status', '#v': '_version' },
      ExpressionAttributeValues: {
        ':past': 'PAST', ':current': 'CURRENT', ':ts': nowIso(), ':r': runId,
        ':to': source.promoted_to_class_id ?? null, ':ct': source.class_teacher_id ?? null, ':one': 1,
      },
    }));
    return 'DONE';
  } catch (e) {
    if (!isCondition(e)) throw e;
    const now = await get(schoolId, sk.klass(source.class_id));
    return now?.archived_by_promotion === runId ? 'ALREADY' : 'SKIPPED';
  }
}

export async function restoreClassForRun(schoolId, source, runId) {
  const teacher = source.class_teacher_id ?? null;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(source.class_id) },
      UpdateExpression:
        `SET #st = :current, updated_at = :ts, #v = #v + :one${teacher ? ', class_teacher_id = :ct' : ''} ` +
        'REMOVE archived_at, archived_by_promotion, promoted_to_class_id, former_class_teacher_id',
      ConditionExpression: 'archived_by_promotion = :r',
      ExpressionAttributeNames: { '#st': 'status', '#v': '_version' },
      ExpressionAttributeValues: { ':current': 'CURRENT', ':ts': nowIso(), ':r': runId, ':one': 1, ...(teacher ? { ':ct': teacher } : {}) },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

/** Only a class this run created; the caller has checked it is empty. */
export async function deleteClassForRun(schoolId, classId, runId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(classId) },
      ConditionExpression: 'created_by_promotion = :r',
      ExpressionAttributeValues: { ':r': runId },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

// ------------------------------------------------------------------ students

const SKIP_REASON = 'Changed by someone else after the plan was made (moved, deactivated or edited)';

/** @returns {Promise<{outcome:'DONE'|'ALREADY'|'SKIPPED', reason?:string}>} */
export async function applyMove(schoolId, move, run, actor) {
  const names = { '#v': '_version', '#st': 'status' };
  const values = {
    ':from': move.from_class_id, ':active': STUDENT_STATUS.ACTIVE, ':r': run.run_id, ':ts': nowIso(), ':by': actor.sub, ':one': 1,
  };
  if (move.student_version != null) values[':expected'] = move.student_version;
  let set;
  if (move.action === ACTION.PROMOTE || move.action === ACTION.REPEAT) {
    set = 'class_id = :to, promoted_from_class_id = :from';
    values[':to'] = move.to_class_id;
  } else if (move.action === ACTION.GRADUATE) {
    set = '#st = :s, graduation_year = :y';
    values[':s'] = STUDENT_STATUS.GRADUATED;
    values[':y'] = run.from_year;
  } else {
    set = '#st = :s, left_year = :y, departure_kind = :kind, deactivation_reason = :reason, deactivation_date = :date';
    values[':kind'] = 'LEFT';
    values[':reason'] = move.override_reason || 'Left at academic year rollover';
    values[':date'] = run.created_at.slice(0, 10);
    values[':s'] = STUDENT_STATUS.INACTIVE;
    values[':y'] = run.from_year;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.student(move.student_id) },
      UpdateExpression: `SET ${set}, promotion_run_id = :r, updated_at = :ts, updated_by = :by, #v = #v + :one`,
      ConditionExpression: 'attribute_exists(PK) AND class_id = :from AND (attribute_not_exists(#st) OR #st = :active)' + (move.student_version != null ? ' AND #v = :expected' : ''),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { outcome: 'DONE' };
  } catch (e) {
    if (!isCondition(e)) throw e;
    const s = await get(schoolId, sk.student(move.student_id));
    return s?.promotion_run_id === run.run_id ? { outcome: 'ALREADY' } : { outcome: 'SKIPPED', reason: s ? SKIP_REASON : 'The student record no longer exists' };
  }
}

export async function revertMove(schoolId, move, run, actor) {
  const values = { ':r': run.run_id, ':ts': nowIso(), ':by': actor.sub, ':one': 1 };
  const names = { '#v': '_version' }; // '#st' only where the expression uses it: DynamoDB rejects unused names
  let set;
  let remove;
  let condition;
  if (move.action === ACTION.PROMOTE || move.action === ACTION.REPEAT) {
    set = 'class_id = :from';
    remove = 'promotion_run_id, promoted_from_class_id';
    condition = 'promotion_run_id = :r AND class_id = :to';
    values[':from'] = move.from_class_id;
    values[':to'] = move.to_class_id;
  } else {
    names['#st'] = 'status';
    set = '#st = :active';
    remove = move.action === ACTION.GRADUATE ? 'promotion_run_id, graduation_year' : 'promotion_run_id, left_year, departure_kind, deactivation_reason, deactivation_date';
    condition = 'promotion_run_id = :r AND #st = :was';
    values[':active'] = STUDENT_STATUS.ACTIVE;
    values[':was'] = move.action === ACTION.GRADUATE ? STUDENT_STATUS.GRADUATED : STUDENT_STATUS.INACTIVE;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.student(move.student_id) },
      UpdateExpression: `SET ${set}, updated_at = :ts, updated_by = :by, #v = #v + :one REMOVE ${remove}`,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { outcome: 'DONE' };
  } catch (e) {
    if (!isCondition(e)) throw e;
    const s = await get(schoolId, sk.student(move.student_id));
    const reverted = s && s.promotion_run_id !== run.run_id && s.class_id === move.from_class_id
      && (s.status || STUDENT_STATUS.ACTIVE) === STUDENT_STATUS.ACTIVE;
    return reverted ? { outcome: 'ALREADY' } : { outcome: 'SKIPPED', reason: 'Changed after the promotion, so it was left as it is' };
  }
}

/** Every student of the school, any status; for planning and the past-students list. */
export const listAllStudents = (schoolId) => prefix(schoolId, sk.studentPrefix());

// ------------------------------------------------------------- interventions

/**
 * Ongoing interventions of students leaving a class at year end are stopped:
 * their targets belong to this year's prediction points, and comparing risk
 * across the year boundary would compare two unrelated sets of features.
 */
export async function stopInterventionsForRun(schoolId, classId, studentIds, runId, actor, today) {
  const ongoing = (await interventions.listForClass(schoolId, classId))
    .filter((i) => i.status === INTERVENTION_STATUS.ONGOING && studentIds.has(i.student_id));
  let stopped = 0;
  for (const i of ongoing) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: i.PK, SK: i.SK },
        UpdateExpression:
          'SET #st = :stopped, stopped_on = :today, stopped_by_promotion = :r, updated_at = :ts, updated_by = :by, #v = #v + :one',
        ConditionExpression: '#st = :ongoing',
        ExpressionAttributeNames: { '#st': 'status', '#v': '_version' },
        ExpressionAttributeValues: {
          ':stopped': INTERVENTION_STATUS.STOPPED, ':ongoing': INTERVENTION_STATUS.ONGOING, ':today': today,
          ':r': runId, ':ts': nowIso(), ':by': actor.sub, ':one': 1,
        },
      }));
      stopped++;
    } catch (e) {
      if (!isCondition(e)) throw e;
    }
  }
  return stopped;
}

export async function restartInterventionsForRun(schoolId, classId, runId, actor) {
  const mine = (await interventions.listForClass(schoolId, classId)).filter((i) => i.stopped_by_promotion === runId);
  for (const i of mine) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: i.PK, SK: i.SK },
        UpdateExpression: 'SET #st = :ongoing, stopped_on = :null, updated_at = :ts, updated_by = :by, #v = #v + :one REMOVE stopped_by_promotion',
        ConditionExpression: 'stopped_by_promotion = :r',
        ExpressionAttributeNames: { '#st': 'status', '#v': '_version' },
        ExpressionAttributeValues: { ':ongoing': INTERVENTION_STATUS.ONGOING, ':null': null, ':r': runId, ':ts': nowIso(), ':by': actor.sub, ':one': 1 },
      }));
    } catch (e) {
      if (!isCondition(e)) throw e;
    }
  }
  return mine.length;
}

// ------------------------------------------------------------------ teachers

/** Applied only if the teacher is unchanged since the plan, or this run already changed them. */
export async function applyTeacherChange(schoolId, change, runId) {
  const current = await get(schoolId, sk.teacher(change.teacher_id));
  if (current?.last_promotion_run_id === runId) return current._version === change.before._version + 1;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.teacher(change.teacher_id) },
      UpdateExpression: 'SET assignments = :a, historical_class_teacher_of = :h, class_teacher_of = :c, last_promotion_run_id = :r, updated_at = :ts, #v = #v + :one',
      ConditionExpression: 'attribute_exists(PK) AND #v = :snap',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: {
        ':h': change.after.historical_class_teacher_of || [], ':a': change.after.assignments, ':c': change.after.class_teacher_of, ':r': runId, ':ts': nowIso(), ':one': 1, ':snap': change.before._version,
      },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

export async function revertTeacherChange(schoolId, change, runId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.teacher(change.teacher_id) },
      UpdateExpression: 'SET assignments = :a, historical_class_teacher_of = :h, class_teacher_of = :c, updated_at = :ts, #v = #v + :one REMOVE last_promotion_run_id',
      ConditionExpression: 'last_promotion_run_id = :r AND #v = :expected',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: { ':expected': change.before._version + 1, ':h': change.before.historical_class_teacher_of || [], ':a': change.before.assignments, ':c': change.before.class_teacher_of, ':r': runId, ':ts': nowIso(), ':one': 1 },
    }));
    return true;
  } catch (e) {
    if (isCondition(e)) return false;
    throw e;
  }
}

/** Publication-gated promotion reads. Unpublished classes return counts only,
 * never student attributes, including across paginated DynamoDB responses. */
export async function promotionStudentCounts(schoolId, classId) {
  const count = async (active) => {
    let total = 0, ExclusiveStartKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE, ConsistentRead: true, Select: 'COUNT',
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        FilterExpression: 'class_id = :c AND ' + (active ? '(attribute_not_exists(#st) OR #st = :active)' : '(attribute_exists(#st) AND #st <> :active)'),
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.studentPrefix(), ':c': classId, ':active': 'ACTIVE' },
        ExclusiveStartKey,
      }));
      total += res.Count || 0;
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  };
  const [active, inactive] = await Promise.all([count(true), count(false)]);
  return { active, inactive };
}
export const promotionStudents = (schoolId, classId) => queryAll({
  TableName: TABLE, ConsistentRead: true,
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  FilterExpression: 'class_id = :c',
  ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.studentPrefix(), ':c': classId },
});
