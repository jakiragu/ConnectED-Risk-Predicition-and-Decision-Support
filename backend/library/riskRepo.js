import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi2 } from './keys.js';

/**
 * Risk predictions and the runs that produced them.
 *   RISKRUN#<term>#<class>#<checkpoint>          the latest run for a published class checkpoint
 *   RISK#<year>#<point>#<student>                a student's latest prediction at a point
 *     GSI2: <student> / RISK#<year>#<point>      a student's predictions through the year
 * A prediction keeps the exact inputs the model received, the model version and
 * the threshold, so it can be explained (SHAP) and acted on (DiCE) later.
 */
const nowIso = () => new Date().toISOString();

export const RUN = { QUEUED: 'QUEUED', RUNNING: 'RUNNING', COMPLETE: 'COMPLETE', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };

export async function getRun(schoolId, termId, classId, checkpoint) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.riskRun(termId, classId, checkpoint) }, ConsistentRead: true,
  }));
  return Item || null;
}

export async function putRun(schoolId, run) {
  const item = {
    PK: pk(schoolId),
    SK: sk.riskRun(run.term_id, run.class_id, run.checkpoint),
    entity: 'RiskRun',
    school_id: schoolId,
    updated_at: nowIso(),
    ...run,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function finishRun(schoolId, run, patch) {
  const names = {};
  const values = { ':ts': nowIso(), ':run': run.run_id };
  const sets = ['updated_at = :ts', 'finished_at = :ts'];
  for (const [k, v] of Object.entries(patch)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.riskRun(run.term_id, run.class_id, run.checkpoint) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'run_id = :run', // a newer run owns the record now
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw e;
  }
}

export function predictionItem(schoolId, p) {
  return {
    PK: pk(schoolId),
    SK: sk.risk(p.academic_year, p.prediction_point, p.student_id),
    GSI2PK: gsi2.pk(schoolId, p.student_id),
    GSI2SK: gsi2.risk(p.academic_year, p.prediction_point),
    entity: 'RiskPrediction',
    school_id: schoolId,
    ...p,
  };
}

export async function putPredictions(schoolId, predictions) {
  const items = predictions.map((p) => predictionItem(schoolId, p));
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the prediction rows');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
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

/** Predictions at one point for the students who were in a class when it ran. */
export const listForClass = (schoolId, academicYear, point, classId) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    FilterExpression: 'class_id = :c',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.riskPointPrefix(academicYear, point), ':c': classId },
  });

export const listForStudent = (schoolId, studentId, academicYear) =>
  queryAll({
    TableName: TABLE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :p AND begins_with(GSI2SK, :s)',
    ExpressionAttributeValues: { ':p': gsi2.pk(schoolId, studentId), ':s': gsi2.riskYearPrefix(academicYear) },
  });