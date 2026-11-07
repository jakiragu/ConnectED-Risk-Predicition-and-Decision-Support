import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import dynalite from 'dynalite';
import { tc, refused } from '../helpers/harness.js';

/**
 * Year-end promotion (EXT-PROMO) through the school service, against an
 * in-process DynamoDB (dynalite), so it runs without Docker. Every promotion
 * write is a single conditional update, which dynalite supports; nothing here
 * needs transactions.
 *
 *   npm run test:store
 *
 * The school: Form 3 East and Form 4 East in 2026, Term 3 End of term published
 * for Form 3 East only at first. Teacher Tess is Form 3 East's class teacher and
 * teaches Mathematics there; student s1 has an ongoing intervention.
 */
const SCHOOL = 'sch_promo_test';
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
let svc;
let keys;
let ddb;
let Put;
let Get;
let Query;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.DDB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.EVENTS_ENDPOINT = 'http://127.0.0.1:9'; // nothing listens: announcing fails fast and is only logged
  process.env.GRADEBOOK_TABLE_NAME = 'promotion_store_test';
  process.env.AWS_REGION = 'eu-west-1';

  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const lib = await import('@aws-sdk/lib-dynamodb');
  ({ PutCommand: Put, GetCommand: Get, QueryCommand: Query } = lib);
  ({ ddb } = await import('../../backend/library/client.js'));
  const { TABLE_DEFINITION } = await import('../../infra/table-definition.js');
  const { StreamSpecification, ...table } = TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  keys = await import('../../backend/library/keys.js');
  svc = await import('../../backend/lambdas/school-service/handler.js');
  await seed();
});

after(() => new Promise((r) => server.close(r)));

const put = (Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(SCHOOL), school_id: SCHOOL, ...Item } }));
const get = async (SK) => (await ddb.send(new Get({ TableName: keys.TABLE, Key: { PK: keys.pk(SCHOOL), SK } }))).Item;
const prefix = async (p) => (await ddb.send(new Query({
  TableName: keys.TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)', ExpressionAttributeValues: { ':p': keys.pk(SCHOOL), ':s': p },
}))).Items;

const event = (fieldName, args, sub = 'u_admin') => ({
  identity: { sub, claims: { 'custom:school_id': SCHOOL, email: `${sub}@test` }, groups: [] },
  info: { fieldName },
  arguments: args,
});
// Called directly, the handler throws ServiceError with .type; through GraphQL that arrives as errorType.
const call = (field, args, sub) => svc.handler(event(field, args, sub)).catch((e) => {
  if (e.type && !e.errorType) e.errorType = e.type;
  throw e;
});
const asAdmin = async (field, args) => {
  if (field === 'applyPromotion' && !args.input.review_token) {
    const plan = await call('planPromotion', { ...args.input, teacher_strategy: args.input.teacher_strategy ?? (args.input.copy_teachers === false ? 'MANUAL' : 'FOLLOW') }, 'u_admin');
    args = { input: { ...args.input, review_token: plan.review_token } };
  }
  return call(field, args, 'u_admin');
};

const published = async (classId) => {
  await put({
  SK: keys.sk.resultSet('term_2026_3', classId, 'ENDTERM'), entity: 'ResultSet',
  term_id: 'term_2026_3', class_id: classId, checkpoint: 'ENDTERM', status: 'PUBLISHED', calculation_id: 'calc', subjects: ['Mathematics'],
  });
  for (const s of (await prefix('STUDENT#')).filter((s) => s.class_id === classId)) await put({
    SK: keys.sk.termResult('term_2026_3', classId, 'ENDTERM', 'calc', s.student_id), entity: 'TermResult', student_id: s.student_id, kind: 'FINAL', term_average: 60,
    subjects: [{ subject: 'Mathematics', term: { term_score: 60, weight_applied: 100 } }],
  });
};

async function seed() {
  await put({ SK: keys.sk.school(), entity: 'School', name: 'Promotion Test School' });
  // The school's forms and streams, as saved in Settings, Classes: promotion reads its order from here.
  await put({ SK: keys.sk.classSetup(), entity: 'ClassSetup', forms: ['Form 1', 'Form 2', 'Form 3', 'Form 4'], streams: ['East', 'West'], _version: 1 });
  await put({ SK: keys.sk.term('term_2026_3'), entity: 'Term', term_id: 'term_2026_3', academic_year: 2026, term_number: 3, start_date: '2026-09-01', end_date: '2026-11-20' });
  await put({ SK: keys.sk.teacher('u_admin'), entity: 'Teacher', teacher_id: 'u_admin', first_name: 'Ada', last_name: 'Admin', role: 'Admin', status: 'ACTIVE', assignments: [], _version: 1 });
  await put({
    SK: keys.sk.teacher('u_tess'), entity: 'Teacher', teacher_id: 'u_tess', first_name: 'Tess', last_name: 'Teacher', role: 'Teacher', status: 'ACTIVE',
    assignments: [{ class_id: 'c3', subject: 'Mathematics' }], class_teacher_of: 'c3', _version: 3,
  });
  for (const [id, grade, teacher] of [['c3', 'Form 3', 'u_tess'], ['c4', 'Form 4', null]]) {
    await put({
      SK: keys.sk.klass(id), entity: 'Class', class_id: id, name: `${grade} East`, grade, stream: 'East', year: 2026, status: 'CURRENT', _version: 1,
      ...(teacher ? { class_teacher_id: teacher } : {}),
    });
  }
  const students = [['s1', 'c3'], ['s2', 'c3'], ['s3', 'c3', 'INACTIVE'], ['s4', 'c4'], ['s5', 'c4']];
  for (const [id, classId, status = 'ACTIVE'] of students) {
    await put({ SK: keys.sk.student(id), entity: 'Student', student_id: id, class_id: classId, admission_no: id.slice(1), first_name: id, last_name: 'Student', status, _version: 1 });
  }
  await put({
    SK: keys.sk.intervention('s1', 'iv1'), GSI1PK: keys.gsi1.pk(SCHOOL, 'c3'), GSI1SK: keys.gsi1.intervention('iv1'), entity: 'Intervention',
    intervention_id: 'iv1', student_id: 's1', class_id: 'c3', factor: 'Mathematics', method: 'Weekly clinic', status: 'ONGOING', started_on: '2026-10-01', _version: 1,
  });
  await published('c3');
}

const student = (id) => get(keys.sk.student(id));
const classesOf = async (year) => (await prefix('CLASS#')).filter((c) => c.year === year);
let runId;

tc({
  id: 'TC-Y07', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'Black box, precondition',
  scenario: 'Promotion is refused while a class has unpublished Term 3 End of term results, and teachers cannot promote',
  data: 'Form 4 East has no published Term 3 End of term results; the request is made by an administrator and by a teacher',
  expected: 'The plan lists an UNPUBLISHED blocker; applying is a ValidationError and writes nothing; a teacher gets Forbidden',
}, async (ev) => {
  const queries = [], send = ddb.send.bind(ddb);
  ddb.send = (command, ...args) => { if (command instanceof Query) queries.push(command.input); return send(command, ...args); };
  let plan;
  try { plan = await asAdmin('planPromotion', { school_id: SCHOOL, from_year: 2026 }); }
  finally { ddb.send = send; }
  assert.deepEqual(plan.blockers.map((b) => b.code), ['UNPUBLISHED']);
  const blockedClass = plan.classes.find((c) => c.source_class_id === 'c4');
  assert.equal(blockedClass.active_count, 2);
  assert.deepEqual(blockedClass.students, [], 'no unpublished student names or rows in response');
  const studentReads = queries.filter((q) => q.ExpressionAttributeValues?.[':s'] === keys.sk.studentPrefix());
  assert.ok(studentReads.length > 0);
  assert.ok(studentReads.every((q) => q.ExpressionAttributeValues[':c']), 'no school-wide roster is loaded');
  assert.ok(studentReads.filter((q) => q.ExpressionAttributeValues[':c'] === 'c4').every((q) => q.Select === 'COUNT'), 'unpublished class queries return counts only');
  await refused(() => asAdmin('applyPromotion', { input: { school_id: SCHOOL, from_year: 2026, copy_teachers: true, idempotency_key: 'key-blocked-0001' } }), 'ValidationError');
  assert.equal(await get(keys.sk.promotionLock(2026)), undefined);
  await refused(() => call('planPromotion', { school_id: SCHOOL, from_year: 2026 }, 'u_tess'), 'Forbidden');
  ev(plan.blockers[0].message);
});

test('fresh published averages, audit, teacher strategies, historical records and stale confirmation', async () => {
  await published('c4');
  const resultKey = (id, classId) => keys.sk.termResult('term_2026_3', classId, 'ENDTERM', 'calc', id);
  const original = await get(resultKey('s1', 'c3'));
  const snapshot = await asAdmin('planPromotion', { school_id: SCHOOL, from_year: 2026, teacher_strategy: 'STAY' });
  await put({ ...original, term_average: 42 });
  const fresh = await asAdmin('planPromotion', { school_id: SCHOOL, from_year: 2026, teacher_strategy: 'STAY' });
  assert.equal(fresh.classes[0].students[0].action, 'REPEAT');
  await refused(() => asAdmin('applyPromotion', { input: { school_id: SCHOOL, from_year: 2026, teacher_strategy: 'STAY', review_token: snapshot.review_token, idempotency_key: 'stale-review-001' } }), 'Conflict');
  assert.equal(await get(keys.sk.promotionLock(2026)), undefined);
  await put({ ...original, term_average: null });
  const invalid = await asAdmin('planPromotion', { school_id: SCHOOL, from_year: 2026, overrides: [{ student_id: 's1', action: 'PROMOTE' }] });
  assert.ok(invalid.blockers.some((b) => b.code === 'INVALID_FINAL_RESULT'));
  await refused(() => asAdmin('applyPromotion', { input: { school_id: SCHOOL, from_year: 2026, overrides: [{ student_id: 's1', action: 'PROMOTE' }], idempotency_key: 'invalid-final-01' } }), 'ValidationError');
  await put({ ...original, term_average: 42 });
  const finalOriginal = await get(resultKey('s4', 'c4'));
  await put({ ...finalOriginal, term_average: 49 });
  const equalOriginal = await get(resultKey('s2', 'c3'));
  await put({ ...equalOriginal, term_average: 50 });
  const readHistory = async () => (await prefix('')).filter((r) => ['ResultSet', 'TermResult', 'Assessment', 'RiskPrediction', 'ReportCard'].includes(r.entity));
  for (const [entity, SK] of [['Assessment', keys.sk.assessment('historical')], ['RiskPrediction', keys.sk.risk(2026, 'T3E', 's1')], ['ReportCard', keys.sk.reportCard('term_2026_3', 'ENDTERM', 's1')]]) await put({ SK, entity, class_id: 'c3', student_id: 's1', content: { untouched: true } });
  const history = await readHistory();
  for (const strategy of ['STAY', 'FOLLOW', 'MANUAL']) {
    const input = { school_id: SCHOOL, from_year: 2026, teacher_strategy: strategy, idempotency_key: `strategy-${strategy}-001`, overrides: [{ student_id: 's1', action: 'PROMOTE', reason: 'Review panel approved progression' }] };
    const p = await asAdmin('planPromotion', input);
    assert.equal(p.classes[0].students.find((s) => s.student_id === 's2').action, 'PROMOTE');
    assert.equal(p.classes[1].students.find((s) => s.student_id === 's4').action, 'REPEAT');
    const r = await asAdmin('applyPromotion', { input: { ...input, review_token: p.review_token } });
    const decision = r.decisions.find((d) => d.student_id === 's1');
    assert.deepEqual([decision.automatic_action, decision.action, decision.overridden_by, decision.override_reason], ['REPEAT', 'PROMOTE', 'u_admin', 'Review panel approved progression']);
    const tess = await get(keys.sk.teacher('u_tess'));
    assert.ok(tess.historical_class_teacher_of.includes('c3'));
    if (strategy === 'MANUAL') assert.equal(tess.class_teacher_of, null);
    else assert.equal((await get(keys.sk.klass(tess.class_teacher_of))).grade, strategy === 'STAY' ? 'Form 3' : 'Form 4');
    assert.equal((await student('s4')).status, 'ACTIVE');
    assert.deepEqual(await readHistory(), history, 'all historical data byte-for-byte unchanged');
    const again = await asAdmin('applyPromotion', { input: { ...input, review_token: p.review_token } });
    assert.equal(again.run_id, r.run_id);
    const promotionRepo = await import('../../backend/library/promotionRepo.js');
    const stored = await promotionRepo.getRun(SCHOOL, r.run_id);
    for (const change of stored.teachers) assert.equal(await promotionRepo.applyTeacherChange(SCHOOL, change, r.run_id), true);
    assert.equal((await get(keys.sk.teacher('u_tess')))._version, tess._version, 'teacher retries do not increment or overwrite the snapshot');
    await asAdmin('revertPromotion', { school_id: SCHOOL, run_id: r.run_id });
    assert.deepEqual(await readHistory(), history);
    assert.deepEqual((await get(keys.sk.teacher('u_tess'))).historical_class_teacher_of, []);
  }
  await put(original);
  await put(finalOriginal);
  await put(equalOriginal);
});

test('permanent departures and temporary deactivation record reasons and dates', async () => {
  const original = await student('s2');
  await refused(() => asAdmin('setStudentStatus', { input: { school_id: SCHOOL, student_id: 's2', status: 'INACTIVE', _version: original._version } }), 'ValidationError');
  for (const kind of ['LEFT', 'TEMPORARY']) {
    await asAdmin('setStudentStatus', { input: { school_id: SCHOOL, student_id: 's2', status: 'INACTIVE', _version: original._version, departure_kind: kind, deactivation_reason: 'Family request', deactivation_date: '2026-11-06' } });
    const past = await asAdmin('listPastStudents', { school_id: SCHOOL, year: 2026 });
    const s = past.find((r) => r.student_id === 's2');
    assert.deepEqual([s.departure_kind, s.deactivation_reason, s.deactivation_date], [kind, 'Family request', '2026-11-06']);
    await put(original);
  }
});

tc({
  id: 'TC-Y08', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'Black box, state transition',
  scenario: 'Applying a promotion moves, graduates, archives, stops interventions and copies teachers; repeating the request is harmless',
  data: 'Both classes published; s2 chosen to repeat; copy teachers on; the same request sent twice, then a new request for 2026',
  expected: 'Form 4 East 2027 and Form 3 East 2027 are created; s1 moves up, s2 repeats, s4/s5 graduate on their class, s3 (deactivated) stays; 2026 classes archived; iv1 stopped; Tess teaches and is class teacher in Form 4 East 2027; the repeat returns the same run; a second promotion of 2026 is a Conflict',
}, async (ev) => {
  await published('c4');
  const input = {
    school_id: SCHOOL, from_year: 2026, copy_teachers: true, idempotency_key: 'key-apply-000001',
    overrides: [{ student_id: 's2', action: 'REPEAT' }],
  };
  const run = await asAdmin('applyPromotion', { input });
  runId = run.run_id;
  assert.equal(run.status, 'APPLIED');
  assert.deepEqual(run.summary, { promote: 1, repeat: 1, graduate: 2, leave: 0, classes_created: 2, classes_archived: 2 });
  assert.equal(run.interventions_stopped, 1);

  const next = await classesOf(2027);
  const f4 = next.find((c) => c.name === 'Form 4 East');
  const f3 = next.find((c) => c.name === 'Form 3 East');
  assert.ok(f4 && f3, 'both 2027 classes exist');
  assert.equal(f4.class_teacher_id, 'u_tess');
  assert.equal((await student('s1')).class_id, f4.class_id);
  assert.equal((await student('s2')).class_id, f3.class_id);
  assert.equal((await student('s3')).class_id, 'c3');
  for (const id of ['s4', 's5']) {
    const s = await student(id);
    assert.deepEqual([s.status, s.graduation_year, s.class_id], ['GRADUATED', 2026, 'c4']);
  }
  const old3 = await get(keys.sk.klass('c3'));
  assert.deepEqual([old3.status, old3.class_teacher_id, old3.former_class_teacher_id, old3.promoted_to_class_id], ['PAST', undefined, 'u_tess', f4.class_id]);
  assert.equal((await get(keys.sk.klass('c4'))).status, 'PAST');
  assert.equal((await get(keys.sk.intervention('s1', 'iv1'))).status, 'STOPPED');
  const tess = await get(keys.sk.teacher('u_tess'));
  assert.equal(tess.class_teacher_of, f4.class_id);
  assert.ok(tess.assignments.some((a) => a.class_id === f4.class_id && a.subject === 'Mathematics'));
  assert.ok(tess.assignments.some((a) => a.class_id === 'c3'), 'the past assignment is kept');

  const again = await asAdmin('applyPromotion', { input });
  assert.equal(again.run_id, run.run_id);
  await refused(() => asAdmin('applyPromotion', { input: { ...input, idempotency_key: 'key-apply-000002' } }), 'Conflict');

  const past = await asAdmin('listPastStudents', { school_id: SCHOOL, year: 2026 });
  assert.deepEqual(past.filter((p) => p.status === 'GRADUATED').map((p) => p.student_id).sort(), ['s4', 's5']);
  await refused(() => asAdmin('setStudentStatus', { input: { school_id: SCHOOL, student_id: 's4', status: 'ACTIVE', _version: 2 } }), 'ValidationError');
  ev(`run ${run.run_id}: ${JSON.stringify(run.summary)}; can_revert=${run.can_revert}`);
});

tc({
  id: 'TC-Y09', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'Black box, state transition',
  scenario: 'Undoing a promotion restores the school year exactly',
  data: 'The run from TC-Y08, before the new year has any records',
  expected: 'Students, classes, the intervention and Tess are back as before; the classes the run created are deleted; 2026 can be promoted again',
}, async (ev) => {
  const run = await asAdmin('revertPromotion', { input: { school_id: SCHOOL, run_id: runId } });
  assert.equal(run.status, 'REVERTED');
  assert.deepEqual((await classesOf(2027)).map((c) => c.name), []);
  for (const [id, classId] of [['s1', 'c3'], ['s2', 'c3'], ['s4', 'c4'], ['s5', 'c4']]) {
    const s = await student(id);
    assert.deepEqual([s.class_id, s.status, s.graduation_year, s.promotion_run_id], [classId, 'ACTIVE', undefined, undefined]);
  }
  const c3 = await get(keys.sk.klass('c3'));
  assert.deepEqual([c3.status, c3.class_teacher_id], ['CURRENT', 'u_tess']);
  assert.equal((await get(keys.sk.intervention('s1', 'iv1'))).status, 'ONGOING');
  const tess = await get(keys.sk.teacher('u_tess'));
  assert.deepEqual([tess.class_teacher_of, tess.assignments.length], ['c3', 1]);
  const plan = await asAdmin('planPromotion', { school_id: SCHOOL, from_year: 2026 });
  assert.equal(plan.run, null);
  assert.deepEqual(plan.blockers, []);
  ev('restored; 2026 promotable again');
});

tc({
  id: 'TC-Y10', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'Black box, boundary',
  scenario: 'Undo is refused once the new year has records',
  data: 'Promote again (no overrides), then add an assessment to Form 4 East 2027',
  expected: 'The run reports can_revert false with the reason; revertPromotion is a ValidationError',
}, async (ev) => {
  const run = await asAdmin('applyPromotion', { input: { school_id: SCHOOL, from_year: 2026, copy_teachers: false, idempotency_key: 'key-apply-000003' } });
  const f4 = (await classesOf(2027)).find((c) => c.name === 'Form 4 East');
  assert.equal(f4.class_teacher_id, undefined, 'without copying, no class teacher is set');
  assert.equal((await get(keys.sk.teacher('u_tess'))).class_teacher_of, null);
  await put({
    SK: keys.sk.assessment('a2027'), GSI1PK: keys.gsi1.pk(SCHOOL, f4.class_id), GSI1SK: keys.gsi1.assessment('term_2027_1', 'a2027'),
    entity: 'Assessment', assessment_id: 'a2027', class_id: f4.class_id,
  });
  const view = await asAdmin('getPromotionRun', { school_id: SCHOOL, run_id: run.run_id });
  assert.equal(view.can_revert, false);
  assert.match(view.revert_blocked_reason, /assessments/);
  await refused(() => asAdmin('revertPromotion', { input: { school_id: SCHOOL, run_id: run.run_id } }), 'ValidationError');
  ev(view.revert_blocked_reason);
});

tc({
  id: 'TC-Y11', requirement: 'EXT-PROMO', level: 'Integration (store)', technique: 'White box, failure recovery',
  scenario: 'An interrupted promotion is finished from what it stored, not re-planned',
  data: 'Promote 2027 into 2028 but stop after the run and its moves are stored (as if the Lambda timed out), then send a new request',
  expected: 'The new request finishes the stored run: same run id, every student moved once, the run APPLIED',
}, async (ev) => {
  // Make 2027 promotable: its Term 3 and published results.
  await put({ SK: keys.sk.term('term_2027_3'), entity: 'Term', term_id: 'term_2027_3', academic_year: 2027, term_number: 3, start_date: '2027-09-01', end_date: '2027-11-20' });
  const next = await classesOf(2027);
  for (const c of next) {
    await put({ SK: keys.sk.resultSet('term_2027_3', c.class_id, 'ENDTERM'), entity: 'ResultSet', term_id: 'term_2027_3', class_id: c.class_id, checkpoint: 'ENDTERM', status: 'PUBLISHED' });
  }
  const repo = await import('../../backend/library/promotionRepo.js');
  const { buildPlan } = await import('../../backend/library/promotion.js');
  const students = (await prefix('STUDENT#')).filter((s) => next.some((c) => c.class_id === s.class_id));
  const plan = buildPlan({
    fromYear: 2027, classes: await prefix('CLASS#'), studentsByClass: new Map(next.map((c) => [c.class_id, students.filter((s) => s.class_id === c.class_id)])),
    term3: { term_id: 'term_2027_3' }, term3Sets: next.map((c) => ({ class_id: c.class_id, checkpoint: 'ENDTERM', status: 'PUBLISHED', subjects: ['Mathematics'] })),
    finalRows: new Map(next.map((c) => [c.class_id, new Map(students.filter((s) => s.class_id === c.class_id).map((s) => [s.student_id, { kind: 'FINAL', term_average: 60, subjects: [{ subject: 'Mathematics', term: { term_score: 60, weight_applied: 100 } }] }]))])),
  });
  assert.deepEqual(plan.blockers, []);
  const stored = {
    run_id: 'prm_interrupted', from_year: 2027, to_year: 2028, status: 'APPLYING', idempotency_key: 'key-lost-0000001', copy_teachers: false,
    summary: plan.summary, sources: plan.classes.map((c) => ({ class_id: c.source_class_id, name: c.source_name, class_teacher_id: null, promoted_to_class_id: null })),
    creates: [], destinations: [], dest_teacher_sets: [], teachers: [], skipped: [], created_by: 'u_admin', created_at: new Date().toISOString(),
  };
  assert.ok(await repo.claimLock(SCHOOL, 2027, stored));
  await repo.saveRun(SCHOOL, stored, plan.moves.map((m) => ({ ...m, to_class_id: null, from_year: 2027 })));

  const finished = await asAdmin('applyPromotion', { input: { school_id: SCHOOL, from_year: 2027, copy_teachers: true, idempotency_key: 'key-retry-000001' } });
  assert.equal(finished.run_id, 'prm_interrupted');
  assert.equal(finished.status, 'APPLIED');
  const graduates = (await prefix('STUDENT#')).filter((s) => s.graduation_year === 2027);
  assert.equal(graduates.length, plan.summary.graduate);
  ev(`finished ${finished.run_id}; ${graduates.length} graduated in 2027`);
});
