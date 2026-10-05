import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi2, gsi3 } from './keys.js';
import { ulid } from './ids.js';
import { termOpen } from './assessmentRepo.js';

const nowIso = () => new Date().toISOString();

const CHUNK = 49;
const MAX_ATTEMPTS = 3;

export async function get(schoolId, assessmentId, studentId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.score(assessmentId, studentId) } })
  );
  return Item || null;
}

export async function listByAssessment(schoolId, assessmentId, { includeDeleted = false } = {}) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': pk(schoolId), ':s': `SCORE#${assessmentId}#` },
        ExclusiveStartKey,
      })
    );
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return includeDeleted ? out : out.filter((s) => !s._deleted);
}

function buildItem(schoolId, assessment, op, actor) {
  const now = Date.now();
  return {
    PK: pk(schoolId),
    SK: sk.score(assessment.assessment_id, op.student_id),
    GSI2PK: gsi2.pk(schoolId, op.student_id),
    GSI2SK: gsi2.score(assessment.term_id, assessment.assessment_id),
    GSI3PK: gsi3.pk(schoolId, assessment.class_id),
    GSI3SK: gsi3.sk(now),
    entity: 'Score',
    score_id: `${assessment.assessment_id}#${op.student_id}`,
    school_id: schoolId,
    assessment_id: assessment.assessment_id,
    student_id: op.student_id,
    class_id: assessment.class_id,
    term_id: assessment.term_id,
    raw_score: op.value,
    normalized_score: op.normalized,
    entered_by: actor.sub,
    entered_at: op.before?.entered_at || nowIso(),
    updated_at: nowIso(),
    _version: op.before ? op.before._version + 1 : 1,
    _lastChangedAt: now,
    _deleted: false,
  };
}

function scoreWrite(schoolId, assessment, op, actor) {
  const Key = { PK: pk(schoolId), SK: sk.score(assessment.assessment_id, op.student_id) };
  if (op.kind === 'clear') {
    return {
      Delete: {
        TableName: TABLE,
        Key,
        ConditionExpression: '#v = :exp',
        ExpressionAttributeNames: { '#v': '_version' },
        ExpressionAttributeValues: { ':exp': op.before._version },
      },
    };
  }
  const Item = buildItem(schoolId, assessment, op, actor);
  op.item = Item;
  return op.kind === 'create'
    ? { Put: { TableName: TABLE, Item, ConditionExpression: 'attribute_not_exists(SK)' } }
    : {
        Put: {
          TableName: TABLE,
          Item,
          ConditionExpression: '#v = :exp',
          ExpressionAttributeNames: { '#v': '_version' },
          ExpressionAttributeValues: { ':exp': op.before._version },
        },
      };
}

function auditWrite(schoolId, assessment, op, actor) {
  return {
    Put: {
      TableName: TABLE,
      Item: {
        PK: pk(schoolId),
        SK: sk.scoreAudit(assessment.assessment_id, op.student_id, ulid()),
        entity: 'ScoreAudit',
        school_id: schoolId,
        assessment_id: assessment.assessment_id,
        student_id: op.student_id,
        action: op.kind.toUpperCase(),
        from: op.before?.raw_score ?? null,
        to: op.kind === 'clear' ? null : op.value,
        by: actor.sub,
        at: nowIso(),
        version: op.kind === 'clear' ? null : op.item._version,
      },
    },
  };
}

const delta = (ops) => ops.reduce((n, op) => n + (op.kind === 'create' ? 1 : op.kind === 'clear' ? -1 : 0), 0);

async function writeChunk(schoolId, assessment, ops, actor) {
  const items = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.assessment(assessment.assessment_id) },
        UpdateExpression: 'SET #sc = if_not_exists(#sc, :zero) + :delta, #lc = :lc',
        ConditionExpression: 'attribute_exists(PK) AND #d = :f AND #st <> :locked',
        ExpressionAttributeNames: { '#sc': 'score_count', '#lc': '_lastChangedAt', '#d': '_deleted', '#st': 'status' },
        ExpressionAttributeValues: {
          ':zero': 0, ':delta': delta(ops), ':lc': Date.now(), ':f': false, ':locked': 'LOCKED',
        },
      },
    },
    termOpen(schoolId, assessment.term_id),
  ];
  for (const op of ops) {
    items.push(scoreWrite(schoolId, assessment, op, actor), auditWrite(schoolId, assessment, op, actor));
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: items }));
}

/**
 * Applies validated ops. A mark whose version guard fails is reported as a
 * conflict and the rest of its chunk is retried without it, so one stale cell
 * does not cost the teacher the others.
 *
 * @returns {{applied: object[], conflicted: object[], blocked: null|'ASSESSMENT'|'TERM'}}
 */
export async function applyBatch(schoolId, assessment, ops, actor) {
  const applied = [];
  const conflicted = [];

  for (let i = 0; i < ops.length; i += CHUNK) {
    let pending = ops.slice(i, i + CHUNK);
    for (let attempt = 1; pending.length && attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await writeChunk(schoolId, assessment, pending, actor);
        applied.push(...pending);
        pending = [];
      } catch (e) {
        if (e.name !== 'TransactionCanceledException') throw e;
        const reasons = e.CancellationReasons || [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return { applied, conflicted, blocked: 'ASSESSMENT' };
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return { applied, conflicted, blocked: 'TERM' };
        const stale = pending.filter((_, j) => reasons[2 + 2 * j]?.Code === 'ConditionalCheckFailed');
        conflicted.push(...stale);
        pending = pending.filter((op) => !stale.includes(op));
        if (!stale.length && attempt === MAX_ATTEMPTS) throw e;
      }
    }
  }
  return { applied, conflicted, blocked: null };
}

export async function setDeletedAll(schoolId, assessmentId, deleted, actor) {
  const rows = await listByAssessment(schoolId, assessmentId, { includeDeleted: true });
  let changed = 0;
  for (const row of rows.filter((r) => Boolean(r._deleted) !== deleted)) {
    const now = Date.now();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: row.PK, SK: row.SK },
          UpdateExpression: deleted
            ? 'SET #d = :to, deleted_at = :ts, deleted_by = :by, #lc = :lc, GSI3SK = :g3, #v = #v + :one'
            : 'SET #d = :to, #lc = :lc, GSI3SK = :g3, #v = #v + :one REMOVE deleted_at, deleted_by',
          ConditionExpression: '#d = :from',
          ExpressionAttributeNames: { '#d': '_deleted', '#lc': '_lastChangedAt', '#v': '_version' },
          ExpressionAttributeValues: {
            ':to': deleted, ':from': !deleted, ':lc': now, ':g3': gsi3.sk(now), ':one': 1,
            ...(deleted ? { ':ts': nowIso(), ':by': actor.sub } : {}),
          },
        })
      );
      changed++;
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    }
  }
  return changed;
}