import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

/** The school's assessment setup (one item per school), or null when it has never been saved. */
export async function get(schoolId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: {
        PK: pk(schoolId),
        SK: sk.assessmentConfig(),
      },
      ConsistentRead: true,
    })
  );

  return result.Item || null;
}

/**
 * Saves the setup. expectedVersion 0 creates it; otherwise the write only
 * succeeds against that version (ConditionalCheckFailedException if stale).
 */
export async function save(schoolId, { scheme, defaultWeights }, expectedVersion, actor) {
  const timestamp = new Date().toISOString();

  if (expectedVersion === 0) {
    const item = {
      PK: pk(schoolId),
      SK: sk.assessmentConfig(),
      entity: 'AssessmentConfig',
      school_id: schoolId,
      assessment_scheme: scheme,
      default_checkpoint_weights: defaultWeights ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      updated_by: actor.sub,
      _version: 1,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return item;
  }

  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: pk(schoolId),
        SK: sk.assessmentConfig(),
      },
      UpdateExpression:
        'SET assessment_scheme = :scheme, default_checkpoint_weights = :weights, updated_at = :ts, ' +
        'updated_by = :by, #v = #v + :one',
      ConditionExpression: 'attribute_exists(PK) AND #v = :expected',
      ExpressionAttributeNames: {
        '#v': '_version',
      },
      ExpressionAttributeValues: {
        ':scheme': scheme,
        ':weights': defaultWeights ?? null,
        ':ts': timestamp,
        ':by': actor.sub,
        ':one': 1,
        ':expected': expectedVersion,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}
