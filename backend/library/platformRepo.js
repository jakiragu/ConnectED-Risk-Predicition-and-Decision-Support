import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

const getItem = async (schoolId, SK, consistent = false) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK }, ConsistentRead: consistent }))).Item || null;

async function queryPrefix(schoolId, prefix, extra = {}) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ...extra,
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': prefix, ...(extra.ExpressionAttributeValues || {}) },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export const teacher = (schoolId, teacherId) => getItem(schoolId, sk.teacher(teacherId), true);
export const school = (schoolId) => getItem(schoolId, sk.school());
export const term = (schoolId, termId) => getItem(schoolId, sk.term(termId));
export const klass = (schoolId, classId) => getItem(schoolId, sk.klass(classId), true);
export const student = (schoolId, studentId) => getItem(schoolId, sk.student(studentId), true);
export const admissionClaim = (schoolId, admissionNo) => getItem(schoolId, sk.admissionNo(admissionNo), true);
export const gradeRule = (schoolId, termId) => getItem(schoolId, sk.gradeRule(termId), true);

export const listTeachers = async (schoolId) =>
  (await queryPrefix(schoolId, sk.teacherPrefix())).sort((a, b) =>
    `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));

export const teacherByEmail = async (schoolId, email) =>
  (await queryPrefix(schoolId, sk.teacherPrefix(), {
    FilterExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email },
  }))[0] || null;

export const listClasses = async (schoolId) =>
  (await queryPrefix(schoolId, sk.classPrefix())).sort((a, b) => a.name.localeCompare(b.name));

export const listTerms = async (schoolId) =>
  (await queryPrefix(schoolId, sk.termPrefix())).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

const byAdmission = (a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true });

/** Students of a class. Active only unless asked; the roster used for marks and results is active only. */
export const listStudents = async (schoolId, classId, { includeInactive = false } = {}) =>
  (await queryPrefix(schoolId, sk.studentPrefix(), {
    FilterExpression: includeInactive
      ? 'class_id = :c'
      : 'class_id = :c AND (attribute_not_exists(#st) OR #st = :active)',
    ExpressionAttributeNames: includeInactive ? undefined : { '#st': 'status' },
    ExpressionAttributeValues: includeInactive ? { ':c': classId } : { ':c': classId, ':active': 'ACTIVE' },
  })).sort(byAdmission);

export const roster = (schoolId, classId) => listStudents(schoolId, classId);

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