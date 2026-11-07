import assert from 'node:assert/strict';
import { tc } from '../helpers/harness.js';
import { ACTION, BLOCKER, buildPlan, destinationKey, formsForSchool, levelOfGrade, levelsFromForms, teacherChanges } from '../../backend/library/promotion.js';

/**
 * Year-end promotion rules (operational extension EXT-PROMO), tested without a database.
 * A small school: Form 3 East and Form 4 East in 2026, Term 3 End of term published for both.
 */
const LEVELS = ['Form 1', 'Form 2', 'Form 3', 'Form 4'];
const cls = (id, grade, stream, year, extra = {}) => ({ class_id: id, name: `${grade} ${stream}`, grade, stream, year, status: 'CURRENT', ...extra });
const stu = (id, classId, extra = {}) => ({ student_id: id, class_id: classId, admission_no: id.replace('s', ''), first_name: id, last_name: 'X', status: 'ACTIVE', ...extra });

const f3 = cls('c3', 'Form 3', 'East', 2026, { class_teacher_id: 't3' });
const f4 = cls('c4', 'Form 4', 'East', 2026);
const term3 = { term_id: 'term_2026_3', academic_year: 2026, term_number: 3 };
const published = (...ids) => ids.map((class_id) => ({ class_id, checkpoint: 'ENDTERM', status: 'PUBLISHED', subjects: ['Mathematics'] }));

function school({ classes = [f3, f4], students, sets = published('c3', 'c4'), overrides = [], t3 = term3 } = {}) {
  const all = students || [stu('s1', 'c3'), stu('s2', 'c3'), stu('s3', 'c3', { status: 'INACTIVE' }), stu('s4', 'c4'), stu('s5', 'c4')];
  const byClass = new Map();
  for (const s of all) byClass.set(s.class_id, [...(byClass.get(s.class_id) || []), s]);
  const finalRows = new Map([...byClass].map(([id, rows]) => [id, new Map(rows.map((s) => [s.student_id, { kind: 'FINAL', term_average: 60, subjects: [{ subject: 'Mathematics', term: { term_score: 60, weight_applied: 100 } }] }]))]));
  return buildPlan({ finalRows, fromYear: 2026, ladder: levelsFromForms(LEVELS), classes, studentsByClass: byClass, term3: t3, term3Sets: sets, overrides });
}

tc({
  id: 'TC-Y01', requirement: 'EXT-PROMO', level: 'Unit', technique: 'Black box, equivalence classes',
  scenario: 'Default plan for a year: lower forms move up, the final form graduates',
  data: 'Form 3 East (2 active, 1 deactivated) and Form 4 East (2 active) in 2026; Term 3 End of term published for both',
  expected: 'Form 3 students PROMOTE to Form 4 East 2027 (to be created); Form 4 students GRADUATE; deactivated students are left out; no blockers',
}, (ev) => {
  const plan = school();
  assert.deepEqual(plan.blockers, []);
  const [c3, c4] = plan.classes;
  assert.equal(c3.destination.name, 'Form 4 East');
  assert.equal(c3.destination.year, 2027);
  assert.equal(c3.destination.exists, false);
  assert.deepEqual(c3.students.map((s) => s.action), [ACTION.PROMOTE, ACTION.PROMOTE]);
  assert.equal(c3.inactive_count, 1);
  assert.equal(c4.graduating, true);
  assert.equal(c4.destination, null);
  assert.deepEqual(c4.students.map((s) => s.action), [ACTION.GRADUATE, ACTION.GRADUATE]);
  assert.deepEqual(plan.summary, { promote: 2, repeat: 0, graduate: 2, leave: 0, classes_created: 1, classes_archived: 2 });
  ev(`summary ${JSON.stringify(plan.summary)}; destination ${c3.destination.name} ${c3.destination.year}`);
});

tc({
  id: 'TC-Y02', requirement: 'EXT-PROMO', level: 'Unit', technique: 'Black box, boundary',
  scenario: 'A class with unpublished Term 3 End of term results blocks the promotion',
  data: 'Form 3 East published, Form 4 East not; then no Term 3 set up at all',
  expected: 'An UNPUBLISHED blocker names Form 4 East; with no Term 3 a NO_TERM3 blocker is raised',
}, (ev) => {
  const plan = school({ sets: published('c3') });
  assert.deepEqual(plan.blockers.map((b) => [b.code, b.class_id]), [[BLOCKER.UNPUBLISHED, 'c4']]);
  const none = school({ t3: null, sets: [] });
  assert.ok(none.blockers.some((b) => b.code === BLOCKER.NO_TERM3));
  ev(plan.blockers[0].message);
});

tc({
  id: 'TC-Y03', requirement: 'EXT-PROMO', level: 'Unit', technique: 'Black box, decision table',
  scenario: 'Per-student choices are checked against the rules',
  data: 'Repeat s1; s2 leaves; s4 (Form 4) asked to PROMOTE; s5 (Form 4) asked to REPEAT; a Form 3 student asked to GRADUATE',
  expected: 'Valid choices are applied (repeat goes to Form 3 East 2027); promoting or graduating outside the rules is an INVALID_CHOICE blocker',
}, (ev) => {
  const ok = school({ overrides: [
    { student_id: 's1', action: ACTION.REPEAT },
    { student_id: 's2', action: ACTION.LEAVE },
    { student_id: 's5', action: ACTION.REPEAT },
  ] });
  assert.deepEqual(ok.blockers, []);
  const rows = new Map(ok.classes.flatMap((c) => c.students).map((s) => [s.student_id, s]));
  assert.equal(rows.get('s1').to_class_name, 'Form 3 East 2027');
  assert.equal(rows.get('s2').to_key, null);
  assert.equal(rows.get('s5').to_class_name, 'Form 4 East 2027');
  assert.deepEqual(ok.summary, { promote: 0, repeat: 2, graduate: 1, leave: 1, classes_created: 2, classes_archived: 2 });

  const bad = school({ overrides: [{ student_id: 's4', action: ACTION.PROMOTE }, { student_id: 's1', action: ACTION.GRADUATE }] });
  assert.equal(bad.blockers.filter((b) => b.code === BLOCKER.INVALID_CHOICE).length, 2);
  ev(`valid ${JSON.stringify(ok.summary)}; invalid: ${bad.blockers.map((b) => b.message).join(' | ')}`);
});

tc({
  id: 'TC-Y04', requirement: 'EXT-PROMO', level: 'Unit', technique: 'White box, branch coverage',
  scenario: 'Existing next-year classes are reused; a clashing name blocks; an unknown form blocks',
  data: 'Form 4 East 2027 already exists; then a 2027 class named "Form 4 East" with grade "Senior"; then a 2026 class with grade "Year 9"',
  expected: 'The existing class is used (nothing created); the clash gives NAME_TAKEN; the unknown grade gives UNKNOWN_LEVEL',
}, (ev) => {
  const existing = cls('c4n', 'Form 4', 'East', 2027);
  const reuse = school({ classes: [f3, f4, existing] });
  assert.equal(reuse.classes[0].destination.class_id, 'c4n');
  assert.equal(reuse.summary.classes_created, 0);

  const clash = school({ classes: [f3, f4, { ...cls('cx', 'Senior', 'East', 2027), name: 'Form 4 East' }] });
  assert.ok(clash.blockers.some((b) => b.code === BLOCKER.NAME_TAKEN));

  const odd = school({ classes: [f3, f4, cls('c9', 'Year 9', 'North', 2026)], sets: published('c3', 'c4', 'c9') });
  assert.ok(odd.blockers.some((b) => b.code === BLOCKER.UNKNOWN_LEVEL && b.class_id === 'c9'));
  ev(`reused ${reuse.classes[0].destination.name}; clash and unknown level blocked`);
});

tc({
  id: 'TC-Y05', requirement: 'EXT-PROMO', level: 'Unit', technique: 'Black box, equivalence classes',
  scenario: "The promotion order is built from the school's forms in Settings, including a school running two curricula",
  data: 'Forms saved out of order: Grade 11, Form 4, Form 1, Grade 10, Form 3, Form 2, Grade 12, Senior; then no saved forms with classes in "Form 5"',
  expected: 'Form 1 to 4 then Grade 10 to 12 in number order; Form 4 and Grade 12 graduate; an unnumbered form has no place; unsaved forms default to Form 1 to 4 plus any form classes use',
}, (ev) => {
  const { levels, finals } = levelsFromForms(['Grade 11', 'Form 4', 'Form 1', 'Grade 10', 'Form 3', 'Form 2', 'Grade 12', 'Senior']);
  assert.deepEqual(levels, ['Form 1', 'Form 2', 'Form 3', 'Form 4', 'Grade 10', 'Grade 11', 'Grade 12']);
  assert.deepEqual([...finals].map((f) => levels[f - 1]), ['Form 4', 'Grade 12']);
  assert.equal(levelOfGrade('form  3', levels), 3);
  assert.equal(levelOfGrade('Senior', levels), null);
  assert.deepEqual(formsForSchool(null, [{ grade: 'Form 5' }]), ['Form 1', 'Form 2', 'Form 3', 'Form 4', 'Form 5']);
  assert.deepEqual(formsForSchool({ forms: ['Grade 10'] }, [{ grade: 'Form 4' }]), ['Grade 10']);
  assert.equal(destinationKey(4, ' East '), '4|east');

  // In the mixed school, Form 4 graduates while Grade 10 moves up.
  const ladder = levelsFromForms(levels);
  const plan = buildPlan({
    fromYear: 2026, ladder,
    classes: [cls('f4', 'Form 4', 'East', 2026), cls('g10', 'Grade 10', 'East', 2026)],
    studentsByClass: new Map([['f4', [stu('s1', 'f4')]], ['g10', [stu('s2', 'g10')]]]),
    term3, term3Sets: published('f4', 'g10'),
  });
  assert.deepEqual(plan.classes.map((c) => [c.source_name, c.graduating, c.destination?.name ?? null]),
    [['Form 4 East', true, null], ['Grade 10 East', false, 'Grade 11 East']]);
  ev(`order ${levels.join(' > ')}; graduating ${[...finals].map((f) => levels[f - 1]).join(', ')}`);
});

tc({
  id: 'TC-Y06', requirement: 'EXT-PROMO', level: 'Unit', technique: 'Black box, decision table',
  scenario: 'Teacher changes with and without "copy teachers"',
  data: 'Teacher t3: class teacher of Form 3 East, teaches Maths there; Form 3 East goes to new class n4',
  expected: 'With copy: Maths in n4 is added (old assignment kept) and t3 becomes class teacher of n4. Without: no assignment added and t3 stops being class teacher of the archived class',
}, (ev) => {
  const teachers = [{ teacher_id: 't3', assignments: [{ class_id: 'c3', subject: 'Mathematics' }], class_teacher_of: 'c3', _version: 4 }];
  const args = { teachers, sourceIds: new Set(['c3', 'c4']), mainDestination: new Map([['c3', 'n4']]) };
  const [copy] = teacherChanges({ ...args, copyTeachers: true });
  assert.deepEqual(copy.after.assignments, [{ class_id: 'c3', subject: 'Mathematics' }, { class_id: 'n4', subject: 'Mathematics' }]);
  assert.equal(copy.after.class_teacher_of, 'n4');
  assert.equal(copy.before._version, 4);
  const [plain] = teacherChanges({ ...args, copyTeachers: false });
  assert.deepEqual(plain.after.assignments, teachers[0].assignments);
  assert.equal(plain.after.class_teacher_of, null);
  const [taken] = teacherChanges({ ...args, copyTeachers: true, takenClassTeachers: new Set(['n4']) });
  assert.equal(taken.after.class_teacher_of, null);
  ev(`copy -> class teacher of ${copy.after.class_teacher_of}; no copy -> ${plain.after.class_teacher_of}`);
});
