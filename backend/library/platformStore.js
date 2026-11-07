import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, PLATFORM_PK, platformSk, pk, sk } from './keys.js';
import { ulid } from './ids.js';
import { sameSchoolKey } from './locations.js';

/**
 * Records behind the Angaza console. A school appears twice, on purpose:
 *
 *   PLATFORM / SCHOOL#<id>      the registration the console lists (no scan needed)
 *   SCHOOL#<id> / SCHOOL#PROFILE  the school's own profile, which every school request reads
 *
 * Both are always written in one transaction, so they cannot drift apart. The
 * profile carries the status that actually blocks a suspended school's users
 * (actor.js), because that check must stay inside the school's own partition.
 */

export const DUPLICATE = 'DuplicateSchool';
export const STALE = 'Stale';
const fail = (name) => Object.assign(new Error(name), { name });
const failedAt = (e, index) =>
  e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

const nowIso = () => new Date().toISOString();

const get = async (PK, SK) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK }, ConsistentRead: true }))).Item || null;

async function queryAll(params) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function countAll(params) {
  let total = 0;
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, Select: 'COUNT', ...params, ExclusiveStartKey }));
    total += res.Count || 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

const auditItem = (schoolId, action, actor, details = {}) => ({
  PK: PLATFORM_PK,
  SK: platformSk.audit(schoolId, ulid()),
  entity: 'PlatformAudit',
  school_id: schoolId,
  action,
  by_sub: actor.sub,
  by_name: actor.name,
  at: nowIso(),
  details,
});

// --------------------------------------------------------------------- staff

export const staff = (sub) => get(PLATFORM_PK, platformSk.staff(sub));

export const putStaff = (item) =>
  ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: PLATFORM_PK, SK: platformSk.staff(item.staff_id), entity: 'PlatformStaff', status: 'ACTIVE', created_at: nowIso(), ...item },
  }));

// ------------------------------------------------------------------- schools

export const registration = (schoolId) => get(PLATFORM_PK, platformSk.school(schoolId));

export const listRegistrations = () =>
  queryAll({
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': PLATFORM_PK, ':s': platformSk.schoolPrefix() },
  });

/** The registration and name claim for a school, as items. Used by createSchool and by seeding. */
export function registrationItems(schoolId, place, { by = null, byName = null, at = nowIso(), status = 'ACTIVE' } = {}) {
  return {
    registration: {
      PK: PLATFORM_PK,
      SK: platformSk.school(schoolId),
      entity: 'SchoolRegistration',
      school_id: schoolId,
      ...place,
      status,
      created_at: at,
      created_by: by,
      created_by_name: byName,
      updated_at: at,
      _version: 1,
    },
    claim: { PK: PLATFORM_PK, SK: platformSk.schoolName(sameSchoolKey(place)), entity: 'SchoolNameClaim', school_id: schoolId },
  };
}

/**
 * Registers a new school: its registration, its name claim (the same name in the
 * same county twice is refused), its own profile, and an audit row, together.
 */
export async function createSchool(schoolId, place, actor) {
  const at = nowIso();
  const { registration: reg, claim } = registrationItems(schoolId, place, { by: actor.sub, byName: actor.name, at });
  const profile = {
    PK: pk(schoolId),
    SK: sk.school(),
    entity: 'School',
    school_id: schoolId,
    ...place,
    status: 'ACTIVE',
    created_at: at,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: reg, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: claim, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: profile, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: auditItem(schoolId, 'SCHOOL_CREATED', actor, { place }) } },
      ],
    }));
  } catch (e) {
    if (failedAt(e, 1)) throw fail(DUPLICATE);
    throw e;
  }
  return reg;
}

/** The school's own profile, updated from the registration so the two never disagree. */
const profileUpdate = (schoolId, fields) => {
  const names = { '#e': 'entity', '#sid': 'school_id' };
  const values = { ':e': 'School', ':sid': schoolId };
  const sets = ['#e = if_not_exists(#e, :e)', '#sid = :sid'];
  const removes = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    if (value === null) removes.push(`#${key}`);
    else {
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
  }
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.school() },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
};

/** A versioned update of the registration; null fields are removed. */
const registrationUpdate = (schoolId, fields, expectedVersion) => {
  const names = { '#v': '_version' };
  const values = { ':exp': expectedVersion, ':one': 1, ':ts': nowIso() };
  const sets = ['updated_at = :ts', '#v = #v + :one'];
  const removes = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    if (value === null) removes.push(`#${key}`);
    else {
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
  }
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: PLATFORM_PK, SK: platformSk.school(schoolId) },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ConditionExpression: 'attribute_exists(PK) AND #v = :exp',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
};

/** Changes a school's name or place. Moves the name claim when the name or place changes. */
export async function updateSchool(current, place, expectedVersion, actor) {
  const schoolId = current.school_id;
  const oldKey = sameSchoolKey(current);
  const newKey = sameSchoolKey(place);
  const items = [
    registrationUpdate(schoolId, place, expectedVersion),
    profileUpdate(schoolId, place),
    { Put: { TableName: TABLE, Item: auditItem(schoolId, 'SCHOOL_UPDATED', actor, { before: pick(current), after: place }) } },
  ];
  if (oldKey !== newKey) {
    items.push(
      { Put: { TableName: TABLE, Item: { PK: PLATFORM_PK, SK: platformSk.schoolName(newKey), entity: 'SchoolNameClaim', school_id: schoolId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Delete: { TableName: TABLE, Key: { PK: PLATFORM_PK, SK: platformSk.schoolName(oldKey) } } },
    );
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (failedAt(e, 0)) throw fail(STALE);
    if (failedAt(e, 3)) throw fail(DUPLICATE);
    throw e;
  }
  return registration(schoolId);
}

const pick = (r) => ({ name: r.name, country: r.country, region: r.region, town: r.town ?? null });

/**
 * Suspends or reactivates a school. The profile's status is what blocks the
 * school's users; the registration keeps who did it and why, for the console.
 */
export async function setStatus(current, status, reason, expectedVersion, actor) {
  const schoolId = current.school_id;
  const suspending = status === 'SUSPENDED';
  const at = nowIso();
  const fields = suspending
    ? { status, suspended_reason: reason, suspended_at: at, suspended_by: actor.sub, suspended_by_name: actor.name, reactivated_at: null, reactivated_by_name: null }
    : { status, suspended_reason: null, suspended_at: null, suspended_by: null, suspended_by_name: null, reactivated_at: at, reactivated_by_name: actor.name };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        registrationUpdate(schoolId, fields, expectedVersion),
        profileUpdate(schoolId, { status }),
        { Put: { TableName: TABLE, Item: auditItem(schoolId, suspending ? 'SCHOOL_SUSPENDED' : 'SCHOOL_REACTIVATED', actor, suspending ? { reason } : {}) } },
      ],
    }));
  } catch (e) {
    if (failedAt(e, 0)) throw fail(STALE);
    throw e;
  }
  return registration(schoolId);
}

/** One audit row, for changes outside a transaction (sign-in accounts live in Cognito). */
export const audit = (schoolId, action, actor, details) =>
  ddb.send(new PutCommand({ TableName: TABLE, Item: auditItem(schoolId, action, actor, details) }));

// ------------------------------------------------- inside a school (totals only)

const inSchool = (schoolId, prefix, filter = {}) => ({
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  ...filter,
  ExpressionAttributeValues: { ':p': pk(schoolId), ':s': prefix, ...(filter.ExpressionAttributeValues || {}) },
});

/** The school's administrator records. Names and emails only: the console shows who to contact. */
export const admins = (schoolId) =>
  queryAll(inSchool(schoolId, sk.teacherPrefix(), {
    FilterExpression: '#r = :admin',
    ExpressionAttributeNames: { '#r': 'role', '#st': 'status' },
    ExpressionAttributeValues: { ':admin': 'Admin' },
    ProjectionExpression: 'teacher_id, first_name, last_name, email, #st, #r, school_id, created_at',
  }));

export const activeAdminCount = (schoolId) =>
  countAll(inSchool(schoolId, sk.teacherPrefix(), {
    FilterExpression: '#r = :admin AND (attribute_not_exists(#st) OR #st = :active)',
    ExpressionAttributeNames: { '#r': 'role', '#st': 'status' },
    ExpressionAttributeValues: { ':admin': 'Admin', ':active': 'ACTIVE' },
  }));

/**
 * How far a school has got, as totals. Angaza sees counts, never records: no
 * student names, marks or risk estimates leave the school through the console.
 */
export async function usage(schoolId) {
  const active = { ExpressionAttributeNames: { '#st': 'status' } };
  const [classes, teachers, students] = await Promise.all([
    countAll(inSchool(schoolId, sk.classPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :current',
      ExpressionAttributeValues: { ':current': 'CURRENT' },
    })),
    countAll(inSchool(schoolId, sk.teacherPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :active',
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
    })),
    countAll(inSchool(schoolId, sk.studentPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :active',
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
    })),
  ]);
  return { classes, teachers, students };
}
