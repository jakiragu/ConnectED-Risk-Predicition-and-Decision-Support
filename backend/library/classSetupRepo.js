import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

/** The school's saved forms and streams, or null if it has never saved them. */
export async function get(schoolId) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.classSetup() }, ConsistentRead: true }));
  return res.Item ?? null;
}

export async function save(schoolId, setup, expectedVersion, actor) {
  const item = {
    PK: pk(schoolId),
    SK: sk.classSetup(),
    entity: 'ClassSetup',
    school_id: schoolId,
    forms: setup.forms,
    ...(setup.progression_paths ? { progression_paths: setup.progression_paths } : {}),
    streams: setup.streams,
    _version: expectedVersion + 1,
    updated_at: new Date().toISOString(),
    updated_by: actor.sub,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#v = :exp',
    ...(expectedVersion === 0 ? {} : { ExpressionAttributeNames: { '#v': '_version' }, ExpressionAttributeValues: { ':exp': expectedVersion } }),
  }));
  return item;
}
