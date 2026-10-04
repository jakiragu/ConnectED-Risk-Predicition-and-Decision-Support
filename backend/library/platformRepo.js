import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

/**
 * Reads of platform data the gradebook depends on but does not own. Kept
 * separate from assessmentRepo so that when Students, Teachers and Classes move
 * to their own CSG module, only this file changes.
 */

export async function teacher(schoolId, teacherId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.teacher(teacherId) } })
  );
  return Item || null;
}

/** Class ids this teacher is assigned to. An empty array denies everything. */
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