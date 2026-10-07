import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';


export async function teacher(schoolId, teacherId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.teacher(teacherId) } })
  );
  return Item || null;
}

export async function assignments(schoolId, teacherId) {
  const t = await teacher(schoolId, teacherId);
  return t?.class_ids || [];
}

export async function listClasses(schoolId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': 'CLASS#' },
    })
  );
  return (res.Items || []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function roster(schoolId, classId) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        FilterExpression: 'class_id = :c AND (attribute_not_exists(#st) OR #st = :active)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':p': pk(schoolId), ':s': 'STUDENT#', ':c': classId, ':active': 'ACTIVE' },
        ExclusiveStartKey,
      })
    );
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
}