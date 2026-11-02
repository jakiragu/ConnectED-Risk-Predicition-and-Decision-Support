import assert from 'node:assert/strict';
import {
  GET_RISK_DASHBOARD, GET_SCHOOL_RISK_OVERVIEW, GET_STUDENT_RISK_PROFILE, LIST_STUDENT_INTERVENTIONS, SAVE_INTERVENTION,
} from '../../src/api/decisionOperations.js';
import { GET_CLASS_ROSTER } from '../../src/api/operations.js';
import { ulid } from '../../backend/library/ids.js';
import { as, CLASS, SCHOOL } from '../helpers/api.js';
import { refused, tc } from '../helpers/harness.js';

/**
 * NFR-1, verified by access-control testing as the requirement states.
 *
 * The matrix below is the test: every role is tried against every protected
 * action, and both the permitted and the refused outcomes are asserted. A
 * refusal must come from the service, not from the interface hiding a button,
 * so each case calls the API directly.
 */
const TERM = process.env.TEST_TERM || 'term_2026_2';
const student = async () => (await as('john', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: CLASS })).getClassRoster[0].student_id;

tc({
  id: 'TC-A01', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, authorisation',
  scenario: 'An unauthenticated request asks for a student risk profile',
  data: 'no bearer token',
  expected: 'The request is refused as unauthenticated and no profile data is returned',
}, async (ev) => {
  const id = await student();
  const e = await refused(() => as('anonymous', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: id }));
  assert.ok(['Unauthorized', 'UnauthorizedException'].includes(e.errorType), `got ${e.errorType}`);
  ev(`refused with ${e.errorType}`);
});

tc({
  id: 'TC-A02', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, authorisation matrix',
  scenario: 'Each role opens the risk profile of a student in the test class',
  data: 'class teacher (jane), subject teacher in that class (peter), teacher of another class only (zama is class teacher elsewhere but teaches CRE here), administrator (john)',
  expected: 'The class teacher and the administrator see every factor; a subject teacher sees only the subjects they teach there',
}, async (ev) => {
  const id = await student();
  const rows = [];
  for (const who of ['jane', 'peter', 'zama', 'john']) {
    const p = (await as(who, GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: id })).getStudentRiskProfile;
    rows.push(`${who}: all=${p.scope.all} factors=[${p.scope.factors.join(',')}]`);
    if (who === 'jane' || who === 'john') assert.equal(p.scope.all, true);
    if (who === 'peter') {
      assert.equal(p.scope.all, false);
      assert.deepEqual([...p.scope.factors].sort(), ['English', 'Mathematics']);
      assert.ok(p.performance_trend.every((r) => r.average === null), 'a subject teacher must not see the class average');
    }
  }
  ev(rows.join(' | '));
});

tc({
  id: 'TC-A03', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A teacher with no assignment in a class opens a profile from that class',
  data: 'peter.otieno opens a student of a class he does not teach',
  expected: 'The request is refused and no profile is returned',
}, async (ev) => {
  const other = (await as('john', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: 'cls_f2east' })).getClassRoster[0];
  const e = await refused(() => as('peter', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: other.student_id }), 'Forbidden');
  ev(`refused with ${e.errorType}: ${e.message}`);
});

tc({
  id: 'TC-A04', requirement: 'NFR-1 / FR-12', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A subject teacher records an intervention outside the subject they teach',
  data: 'peter.otieno logs against Kiswahili and against Attendance',
  expected: 'Both are refused; only his own subjects may be recorded',
}, async (ev) => {
  const id = await student();
  const input = (factor) => ({
    school_id: SCHOOL, student_id: id, intervention_id: ulid(), factor, method: 'Access control probe',
    frequency: 'ONCE', status: 'ONGOING', started_on: new Date().toISOString().slice(0, 10),
  });
  const a = await refused(() => as('peter', SAVE_INTERVENTION, { input: input('Kiswahili') }), 'Forbidden');
  const b = await refused(() => as('peter', SAVE_INTERVENTION, { input: input('Attendance') }), 'Forbidden');
  const ok = (await as('peter', SAVE_INTERVENTION, { input: input('English') })).saveIntervention;
  ev(`Kiswahili ${a.errorType}, Attendance ${b.errorType}, own subject English accepted (${ok.intervention_id})`);
});

tc({
  id: 'TC-A05', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, authorisation',
  scenario: 'A teacher opens the school-wide risk overview',
  data: 'jane.doe, then john.man',
  expected: 'The teacher is refused; the administrator is allowed',
}, async (ev) => {
  const e = await refused(() => as('jane', GET_SCHOOL_RISK_OVERVIEW, { school_id: SCHOOL }), 'Forbidden');
  const o = (await as('john', GET_SCHOOL_RISK_OVERVIEW, { school_id: SCHOOL })).getSchoolRiskOverview;
  assert.ok(Array.isArray(o.classes));
  ev(`teacher ${e.errorType}; administrator saw ${o.classes.length} classes`);
});

tc({
  id: 'TC-A06', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, tenant isolation',
  scenario: 'A signed-in user asks for data belonging to another school',
  data: 'jane.doe passes a different school_id',
  expected: 'The request is refused as outside her school',
}, async (ev) => {
  const e = await refused(() => as('jane', GET_RISK_DASHBOARD, { school_id: 'sch_other_school' }), 'Forbidden');
  ev(`refused with ${e.errorType}: ${e.message}`);
});

const ME = `
  query Me($school_id: ID!) { me(school_id: $school_id) { assignments { class_id subject } class_teacher_of } }`;

tc({
  id: 'TC-A07', requirement: 'NFR-1', level: 'Integration', technique: 'Black box, scoping',
  scenario: 'The teacher dashboard covers exactly the classes the teacher works in',
  data: 'jane.doe (class teacher of cls_test, and assigned to other classes for Kiswahili) and john.man (administrator)',
  expected: 'The classes on jane.doe\'s dashboard are exactly the classes she is assigned to or is class teacher of, which are fewer than the administrator\'s; every at-risk student listed belongs to one of them',
}, async (ev) => {
  const me = (await as('jane', ME, { school_id: SCHOOL })).me;
  const mine = new Set([...me.assignments.map((a) => a.class_id), me.class_teacher_of].filter(Boolean));
  const seen = (await as('jane', GET_RISK_DASHBOARD, { school_id: SCHOOL })).getRiskDashboard;
  const all = (await as('john', GET_RISK_DASHBOARD, { school_id: SCHOOL })).getRiskDashboard;
  assert.equal(seen.classes, mine.size, `the dashboard covers ${seen.classes} classes but she works in ${mine.size}`);
  assert.ok(seen.classes < all.classes && seen.students < all.students, 'the teacher dashboard is not narrower than the administrator\'s');
  const outside = seen.at_risk_students.filter((c) => !mine.has(c.student.class_id)).map((c) => c.student.class_id);
  assert.deepEqual(outside, [], 'the dashboard lists students from a class she does not work in');
  ev(`jane works in ${mine.size} classes and her dashboard covers ${seen.classes} (${seen.students} students); administrator ${all.classes} classes, ${all.students} students; ${seen.at_risk_students.length} at-risk rows checked`);
});

tc({
  id: 'TC-A08', requirement: 'NFR-1 / FR-12', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A teacher reads the intervention history of a student in a class they do not teach',
  data: 'peter.otieno asks for the interventions of a student in cls_f2east',
  expected: 'The request is refused and no intervention is returned',
}, async (ev) => {
  const other = (await as('john', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: 'cls_f2east' })).getClassRoster[0];
  const e = await refused(() => as('peter', LIST_STUDENT_INTERVENTIONS, { school_id: SCHOOL, student_id: other.student_id }), 'Forbidden');
  ev(`refused with ${e.errorType}: ${e.message}`);
});

const SCHOOL_CLASSES = `
  query ListSchoolClasses($school_id: ID!) { listSchoolClasses(school_id: $school_id) { class_id name student_count } }`;
const firstStudent = async (class_id) =>
  (await as('john', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id })).getClassRoster[0];
const intervention = (student_id, factor) => ({
  school_id: SCHOOL, student_id, intervention_id: ulid(), factor, method: 'Access control probe',
  frequency: 'ONCE', status: 'ONGOING', started_on: new Date().toISOString().slice(0, 10),
});

tc({
  id: 'TC-A09', requirement: 'NFR-1 / FR-12', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A teacher records an intervention for a student in a class they have no assignment in',
  data: 'jane.doe saves a Kiswahili (her own subject) intervention for a student in a class that is not among the classes she is assigned to or class teacher of',
  expected: 'The save is refused as Forbidden and nothing is stored for that student',
}, async (ev, t) => {
  const me = (await as('jane', ME, { school_id: SCHOOL })).me;
  const mine = new Set([...me.assignments.map((a) => a.class_id), me.class_teacher_of].filter(Boolean));
  const all = (await as('john', SCHOOL_CLASSES, { school_id: SCHOOL })).listSchoolClasses;
  const outside = all.find((c) => !mine.has(c.class_id) && c.student_count > 0)?.class_id;
  if (!outside) { const why = `jane works in all ${all.length} classes that have students; there is no class outside her assignments to test against`; ev(why); t.skip(why); return; }
  const student = await firstStudent(outside);
  const probe = intervention(student.student_id, 'Kiswahili');
  const e = await refused(() => as('jane', SAVE_INTERVENTION, { input: probe }), 'Forbidden');
  const list = (await as('john', LIST_STUDENT_INTERVENTIONS, { school_id: SCHOOL, student_id: student.student_id })).listStudentInterventions;
  assert.ok(!list.some((i) => i.intervention_id === probe.intervention_id), 'the refused intervention was stored anyway');
  ev(`${outside} is not one of her ${mine.size} classes; refused with ${e.errorType}: ${e.message}; nothing stored`);
});

tc({
  id: 'TC-A10', requirement: 'NFR-1 / FR-12', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A subject teacher records an Attendance intervention in a class where they are not the class teacher',
  data: 'jane.doe, in a class she is assigned to for Kiswahili but is not class teacher of; Attendance is reserved for the class teacher and administrators',
  expected: 'The save is refused as Forbidden',
}, async (ev, t) => {
  const me = (await as('jane', ME, { school_id: SCHOOL })).me;
  const target = me.assignments.map((a) => a.class_id).find((c) => c !== me.class_teacher_of);
  if (!target) { const why = 'jane is assigned to no class other than the one she is class teacher of'; ev(why); t.skip(why); return; }
  const student = await firstStudent(target);
  const e = await refused(() => as('jane', SAVE_INTERVENTION, { input: intervention(student.student_id, 'Attendance') }), 'Forbidden');
  ev(`in ${target} (class teacher is someone else) refused with ${e.errorType}: ${e.message}`);
});
