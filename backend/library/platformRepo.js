import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

const getItem = async (schoolId, SK) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK } }))).Item || null;

export const teacher = (schoolId, teacherId) => getItem(schoolId, sk.teacher(teacherId));
export const school = (schoolId) => getItem(schoolId, sk.school());
export const term = (schoolId, termId) => getItem(schoolId, sk.term(termId));
export const klass = (schoolId, classId) => getItem(schoolId, sk.klass(classId));
export const student = (schoolId, studentId) => getItem(schoolId, sk.student(studentId));
export const gradeRule = (schoolId, termId) =>
  ddb
    .send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.gradeRule(termId) }, ConsistentRead: true }))
    .then((r) => r.Item || null);

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

export async function listTerms(schoolId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.termPrefix() },
    })
  );
  return (res.Items || []).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
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

export async function setCheckpointWeights(schoolId, termId, weights, expectedVersion, actor) {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.gradeRule(termId) },
      UpdateExpression:
        'SET checkpoint_weights = :w, #cv = if_not_exists(#cv, :zero) + :one, ' +
        'checkpoint_weights_updated_at = :ts, checkpoint_weights_updated_by = :by',
      ConditionExpression:
        expectedVersion === 0
          ? 'attribute_exists(PK) AND (attribute_not_exists(#cv) OR #cv = :zero)'
          : 'attribute_exists(PK) AND #cv = :exp',
      ExpressionAttributeNames: { '#cv': 'checkpoint_weights_version' },
      ExpressionAttributeValues: {
        ':w': weights, ':zero': 0, ':one': 1, ':ts': new Date().toISOString(), ':by': actor.sub,
        ...(expectedVersion === 0 ? {} : { ':exp': expectedVersion }),
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  return res.Attributes;
}