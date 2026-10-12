import { BatchWriteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

const academicYearOf = (term) =>
  term?.academic_year ?? (term?.start_date ? Number(String(term.start_date).slice(0, 4)) : null);

export function historyItems(schoolId, set, rows, term) {
  return rows.map((r) => ({
    PK: pk(schoolId),
    SK: sk.studentResult(r.student_id, set.term_id, set.checkpoint, set.class_id),
    entity: 'StudentResult',
    school_id: schoolId,
    student_id: r.student_id,
    class_id: set.class_id,
    term_id: set.term_id,
    academic_year: academicYearOf(term),
    checkpoint: set.checkpoint,
    kind: set.kind,
    calculation_id: set.calculation_id,
    published_at: set.published_at,
    checkpoint_average: r.checkpoint_average ?? null,
    term_average: r.term_average ?? null,
    term_grade: r.term_grade ?? null,
    subjects: (r.subjects || []).map((s) => ({
      subject: s.subject,
      score: s.score ?? null,
      covered: s.covered ?? null,
      assessed_count: s.assessed_count ?? 0,
      absent_count: s.absent_count ?? 0,
      not_assessed_count: s.not_assessed_count ?? 0,
      missing_count: s.missing_count ?? 0,
      term_score: s.term?.term_score ?? null,
      grade: s.term?.grade ?? null,
    })),
  }));
}

async function batchWrite(items) {
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the history rows');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
}

/** Idempotent: the same calculation writes the same rows under the same keys. */
export async function writeHistory(schoolId, set, rows, term) {
  await batchWrite(historyItems(schoolId, set, rows, term));
}

/** Records on the result set that its history is written, so retries skip it. */
export async function markHistoryWritten(schoolId, set) {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: set.SK },
    UpdateExpression: 'SET history_calculation_id = :k, history_written_at = :ts',
    ConditionExpression: 'calculation_id = :k',
    ExpressionAttributeValues: { ':k': set.calculation_id, ':ts': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes;
}

export const historyWritten = (set) => set.history_calculation_id === set.calculation_id;

export async function listStudentHistory(schoolId, studentId) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.studentResultPrefix(studentId) },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}