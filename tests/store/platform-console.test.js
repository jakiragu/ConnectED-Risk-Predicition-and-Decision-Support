import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * The Angaza console's documents (src/api/platformOperations.js) run through the
 * real GraphQL schema and resolver map against an in-process DynamoDB, with
 * identities shaped as AppSync passes them for each of the two sign-in pools.
 * Creating administrators needs Cognito and is covered by the integration test.
 *
 *   npm run test:store
 */
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
const ANGAZA_POOL = 'eu-west-1_angazaPool';
const SCHOOL_POOL = 'eu-west-1_schoolPool';
const ISSUER = (pool) => `http://localhost:9229/${pool}`;
let schema;
let graphql;
let ops;
let schoolOps;
let ddb;
let Put;
let keys;

const angaza = { sub: 'u_angaza', issuer: ISSUER(ANGAZA_POOL), claims: { iss: ISSUER(ANGAZA_POOL), email: 'staff@angazacenter.org' }, groups: [] };
const outsider = { sub: 'u_stranger', issuer: ISSUER(ANGAZA_POOL), claims: { iss: ISSUER(ANGAZA_POOL), email: 'x@angazacenter.org' }, groups: [] };
const schoolAdmin = (schoolId) => ({
  sub: 'u_admin', issuer: ISSUER(SCHOOL_POOL), claims: { iss: ISSUER(SCHOOL_POOL), 'custom:school_id': schoolId, email: 'admin@school.test' }, groups: ['Admin'],
});

before(async () => {
  await new Promise((r) => server.listen(0, r));
  Object.assign(process.env, {
    DDB_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    EVENTS_ENDPOINT: 'http://127.0.0.1:9',
    COGNITO_ENDPOINT: 'http://127.0.0.1:9', // unreachable on purpose: sign-in state reads as UNKNOWN
    GRADEBOOK_TABLE_NAME: 'platform_console_test',
    AWS_REGION: 'eu-west-1',
    PLATFORM_COGNITO_USER_POOL_ID: ANGAZA_POOL,
  });
  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  ({ PutCommand: Put } = await import('@aws-sdk/lib-dynamodb'));
  ({ ddb } = await import('../../backend/library/client.js'));
  (await import('../helpers/transactShim.js')).emulateTransactions(ddb);
  const { TABLE_DEFINITION } = await import('../../infra/table-definition.js');
  const { StreamSpecification, ...table } = TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  keys = await import('../../backend/library/keys.js');

  graphql = await import('graphql');
  const { createSchema } = await import('graphql-yoga');
  const { RESOLVERS } = await import('../../local/resolvers.js');
  const resolvers = { Query: {}, Mutation: {} };
  for (const [parent, fields] of Object.entries(RESOLVERS)) {
    for (const [field, service] of Object.entries(fields)) {
      resolvers[parent][field] = (_root, args, ctx) =>
        service({ arguments: args, identity: ctx.identity, info: { fieldName: field, parentTypeName: parent } });
    }
  }
  schema = createSchema({ typeDefs: readFileSync('graphql/schema/gradebook.graphql', 'utf8'), resolvers });
  ops = await import('../../src/api/platformOperations.js');
  schoolOps = await import('../../src/api/operations.js');
  await ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.PLATFORM_PK, SK: keys.platformSk.staff('u_angaza'), staff_id: 'u_angaza', first_name: 'Asha', last_name: 'Staff', status: 'ACTIVE' } }));
});

after(() => new Promise((r) => server.close(r)));

/** Runs a document as `identity`; a refusal comes back as { error: { type, field, message } }. */
async function run(identity, document, variables = {}) {
  const res = await graphql.execute({ schema, document: graphql.parse(document), variableValues: variables, contextValue: { identity } });
  if (res.errors?.length) {
    const e = res.errors[0];
    if (!e.originalError?.type) throw new Error(e.message); // a malformed document is a test failure, not a refusal // a malformed document is a test failure, not a refusal
    return { error: { type: e.originalError.type, field: e.originalError.field, message: e.message } };
  }
  return res.data;
}

const put = (schoolId, Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(schoolId), school_id: schoolId, ...Item } }));

let huye; // the school the later cases work on

tc({
  id: 'TC-ANG01', requirement: 'EXT-ANGAZA', level: 'Integration (store)', technique: 'Black box, interface',
  scenario: 'Angaza staff register schools with a place but no coordinates',
  data: 'Rwanda, district typed as "huye"; the same school again; a Kenyan school with a county that does not exist',
  expected: 'The school is listed with the district as officially spelled, its time zone from the country and no administrator; the duplicate and the unknown county are refused on the field concerned',
}, async (ev) => {
  const created = await run(angaza, ops.CREATE_SCHOOL, { input: { name: '  Groupe Scolaire  Huye ', country: 'RW', region: 'huye', town: 'Butare' } });
  huye = created.createSchool;
  assert.deepEqual([huye.name, huye.region, huye.region_label, huye.time_zone, huye.status], ['Groupe Scolaire Huye', 'Huye', 'District', 'Africa/Kigali', 'ACTIVE']);
  assert.match(huye.school_id, /^sch_groupe_scolaire_huye_[a-z0-9]{4}$/);

  const { listSchools } = await run(angaza, ops.LIST_SCHOOLS);
  assert.deepEqual(listSchools.map((s) => [s.name, s.country_name, s.active_admin_count]), [['Groupe Scolaire Huye', 'Rwanda', 0]]);

  const dup = await run(angaza, ops.CREATE_SCHOOL, { input: { name: 'groupe scolaire huye', country: 'RW', region: 'Huye' } });
  assert.deepEqual([dup.error.type, dup.error.field], ['ValidationError', 'name']);
  const bad = await run(angaza, ops.CREATE_SCHOOL, { input: { name: 'Lake School', country: 'KE', region: 'Atlantis' } });
  assert.deepEqual([bad.error.type, bad.error.field], ['ValidationError', 'region']);
  ev(`created ${huye.school_id}; duplicate: ${dup.error.message}; bad county: ${bad.error.message}`);
});

tc({
  id: 'TC-ANG02', requirement: 'EXT-ANGAZA, NFR-1', level: 'Integration (store)', technique: 'Black box, authorisation',
  scenario: 'Each sign-in pool is refused by the other side of the API',
  data: 'a school administrator calls listSchools; an Angaza account calls the school operation me; an Angaza-pool account with no staff record calls listSchools',
  expected: 'All three are refused as Unauthorized',
}, async (ev) => {
  await put(huye.school_id, { SK: keys.sk.teacher('u_admin'), entity: 'Teacher', teacher_id: 'u_admin', first_name: 'Ada', last_name: 'Admin', email: 'admin@school.test', role: 'Admin', status: 'ACTIVE', assignments: [], _version: 1 });
  const a = await run(schoolAdmin(huye.school_id), ops.LIST_SCHOOLS);
  const b = await run({ ...angaza, claims: { ...angaza.claims, 'custom:school_id': huye.school_id } }, schoolOps.ME, { school_id: huye.school_id });
  const c = await run(outsider, ops.LIST_SCHOOLS);
  for (const r of [a, b, c]) assert.equal(r.error?.type, 'Unauthorized');
  ev([a, b, c].map((r) => r.error.message).join(' | '));
});

tc({
  id: 'TC-ANG03', requirement: 'EXT-ANGAZA', level: 'Integration (store)', technique: 'Black box, state transition',
  scenario: 'Suspending a school stops its users at once and reactivating restores them',
  data: 'suspend without a reason; suspend with a reason; the school administrator calls me; reactivate with an old version; reactivate',
  expected: 'No reason is refused; while suspended the administrator gets SchoolSuspended; the old version is a Conflict; after reactivation me works again',
}, async (ev) => {
  const ok = await run(schoolAdmin(huye.school_id), schoolOps.ME, { school_id: huye.school_id });
  assert.equal(ok.me.first_name, 'Ada');

  const noReason = await run(angaza, ops.SUSPEND_SCHOOL, { input: { school_id: huye.school_id, reason: ' ', _version: huye._version } });
  assert.equal(noReason.error.field, 'reason');
  const { suspendSchool } = await run(angaza, ops.SUSPEND_SCHOOL, { input: { school_id: huye.school_id, reason: 'Programme paused for the holidays', _version: huye._version } });
  assert.deepEqual([suspendSchool.status, suspendSchool.suspended_by_name], ['SUSPENDED', 'Asha Staff']);

  const blocked = await run(schoolAdmin(huye.school_id), schoolOps.ME, { school_id: huye.school_id });
  assert.equal(blocked.error.type, 'SchoolSuspended');

  const stale = await run(angaza, ops.REACTIVATE_SCHOOL, { input: { school_id: huye.school_id, _version: huye._version } });
  assert.equal(stale.error.type, 'Conflict');
  const { reactivateSchool } = await run(angaza, ops.REACTIVATE_SCHOOL, { input: { school_id: huye.school_id, _version: suspendSchool._version } });
  assert.deepEqual([reactivateSchool.status, reactivateSchool.suspended_reason], ['ACTIVE', null]);
  huye = reactivateSchool;

  const back = await run(schoolAdmin(huye.school_id), schoolOps.ME, { school_id: huye.school_id });
  assert.equal(back.me.first_name, 'Ada');
  ev(`suspended: ${blocked.error.message}; stale: ${stale.error.type}; reactivated v${huye._version}`);
});

tc({
  id: 'TC-ANG04', requirement: 'EXT-ANGAZA', level: 'Integration (store)', technique: 'Black box, interface',
  scenario: 'A school page shows administrators and totals only, and renaming frees the old name',
  data: 'one current and one past class, one active and one inactive student; rename the school, then register a new school under the old name',
  expected: 'Totals count only current and active records; the administrator is listed; the new school under the old name is accepted',
}, async (ev) => {
  await put(huye.school_id, { SK: keys.sk.klass('c1'), entity: 'Class', class_id: 'c1', name: 'Form 1 East', status: 'CURRENT' });
  await put(huye.school_id, { SK: keys.sk.klass('c0'), entity: 'Class', class_id: 'c0', name: 'Form 4 East', status: 'PAST' });
  await put(huye.school_id, { SK: keys.sk.student('s1'), entity: 'Student', student_id: 's1', class_id: 'c1', status: 'ACTIVE' });
  await put(huye.school_id, { SK: keys.sk.student('s2'), entity: 'Student', student_id: 's2', class_id: 'c0', status: 'GRADUATED' });

  const { getSchool } = await run(angaza, ops.GET_SCHOOL, { school_id: huye.school_id });
  assert.deepEqual({ ...getSchool.usage }, { classes: 1, teachers: 1, students: 1 });
  assert.deepEqual(getSchool.admins.map((a) => [a.first_name, a.sign_in]), [['Ada', 'UNKNOWN']]);
  assert.equal(getSchool.school.active_admin_count, 1);

  const { updateSchool } = await run(angaza, ops.UPDATE_SCHOOL, {
    input: { school_id: huye.school_id, name: 'GS Huye', country: 'RW', region: 'Huye', town: null, _version: huye._version },
  });
  assert.equal(updateSchool.name, 'GS Huye');
  const again = await run(angaza, ops.CREATE_SCHOOL, { input: { name: 'Groupe Scolaire Huye', country: 'RW', region: 'Huye' } });
  assert.equal(again.createSchool.name, 'Groupe Scolaire Huye');
  ev(`usage ${JSON.stringify(getSchool.usage)}; renamed to ${updateSchool.name}; old name reused by ${again.createSchool.school_id}`);
});
