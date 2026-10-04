import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk } from './keys.js';

export async function countByAssessment(schoolId, assessmentId) {
  let count = 0;
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        FilterExpression: 'attribute_not_exists(#d) OR #d = :f',
        ExpressionAttributeNames: { '#d': '_deleted' },
        ExpressionAttributeValues: { ':p': pk(schoolId), ':s': `SCORE#${assessmentId}#`, ':f': false },
        Select: 'COUNT',
        ExclusiveStartKey,
      })
    );
    count += res.Count || 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}