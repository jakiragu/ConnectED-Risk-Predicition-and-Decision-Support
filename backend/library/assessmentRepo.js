import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi1 } from './keys.js';

const nowIso = () => new Date().toISOString();

/** "No marks" as a condition. Rows created before score_count existed have no attribute. */
const NO_MARKS = '(attribute_not_exists(#sc) OR #sc = :zero)';

/** A term is open while its TERMLOCK item does not exist. Used inside transactions. */
const termOpen = (schoolId, termId) => ({
  ConditionCheck: {
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.termLock(termId) },
    ConditionExpression: 'attribute_not_exists(PK)',
  },
});

/** Which transaction item cancelled it, by index. */
export const cancelledAt = (e, index) =>
  e?.name === 'TransactionCanceledException' &&
  e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

/** Returns the row whether or not it is a tombstone; the caller decides. */
export async function get(schoolId, assessmentId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.assessment(assessmentId) } })
  );
  return Item || null;
}

async function queryClassTerm(schoolId, classId, termId, { limit = 50, nextToken } = {}) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :s)',
      ExpressionAttributeValues: {
        ':p': gsi1.pk(schoolId, classId),
        ':s': `TERM#${termId}#ASSESSMENT#`,
      },
      Limit: limit,
      ExclusiveStartKey: nextToken
        ? JSON.parse(Buffer.from(nextToken, 'base64').toString('utf8'))
        : undefined,
    })
  );
  return {
    items: res.Items || [],
    nextToken: res.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64')
      : null,
  };
}

/** Live assessments for a class this term. Tombstones keep their GSI1 keys, so they are filtered here. */
export async function listByClass(schoolId, classId, termId, opts) {
  const page = await queryClassTerm(schoolId, classId, termId, opts);
  return { ...page, items: page.items.filter((i) => !i._deleted) };
}

/** Soft-deleted assessments for a class this term, for the restore list. */
export async function listDeletedByClass(schoolId, classId, termId) {
  const out = [];
  let nextToken;
  do {
    const page = await queryClassTerm(schoolId, classId, termId, { limit: 100, nextToken });
    out.push(...page.items.filter((i) => i._deleted));
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

export async function create(schoolId, input, actor) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.assessment(input.assessment_id),
    GSI1PK: gsi1.pk(schoolId, input.class_id),
    GSI1SK: gsi1.assessment(input.term_id, input.assessment_id),
    entity: 'Assessment',
    assessment_id: input.assessment_id,
    school_id: schoolId,
    class_id: input.class_id,
    term_id: input.term_id,
    subject: input.subject,
    title: input.title,
    assessment_type: input.assessment_type,
    weight: input.weight,
    max_score: input.max_score,
    due_date: input.due_date ?? null,
    status: 'UNRECORDED',
    score_count: 0,
    created_at: ts,
    updated_at: ts,
    created_by: actor.sub,
    updated_by: actor.sub,
    _version: 1,
    _lastChangedAt: Date.now(),
    _deleted: false,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );
    return { item, created: true };
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return { item: await get(schoolId, input.assessment_id), created: false };
  }
}

/**
 * Optimistic update guarded by _version, the lock and the tombstone.
 * requireNoMarks adds the max_score freeze atomically: if a mark lands between
 * the handler's read and this write, the write fails instead of rescaling it.
 */
export async function update(schoolId, assessmentId, patch, expectedVersion, actor, { requireNoMarks = false } = {}) {
  const sets = [];
  const names = { '#v': '_version', '#st': 'status', '#d': '_deleted' };
  const values = {
    ':exp': expectedVersion,
    ':one': 1,
    ':ts': nowIso(),
    ':lc': Date.now(),
    ':locked': 'LOCKED',
    ':f': false,
  };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  names['#ua'] = 'updated_at';
  names['#ub'] = 'updated_by';
  names['#lc'] = '_lastChangedAt';
  values[':ub'] = actor.sub;
  sets.push('#ua = :ts', '#ub = :ub', '#lc = :lc', '#v = #v + :one');

  let condition = 'attribute_exists(PK) AND #v = :exp AND #st <> :locked AND #d = :f';
  if (requireNoMarks) {
    names['#sc'] = 'score_count';
    values[':zero'] = 0;
    condition += ` AND ${NO_MARKS}`;
  }

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.assessment(assessmentId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );
  return res.Attributes;
}

export async function setStatus(schoolId, assessmentId, status) {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.assessment(assessmentId) },
      UpdateExpression: 'SET #st = :s, #lc = :lc, #v = #v + :one, updated_at = :ts',
      ConditionExpression: 'attribute_exists(PK) AND #d = :f',
      ExpressionAttributeNames: { '#st': 'status', '#lc': '_lastChangedAt', '#v': '_version', '#d': '_deleted' },
      ExpressionAttributeValues: { ':s': status, ':lc': Date.now(), ':one': 1, ':ts': nowIso(), ':f': false },
      ReturnValues: 'ALL_NEW',
    })
  );
  return res.Attributes;
}

/**
 * A-17: unlock. Clears the stored LOCKED state. The term check is inside the
 * transaction, so an unlock cannot slip in after results are published.
 * Transaction items: [0] assessment, [1] term open.
 */
export async function unlock(schoolId, assessment, actor) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk(schoolId), SK: sk.assessment(assessment.assessment_id) },
            UpdateExpression:
              'SET #st = :open, updated_at = :ts, updated_by = :by, #lc = :lc, #v = #v + :one',
            ConditionExpression: 'attribute_exists(PK) AND #st = :locked AND #d = :f',
            ExpressionAttributeNames: { '#st': 'status', '#d': '_deleted', '#v': '_version', '#lc': '_lastChangedAt' },
            ExpressionAttributeValues: {
              ':open': 'UNRECORDED', ':locked': 'LOCKED', ':f': false,
              ':ts': nowIso(), ':by': actor.sub, ':lc': Date.now(), ':one': 1,
            },
          },
        },
        termOpen(schoolId, assessment.term_id),
      ],
    })
  );
}

/**
 * A-14: hard delete of an assessment nothing depends on. score_count = 0 is in
 * the condition, so a mark saved after the handler's check makes this fail
 * rather than orphaning the mark.
 */
export async function hardDelete(schoolId, assessmentId, expectedVersion) {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.assessment(assessmentId) },
      ConditionExpression: `attribute_exists(PK) AND #v = :exp AND #st <> :locked AND #d = :f AND ${NO_MARKS}`,
      ExpressionAttributeNames: { '#v': '_version', '#st': 'status', '#d': '_deleted', '#sc': 'score_count' },
      ExpressionAttributeValues: { ':exp': expectedVersion, ':locked': 'LOCKED', ':f': false, ':zero': 0 },
    })
  );
}

/**
 * A-16: soft delete. Tombstones the assessment only; its marks are tombstoned
 * afterwards by scoreRepo.setDeletedAll. Once this commits, every score write
 * is refused, so the marks cannot change underneath the cascade.
 * Transaction items: [0] assessment, [1] term open.
 */
export async function softDelete(schoolId, assessment, expectedVersion, actor) {
  const ts = nowIso();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk(schoolId), SK: sk.assessment(assessment.assessment_id) },
            UpdateExpression:
              'SET #d = :t, deleted_at = :ts, deleted_by = :by, updated_at = :ts, ' +
              'updated_by = :by, #lc = :lc, #v = #v + :one',
            ConditionExpression: 'attribute_exists(PK) AND #v = :exp AND #st <> :locked AND #d = :f',
            ExpressionAttributeNames: { '#d': '_deleted', '#v': '_version', '#st': 'status', '#lc': '_lastChangedAt' },
            ExpressionAttributeValues: {
              ':t': true, ':f': false, ':ts': ts, ':by': actor.sub, ':lc': Date.now(),
              ':one': 1, ':exp': expectedVersion, ':locked': 'LOCKED',
            },
          },
        },
        termOpen(schoolId, assessment.term_id),
      ],
    })
  );
}

/**
 * A-16: restore. The commit point of a restore; marks are restored before this.
 * Transaction items: [0] assessment, [1] term open.
 */
export async function restore(schoolId, assessment, actor) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk(schoolId), SK: sk.assessment(assessment.assessment_id) },
            UpdateExpression:
              'SET #d = :f, updated_at = :ts, updated_by = :by, #lc = :lc, #v = #v + :one ' +
              'REMOVE deleted_at, deleted_by',
            ConditionExpression: '#d = :t AND #v = :exp',
            ExpressionAttributeNames: { '#d': '_deleted', '#v': '_version', '#lc': '_lastChangedAt' },
            ExpressionAttributeValues: {
              ':t': true, ':f': false, ':ts': nowIso(), ':by': actor.sub, ':lc': Date.now(),
              ':one': 1, ':exp': assessment._version,
            },
          },
        },
        termOpen(schoolId, assessment.term_id),
      ],
    })
  );
}

/** Existence of TERMLOCK#<term_id> is the gate. Nothing writes it until results publication. */
export async function termLocked(schoolId, termId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.termLock(termId) } })
  );
  return Boolean(Item);
}

export { termOpen };