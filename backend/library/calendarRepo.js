import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

/** Terms of the school calendar (TERM#<term_id>). Writes are optimistic on _version. */
const nowIso = () => new Date().toISOString();
export const STALE = 'Stale';

export async function getTerm(schoolId, termId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.term(termId) }, ConsistentRead: true }));
  return Item || null;
}

/** @returns {{item, created:boolean}} */
export async function createTerm(schoolId, term, actor) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.term(term.term_id),
    entity: 'Term',
    school_id: schoolId,
    created_at: ts,
    created_by: actor.sub,
    updated_at: ts,
    updated_by: actor.sub,
    _version: 1,
    ...term,
  };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return { item, created: true };
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return { item: await getTerm(schoolId, term.term_id), created: false };
  }
}

/** Seeded terms written before versioning count as version 0. */
export async function updateTerm(schoolId, termId, patch, expectedVersion, actor) {
  const names = { '#v': '_version' };
  const values = { ':exp': expectedVersion, ':zero': 0, ':one': 1, ':ts': nowIso(), ':by': actor.sub };
  const sets = ['updated_at = :ts', 'updated_by = :by', '#v = if_not_exists(#v, :zero) + :one'];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.term(termId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: expectedVersion === 0
        ? 'attribute_exists(PK) AND (attribute_not_exists(#v) OR #v = :zero)'
        : 'attribute_exists(PK) AND #v = :exp',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw Object.assign(new Error(STALE), { name: STALE });
    throw e;
  }
}