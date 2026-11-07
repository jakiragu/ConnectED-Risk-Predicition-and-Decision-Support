import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * The web client's own promotion documents (src/api/operations.js), executed
 * through the real GraphQL schema and the local resolver map, against an
 * in-process DynamoDB. Static validation proves the documents ask for fields
 * that exist; this proves the services return every field the schema says is
 * non-null, in the shape the pages read.
 *
 *   npm run test:store
 */
const SCHOOL = 'sch_promo_gql';
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
let schema;
let ops;
let decisionOps;
let classOps;
let graphql;
let keys;
let ddb;
let Put;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.DDB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.EVENTS_ENDPOINT = 'http://127.0.0.1:9';
  process.env.GRADEBOOK_TABLE_NAME = 'promotion_gql_test';
  process.env.AWS_REGION = 'eu-west-1';

  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  ({ PutCommand: Put } = await import('@aws-sdk/lib-dynamodb'));
  ({ ddb } = await import('../../backend/library/client.js'));
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
  ops = await import('../../src/api/operations.js');
  decisionOps = await import('../../src/api/decisionOperations.js');
  classOps = await import('../../src/api/classOperations.js');
  await seed();
});

after(() => new Promise((r) => server.close(r)));

const put = (Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(SCHOOL), school_id: SCHOOL, ...Item } }));

async function run(document, variables) {
  const res = await graphql.execute({
    schema,
    document: graphql.parse(document),
    variableValues: variables,
    contextValue: { identity: { sub: 'u_admin', claims: { 'custom:school_id': SCHOOL, email: 'admin@test' }, groups: [] } },
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => `${e.path?.join('.') ?? ''}: ${e.message}`).join(' | '));
  return res.data;
}

async function seed() {
  await put({ SK: keys.sk.school(), entity: 'School', name: 'GraphQL Test School' });
  // The school's forms and streams, as saved in Settings, Classes: promotion reads its order from here.
  await put({ SK: keys.sk.classSetup(), entity: 'ClassSetup', forms: ['Form 1', 'Form 2', 'Form 3', 'Form 4'], streams: ['East', 'West'], _version: 1 });
  for (const n of [1, 2, 3]) {
    await put({
      SK: keys.sk.term(`term_2026_${n}`), entity: 'Term', term_id: `term_2026_${n}`, name: `Term ${n} 2026`, academic_year: 2026, term_number: n,
      start_date: `2026-0${n * 3 - 2}-05`, end_date: `2026-0${n * 3}-25`,
    });
  }
  await put({ SK: keys.sk.teacher('u_admin'), entity: 'Teacher', teacher_id: 'u_admin', first_name: 'Ada', last_name: 'Admin', role: 'Admin', status: 'ACTIVE', assignments: [], _version: 1 });
  for (const [id, grade] of [['c3', 'Form 3'], ['c4', 'Form 4']]) {
    await put({ SK: keys.sk.klass(id), entity: 'Class', class_id: id, name: `${grade} West`, grade, stream: 'West', year: 2026, status: 'CURRENT', _version: 1 });
    await put({
      SK: keys.sk.resultSet('term_2026_3', id, 'ENDTERM'), entity: 'ResultSet', term_id: 'term_2026_3', class_id: id, checkpoint: 'ENDTERM',
      status: 'PUBLISHED', subjects: ['Mathematics'], calculation_id: `calc_${id}`, published_at: '2026-11-20T10:00:00Z',
    });
  }
  for (const [id, classId, avg] of [['s1', 'c3', 61], ['s2', 'c3', 48], ['s4', 'c4', 72]]) {
    await put({
      SK: keys.sk.termResult('term_2026_3', classId, 'ENDTERM', `calc_${classId}`, id), entity: 'TermResult',
      student_id: id, class_id: classId, term_id: 'term_2026_3', checkpoint: 'ENDTERM', checkpoint_average: avg, term_average: avg, kind: 'FINAL', subjects: [{ subject: 'Mathematics', term: { term_score: avg, weight_applied: 100 } }],
    });
  }
  for (const [id, classId] of [['s1', 'c3'], ['s2', 'c3'], ['s4', 'c4']]) {
    await put({ SK: keys.sk.student(id), entity: 'Student', student_id: id, class_id: classId, admission_no: `A${id.slice(1)}`, first_name: id, last_name: 'Pupil', status: 'ACTIVE', _version: 1 });
  }
  // A published 2026 result for the graduate, so their profile lists 2026.
  await put({
    SK: keys.sk.studentResult('s4', 'term_2026_3', 'ENDTERM', 'c4'), entity: 'StudentResult', student_id: 's4', class_id: 'c4',
    term_id: 'term_2026_3', academic_year: 2026, checkpoint: 'ENDTERM', published_at: '2026-11-20T10:00:00Z', subjects: [],
  });
}

tc({
  id: 'TC-Y12', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'Black box, interface',
  scenario: "The web client's promotion documents run end to end through the GraphQL schema",
  data: 'PLAN_PROMOTION with one override, APPLY_PROMOTION, LIST_PROMOTION_RUNS, LIST_PAST_STUDENTS, LIST_SCHOOL_CLASSES, the risk profile of a graduate, the archived class profile, the dashboard, REVERT_PROMOTION',
  expected: 'Every document returns without errors and every non-null field is filled; the graduate profile lists 2026 and shows the student as graduated; the archived class profile still counts its 2 students of 2026; the dashboard moves to 2027 and counts only its classes',
}, async (ev) => {
  const { planPromotion: plan } = await run(ops.PLAN_PROMOTION, { school_id: SCHOOL, from_year: 2026, overrides: [{ student_id: 's2', action: 'LEAVE' }] });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.classes.length, 2);
  assert.ok(plan.choices.every((c) => typeof c.key === 'string' && Number.isInteger(c.level)));
  assert.equal(plan.classes[0].students.find((s) => s.student_id === 's2').action, 'LEAVE');
  const { planPromotion: reset } = await run(ops.PLAN_PROMOTION, { school_id: SCHOOL, from_year: 2026, overrides: [] });
  const resetStudent = reset.classes[0].students.find((s) => s.student_id === 's2');
  assert.deepEqual([resetStudent.action, resetStudent.default_action, resetStudent.overridden, resetStudent.override_reason], ['REPEAT', 'REPEAT', false, null]);
  assert.equal(resetStudent.to_class_name, 'Form 3 West 2027');

  const { applyPromotion: applied } = await run(ops.APPLY_PROMOTION, {
    input: { school_id: SCHOOL, from_year: 2026, overrides: [{ student_id: 's2', action: 'LEAVE' }], copy_teachers: true, review_token: plan.review_token, idempotency_key: 'gql-apply-000001' },
  });
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.can_revert, true);

  const { listPromotionRuns } = await run(ops.LIST_PROMOTION_RUNS, { school_id: SCHOOL });
  assert.equal(listPromotionRuns.length, 1);

  const { listPastStudents } = await run(ops.LIST_PAST_STUDENTS, { school_id: SCHOOL });
  assert.deepEqual(listPastStudents.map((s) => [s.student_id, s.status, s.class_name]).sort(),
    [['s2', 'INACTIVE', 'Form 3 West 2026'], ['s4', 'GRADUATED', 'Form 4 West 2026']]);

  const { listSchoolClasses } = await run(ops.LIST_SCHOOL_CLASSES, { school_id: SCHOOL });
  const archived = listSchoolClasses.find((c) => c.class_id === 'c4');
  assert.deepEqual([archived.status, archived.student_count], ['PAST', 1], 'an archived class counts the graduate it holds');
  assert.ok(listSchoolClasses.some((c) => c.name === 'Form 4 West' && c.year === 2027 && c.status === 'CURRENT'));

  const { getStudentRiskProfile: profile } = await run(decisionOps.GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: 's4', academic_year: 2026 });
  assert.equal(profile.student.status, 'GRADUATED');
  assert.equal(profile.student.graduation_year, 2026);
  assert.ok(profile.available_years.includes(2026));
  assert.equal(profile.year_class_name, 'Form 4 West 2026');

  // The archived Form 3 West still shows the students it had in 2026, though they moved up or left.
  const { getClassProfile: archivedProfile } = await run(classOps.GET_CLASS_PROFILE, { school_id: SCHOOL, class_id: 'c3', term_id: 'term_2026_3', checkpoint: 'ENDTERM' });
  assert.equal(archivedProfile.student_count, 2);

  // Today (Nov 2026) the calendar year is 2026, but 2026 is closed: the dashboard shows 2027's classes only.
  const { getRiskDashboard: dash } = await run(decisionOps.GET_RISK_DASHBOARD, { school_id: SCHOOL });
  assert.equal(dash.academic_year, 2027);
  assert.deepEqual([dash.classes, dash.students], [1, 1]);

  const { revertPromotion } = await run(ops.REVERT_PROMOTION, { input: { school_id: SCHOOL, run_id: applied.run_id } });
  assert.equal(revertPromotion.status, 'REVERTED');
  ev(`applied ${JSON.stringify(applied.summary)}; graduate profile years ${profile.available_years.join(',')}; reverted`);
});
