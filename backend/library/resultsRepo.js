import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';
import { termOpen } from './assessmentRepo.js';
import { CHECKPOINT, PREVIOUS } from './results.js';

const nowIso = () => new Date().toISOString();

export const STATUS = { CALCULATED: 'CALCULATED', PUBLISHED: 'PUBLISHED' };
export const EVENT_STATUS = { PENDING: 'PENDING', SENT: 'SENT' };
export const REPORTS = { PENDING: 'PENDING', RUNNING: 'RUNNING', COMPLETE: 'COMPLETE', FAILED: 'FAILED' };

/** Transaction limit is 100 items: set + gate + predecessor + grade rule + papers. */
export const MAX_PUBLISH_PAPERS = 96;

const setKey = (schoolId, { termId, classId, checkpoint }) => ({
  PK: pk(schoolId),
  SK: sk.resultSet(termId, classId, checkpoint),
});
export const scopeOfSet = (set) => ({ termId: set.term_id, classId: set.class_id, checkpoint: set.checkpoint });

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

async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the result rows');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
}

export async function getSet(schoolId, scope) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: setKey(schoolId, scope), ConsistentRead: true }));
  return Item || null;
}

export const listSetsForClass = (schoolId, { termId, classId }) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.resultSetClassPrefix(termId, classId) },
    ConsistentRead: true,
  });

export const listSetsForTerm = (schoolId, termId) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.resultSetTermPrefix(termId) },
    ConsistentRead: true,
  });

export const listRows = (schoolId, set) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: {
      ':p': pk(schoolId),
      ':s': sk.termResultPrefix(set.term_id, set.class_id, set.checkpoint, set.calculation_id),
    },
    ConsistentRead: true,
  });

export async function getRow(schoolId, set, studentId) {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.termResult(set.term_id, set.class_id, set.checkpoint, set.calculation_id, studentId) },
      ConsistentRead: true,
    })
  );
  return Item || null;
}

/**
 * Rows first, then the result set as the commit point. The set write is
 * conditional on the version this calculation started from and on the class
 * term being open. If it fails, the rows sit under an unreferenced calculation
 * id and are never read.
 */
export async function saveCalculation(schoolId, scope, { calculationId, calc, existing, actor, extra = {} }) {
  const ts = nowIso();
  const rows = calc.rows.map((r) => ({
    PK: pk(schoolId),
    SK: sk.termResult(scope.termId, scope.classId, scope.checkpoint, calculationId, r.student_id),
    entity: 'TermResult',
    term_result_id: `${scope.termId}#${scope.classId}#${scope.checkpoint}#${r.student_id}`,
    school_id: schoolId,
    class_id: scope.classId,
    term_id: scope.termId,
    checkpoint: scope.checkpoint,
    calculation_id: calculationId,
    calculated_at: ts,
    ...r,
  }));
  await batchWrite(rows.map((Item) => ({ PutRequest: { Item } })));

  const item = {
    ...setKey(schoolId, scope),
    entity: 'ResultSet',
    school_id: schoolId,
    class_id: scope.classId,
    term_id: scope.termId,
    checkpoint: scope.checkpoint,
    kind: calc.kind,
    status: STATUS.CALCULATED,
    calculation_id: calculationId,
    subjects: calc.subjects,
    basis: calc.basis,
    issues: calc.issues,
    blocking: calc.blocking,
    student_ids: calc.rows.map((r) => r.student_id),
    calculated_at: ts,
    calculated_by: actor.sub,
    created_at: existing?.created_at || ts,
    updated_at: ts,
    _version: existing ? existing._version + 1 : 1,
    _lastChangedAt: Date.now(),
    ...extra,
  };
  const guard = existing
    ? {
        ConditionExpression: '#v = :exp AND #st = :calc',
        ExpressionAttributeNames: { '#v': '_version', '#st': 'status' },
        ExpressionAttributeValues: { ':exp': existing._version, ':calc': STATUS.CALCULATED },
      }
    : { ConditionExpression: 'attribute_not_exists(PK)' };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: item, ...guard } },
        termOpen(schoolId, scope.termId, scope.classId),
      ],
    })
  );
  return item;
}

/** Best effort: rows of a superseded calculation are unreachable anyway. */
export async function dropRows(schoolId, set) {
  if (!set?.calculation_id) return;
  const rows = await listRows(schoolId, set);
  await batchWrite(rows.map((r) => ({ DeleteRequest: { Key: { PK: r.PK, SK: r.SK } } })));
}

/**
 * Publication of one class checkpoint, in one transaction:
 *   [0]    result set: CALCULATED at the reviewed _version -> PUBLISHED
 *   [1]    class term gate: End-term writes TERMLOCK; Opener/Mid-term require it absent
 *   [2]    predecessor checkpoint is PUBLISHED (Mid-term, End-term)        -- optional
 *   [3]    grade rule's checkpoint weights unchanged since calculation (End-term) -- optional
 *   [...]  each paper in the basis, unchanged since calculation -> LOCKED, published_in += checkpoint
 * A mark written after calculation moved its assessment's _lastChangedAt, so
 * the transaction cannot publish numbers that no longer match the marks.
 * Returns the item index map so the caller can explain a cancellation.
 */
export async function publish(schoolId, set, actor) {
  const ts = nowIso();
  const now = Date.now();
  const scope = scopeOfSet(set);
  const final = set.checkpoint === CHECKPOINT.ENDTERM;
  const previous = PREVIOUS[set.checkpoint];
  const index = {};
  const items = [];
  const push = (name, item) => {
    index[name] = items.length;
    items.push(item);
  };

  push('set', {
    Update: {
      TableName: TABLE,
      Key: setKey(schoolId, scope),
      UpdateExpression:
        'SET #st = :pub, published_at = :ts, published_by = :by, published_from_version = :exp, ' +
        'event_id = :eid, event_status = :pending, report_cards_status = :pending, report_attempt = :one, ' +
        'report_cards_expected = :n, updated_at = :ts, #lc = :lc, #v = #v + :one',
      ConditionExpression: '#st = :calc AND #v = :exp',
      ExpressionAttributeNames: { '#st': 'status', '#v': '_version', '#lc': '_lastChangedAt' },
      ExpressionAttributeValues: {
        ':pub': STATUS.PUBLISHED, ':calc': STATUS.CALCULATED, ':exp': set._version, ':ts': ts, ':by': actor.sub,
        ':eid': `${set.SK}#v${set._version + 1}`, ':pending': EVENT_STATUS.PENDING, ':lc': now, ':one': 1,
        ':n': (set.student_ids || []).length,
      },
    },
  });

  push('gate', final
    ? {
        Put: {
          TableName: TABLE,
          Item: {
            PK: pk(schoolId),
            SK: sk.termLock(set.term_id, set.class_id),
            entity: 'TermLock',
            school_id: schoolId,
            class_id: set.class_id,
            term_id: set.term_id,
            locked_at: ts,
            locked_by: actor.sub,
            result_set: set.SK,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      }
    : termOpen(schoolId, set.term_id, set.class_id));

  if (previous) {
    push('previous', {
      ConditionCheck: {
        TableName: TABLE,
        Key: setKey(schoolId, { ...scope, checkpoint: previous }),
        ConditionExpression: '#st = :pub',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':pub': STATUS.PUBLISHED },
      },
    });
  }
  if (final) {
    push('weights', {
      ConditionCheck: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.gradeRule(set.term_id) },
        ConditionExpression: '#cv = :seen',
        ExpressionAttributeNames: { '#cv': 'checkpoint_weights_version' },
        ExpressionAttributeValues: { ':seen': set.basis_weights_version },
      },
    });
  }

  index.papers = items.length;
  for (const b of set.basis) {
    items.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.assessment(b.assessment_id) },
        UpdateExpression:
          'SET #st = :locked, updated_at = :ts, updated_by = :by, #lc = :lc, #v = #v + :one ADD #pub :cp',
        ConditionExpression: 'attribute_exists(PK) AND #d = :f AND #lc = :seenLc AND #v = :seenV',
        ExpressionAttributeNames: {
          '#st': 'status', '#d': '_deleted', '#lc': '_lastChangedAt', '#v': '_version', '#pub': 'published_in',
        },
        ExpressionAttributeValues: {
          ':locked': 'LOCKED', ':ts': ts, ':by': actor.sub, ':lc': now, ':one': 1, ':f': false,
          ':seenLc': b._lastChangedAt, ':seenV': b._version, ':cp': new Set([set.checkpoint]),
        },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    e.publishIndex = index;
    throw e;
  }
  return getSet(schoolId, scope);
}

async function updateSet(schoolId, set, { set: assignments, condition, names = {}, values = {}, add }) {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: set.SK },
        UpdateExpression: `SET ${assignments.join(', ')}${add ? ` ADD ${add}` : ''}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );
    return res.Attributes;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return getSet(schoolId, scopeOfSet(set));
  }
}

export const markEventSent = (schoolId, set) =>
  updateSet(schoolId, set, {
    set: ['event_status = :sent', 'event_sent_at = :ts'],
    condition: 'event_status = :pending AND event_id = :eid',
    values: { ':sent': EVENT_STATUS.SENT, ':pending': EVENT_STATUS.PENDING, ':eid': set.event_id, ':ts': nowIso() },
  });

/** A failed report job gets a new attempt number, so its execution name is new. */
export const retryReports = (schoolId, set) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :pending', 'report_attempt = report_attempt + :one', 'report_error = :null'],
    condition: 'report_cards_status = :failed AND report_attempt = :attempt',
    values: {
      ':pending': REPORTS.PENDING, ':failed': REPORTS.FAILED, ':attempt': set.report_attempt, ':one': 1, ':null': null,
    },
  });

export const markReportsRunning = (schoolId, set, executionArn) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :running', 'report_execution = :arn', 'report_started_at = :ts'],
    condition: 'report_cards_status = :pending AND report_attempt = :attempt',
    values: {
      ':running': REPORTS.RUNNING, ':pending': REPORTS.PENDING, ':attempt': set.report_attempt,
      ':arn': executionArn, ':ts': nowIso(),
    },
  });

/** Idempotent per student: a retried card adds the same id to the set again. */
export const markReportCardDone = (schoolId, set, studentId) =>
  updateSet(schoolId, set, {
    set: ['report_cards_updated_at = :ts'],
    add: 'report_cards_done :sid',
    condition: 'calculation_id = :calc',
    values: { ':calc': set.calculation_id, ':sid': new Set([studentId]), ':ts': nowIso() },
  });

export const markReportsFinished = (schoolId, set, { ok, error = null }) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :to', 'report_error = :err', 'report_finished_at = :ts'],
    condition: 'calculation_id = :calc AND report_cards_status IN (:pending, :running)',
    values: {
      ':to': ok ? REPORTS.COMPLETE : REPORTS.FAILED, ':err': error, ':ts': nowIso(), ':calc': set.calculation_id,
      ':pending': REPORTS.PENDING, ':running': REPORTS.RUNNING,
    },
  });

/** Same key and same content for the same calculation, so retries are idempotent. */
export async function putReportCard(schoolId, card) {
  const item = {
    PK: pk(schoolId),
    SK: sk.reportCard(card.term_id, card.checkpoint, card.student_id),
    entity: 'ReportCard',
    report_card_id: `${card.term_id}#${card.checkpoint}#${card.student_id}`,
    school_id: schoolId,
    ...card,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}