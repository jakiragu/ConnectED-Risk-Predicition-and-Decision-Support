import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { conflict } from './errors.js';
import { TABLE, gsi1, pk, sk } from './keys.js';

/**
 * Interventions and the methods remembered from them.
 *
 *   PK SCHOOL#<school>  SK INTERVENTION#<student>#<id>     one intervention
 *      GSI1PK SCHOOL#<school>#CLASS#<class>  GSI1SK INTERVENTION#<id>   (a class's interventions)
 *   PK SCHOOL#<school>  SK INTVMETHOD#<factor>#<key>       a method teachers used for a factor
 *
 * The intervention id is made by the client, so a create that is retried after
 * a lost response (or sent again from the offline queue) finds its own item
 * rather than making a second one. Every change is checked against _version.
 * Deleting keeps the item, marked deleted, for the record; it disappears from
 * every view.
 */
const nowIso = () => new Date().toISOString();
const STALE = 'Someone else changed this intervention. Reload it and try again.';
const isConditionFailure = (e) => e.name === 'ConditionalCheckFailedException';

export async function get(schoolId, studentId, interventionId) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.intervention(studentId, interventionId) }, ConsistentRead: true,
  }));
  return Item || null;
}

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

/** A student's interventions, deleted ones left out. */
export const listForStudent = async (schoolId, studentId) =>
  (await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.interventionStudentPrefix(studentId) },
  })).filter((i) => !i.deleted_at);

/** Interventions logged in a class, deleted ones left out. */
export const listForClass = async (schoolId, classId) =>
  (await queryAll({
    TableName: TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :s)',
    ExpressionAttributeValues: { ':p': gsi1.pk(schoolId, classId), ':s': gsi1.interventionPrefix() },
  })).filter((i) => !i.deleted_at);

/** @returns {Promise<{created:boolean, item:object}>} created false: an item with this id already exists */
export async function create(schoolId, value, actor) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.intervention(value.student_id, value.intervention_id),
    GSI1PK: gsi1.pk(schoolId, value.class_id),
    GSI1SK: gsi1.intervention(value.intervention_id),
    entity: 'Intervention',
    school_id: schoolId,
    ...value,
    created_by: actor.sub,
    created_by_name: actor.name ?? null,
    created_at: ts,
    updated_by: actor.sub,
    updated_by_name: actor.name ?? null,
    updated_at: ts,
    deleted_at: null,
    _version: 1,
  };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(SK)' }));
    return { created: true, item };
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    return { created: false, item: await get(schoolId, value.student_id, value.intervention_id) };
  }
}

const EDITABLE = ['factor', 'method', 'frequency', 'status', 'started_on', 'stopped_on', 'expected_outcome', 'notes', 'linked'];

export async function update(schoolId, existing, patch, expectedVersion, actor) {
  const names = { '#v': '_version' };
  const values = { ':v': expectedVersion, ':one': 1, ':ts': nowIso(), ':by': actor.sub, ':byName': actor.name ?? null };
  const sets = ['#v = #v + :one', 'updated_at = :ts', 'updated_by = :by', 'updated_by_name = :byName'];
  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = patch[k];
    sets.push(`#${k} = :${k}`);
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: existing.PK, SK: existing.SK },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#v = :v AND attribute_exists(SK) AND (attribute_not_exists(deleted_at) OR deleted_at = :null)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ...values, ':null': null },
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (isConditionFailure(e)) throw conflict(STALE);
    throw e;
  }
}

export async function softDelete(schoolId, existing, expectedVersion, actor) {
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: existing.PK, SK: existing.SK },
      UpdateExpression: 'SET #v = #v + :one, deleted_at = :ts, deleted_by = :by, updated_at = :ts, updated_by = :by',
      ConditionExpression: '#v = :v AND (attribute_not_exists(deleted_at) OR deleted_at = :null)',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: { ':v': expectedVersion, ':one': 1, ':ts': nowIso(), ':by': actor.sub, ':null': null },
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (isConditionFailure(e)) throw conflict(STALE);
    throw e;
  }
}

// ------------------------------------------------------------------ methods

/** Remembers a method for its factor; the set of teachers who used it gives the "used by" count. */
export async function rememberMethod(schoolId, { factor, method, key }, actor) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.interventionMethod(factor, key) },
    // Every name aliased: several (method, uses) are DynamoDB reserved words.
    UpdateExpression:
      'SET #entity = :e, #school = :s, #factor = :f, #method = if_not_exists(#method, :m), ' +
      '#by = if_not_exists(#by, :by), #byName = if_not_exists(#byName, :byName), ' +
      '#at = if_not_exists(#at, :ts), #last = :ts ADD #teachers :t, #uses :one',
    ExpressionAttributeNames: {
      '#entity': 'entity', '#school': 'school_id', '#factor': 'factor', '#method': 'method', '#by': 'added_by',
      '#byName': 'added_by_name', '#at': 'added_at', '#last': 'last_used_at', '#teachers': 'teacher_ids', '#uses': 'uses',
    },
    ExpressionAttributeValues: {
      ':e': 'InterventionMethod', ':s': schoolId, ':f': factor, ':m': method, ':by': actor.sub,
      ':byName': actor.name ?? null, ':ts': nowIso(), ':t': new Set([actor.sub]), ':one': 1,
    },
  }));
}

/** Remembered methods, for one factor or all of them. */
export const listMethods = (schoolId, factor = null) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.interventionMethodPrefix(factor) },
  });
