import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';
import { DEFAULT_GRADING } from './grading.js';

/**
 * The school's default grading rules, or the built-in default when the school
 * has never saved its own (_version 0 then, so the first save is a create).
 */
export async function getPolicy(schoolId) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.gradingPolicy() },
    ConsistentRead: true,
  }));
  if (res.Item) return res.Item;
  return { school_id: schoolId, ...DEFAULT_GRADING, _version: 0, is_default: true };
}

/** Saves the default. expectedVersion is the _version the admin was editing; stale => ConditionalCheckFailed. */
export async function savePolicy(schoolId, rules, expectedVersion, actor) {
  const item = {
    PK: pk(schoolId),
    SK: sk.gradingPolicy(),
    entity: 'GradingPolicy',
    school_id: schoolId,
    pass_mark: rules.pass_mark,
    missing_score_policy: rules.missing_score_policy,
    bands: rules.bands,
    _version: expectedVersion + 1,
    updated_at: new Date().toISOString(),
    updated_by: actor.sub,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#v = :exp',
    ...(expectedVersion === 0
      ? {}
      : { ExpressionAttributeNames: { '#v': '_version' }, ExpressionAttributeValues: { ':exp': expectedVersion } }),
  }));
  return item;
}

/**
 * Changes a term's grading rules. grading_version counts these changes, the
 * same way checkpoint_weights_version counts weight changes: a calculation
 * records the version it used, and publishing refuses a calculation made under
 * rules that have since changed.
 */
export async function setTermGrading(schoolId, termId, rules, expectedVersion, actor) {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.gradeRule(termId) },
    UpdateExpression:
      'SET pass_mark = :pm, missing_score_policy = :mp, bands = :b, #gv = if_not_exists(#gv, :zero) + :one, ' +
      'grading_updated_at = :ts, grading_updated_by = :by',
    ConditionExpression:
      expectedVersion === 0
        ? 'attribute_exists(PK) AND (attribute_not_exists(#gv) OR #gv = :zero)'
        : 'attribute_exists(PK) AND #gv = :exp',
    ExpressionAttributeNames: { '#gv': 'grading_version' },
    ExpressionAttributeValues: {
      ':pm': rules.pass_mark,
      ':mp': rules.missing_score_policy,
      ':b': rules.bands,
      ':zero': 0,
      ':one': 1,
      ':ts': new Date().toISOString(),
      ':by': actor.sub,
      ...(expectedVersion === 0 ? {} : { ':exp': expectedVersion }),
    },
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes;
}
