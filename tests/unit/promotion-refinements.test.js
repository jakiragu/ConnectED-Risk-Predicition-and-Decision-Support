import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan, levelsFromForms, planTeachers } from '../../backend/library/promotion.js';
import { canReadClass, canWriteSubject, visibleSubjects } from '../../backend/library/authz.js';

const result = (average, extra = {}) => ({ kind: 'FINAL', term_average: average, subjects: [{ subject: 'Maths', term: { term_score: average, weight_applied: 100 } }], ...extra });
const klass = (grade, id = grade) => ({ class_id: id, name: `${grade} East`, grade, stream: 'East', year: 2026, status: 'CURRENT' });
function plan(grade = 'Form 2', averages = [49, 50, 51], extra = {}) {
  const c = klass(grade);
  const students = averages.map((a, i) => ({ student_id: `s${i}`, admission_no: String(i), first_name: 'Student', last_name: String(i), status: 'ACTIVE' }));
  return buildPlan({ fromYear: 2026, classes: [c], ladder: levelsFromForms([grade]), studentsByClass: new Map([[c.class_id, students]]), term3: { term_id: 't3' }, term3Sets: [{ class_id: c.class_id, checkpoint: 'ENDTERM', status: 'PUBLISHED', calculation_id: 'calc', subjects: ['Maths'] }], finalRows: new Map([[c.class_id, new Map(students.map((s, i) => [s.student_id, result(averages[i])]))]]), ...extra });
}
test('below, equal and above school pass mark; final-form failure repeats', () => {
  for (const grade of ['Form 2', 'Form 4', 'Grade 10', 'Grade 12']) {
    const p = plan(grade);
    assert.deepEqual(p.blockers, []);
    const final = ['Form 4', 'Grade 12'].includes(grade);
    assert.deepEqual(p.moves.map((m) => m.action), ['REPEAT', final ? 'GRADUATE' : 'PROMOTE', final ? 'GRADUATE' : 'PROMOTE']);
    assert.equal(p.classes[0].students[0].to_class_name, `${grade} East 2027`);
  }
  assert.deepEqual(plan('Form 2', [59, 60, 61], { passMark: 60 }).moves.map((m) => m.action), ['REPEAT', 'PROMOTE', 'PROMOTE']);
  assert.equal(plan('Form 2', [0], { passMark: 0 }).moves[0].action, 'PROMOTE');
});
test('missing, nonnumeric, out-of-range, incomplete and partial final results block even with override', () => {
  for (const bad of [undefined, result(null), result('60'), result(NaN), result(Infinity), result(-1), result(101), result(60, { subjects: [] }), result(60, { kind: 'PROVISIONAL' }), result(60, { subjects: [{ subject: 'Maths', missing_count: 1, term: { term_score: 60, weight_applied: 100 } }] }), result(60, { subjects: [{ subject: 'Maths', term: { term_score: 60, weight_applied: 80 } }] })]) {
    const p = plan('Form 2', [60], { finalRows: new Map([['Form 2', new Map([['s0', bad]])]]), overrides: [{ student_id: 's0', action: 'PROMOTE' }] });
    assert.ok(p.blockers.some((b) => b.code === 'INVALID_FINAL_RESULT'));
    assert.equal(p.moves[0].automatic_action, null);
  }
});
test('independent explicit pathways fill intermediate levels and never infer a terminal from current classes', () => {
  const ladder = levelsFromForms(['Form 4', 'Grade 10']);
  assert.deepEqual(ladder.levels, ['Form 1', 'Form 2', 'Form 3', 'Form 4', 'Grade 10', 'Grade 11', 'Grade 12']);
  assert.deepEqual([...ladder.finals], [4, 7]);
  assert.equal(plan('Grade 10').classes[0].destination.grade, 'Grade 11');
  assert.equal(plan('Form 2', [60], { ladder: levelsFromForms(['Form 2', 'Form 4']) }).classes[0].destination.grade, 'Form 3');
  assert.ok(plan('Grade 10', [60], { ladder: levelsFromForms([], ['FORM']) }).blockers.some((b) => b.code === 'UNKNOWN_LEVEL'));
});
test('overrides retain original decisions and reasons, including failing final students graduating by exception', () => {
  const p = plan('Form 4', [42, 70], { overrides: [{ student_id: 's0', action: 'GRADUATE', reason: 'Panel decision' }, { student_id: 's1', action: 'REPEAT' }] });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.moves.map((m) => [m.automatic_action, m.action, m.overridden]), [['REPEAT', 'GRADUATE', true], ['GRADUATE', 'REPEAT', true]]);
  assert.equal(p.moves[0].override_reason, 'Panel decision');
  assert.equal(plan('Form 2', [42], { overrides: [{ student_id: 's0', action: 'REPEAT' }] }).moves[0].overridden, false);
});
test('stay, follow split cohorts, manual, conflict exclusion and graduating teachers', () => {
  const teachers = [{ teacher_id: 't', first_name: 'T', last_name: 'One', assignments: [{ class_id: 'Form 2', subject: 'Maths' }], class_teacher_of: 'Form 2' }];
  for (const strategy of ['STAY', 'FOLLOW', 'MANUAL']) {
    const p = plan('Form 2', [42, 60], { teacherStrategy: strategy });
    const preview = planTeachers(p, teachers, [klass('Form 2')], strategy);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.rows[0].assignments.length, strategy === 'FOLLOW' ? 2 : strategy === 'STAY' ? 1 : 0);
    assert.equal(preview.rows[0].class_key, strategy === 'FOLLOW' ? '3|east' : strategy === 'STAY' ? '2|east' : null);
  }
  const p = plan('Form 2');
  const conflicting = [...teachers, { ...teachers[0], teacher_id: 't2' }];
  assert.ok(planTeachers(p, conflicting, [klass('Form 2')], 'FOLLOW').blockers.length);
  assert.deepEqual(planTeachers(p, conflicting, [klass('Form 2')], 'FOLLOW', ['t2']).blockers, []);
  const finalTeachers = [{ ...teachers[0], assignments: [{ class_id: 'Form 4', subject: 'Maths' }], class_teacher_of: 'Form 4' }];
  const final = planTeachers(plan('Form 4', [60]), finalTeachers, [klass('Form 4')], 'FOLLOW');
  assert.equal(final.rows[0].class_key, null);
  assert.equal(final.rows[0].assignments.length, 0);
});
test('former class teachers retain read access without gaining write permissions', () => {
  const actor = { groups: ['Teacher'], access: { assignments: [], classTeacherOf: 'new', historicalClassTeacherOf: ['old'] } };
  assert.equal(canReadClass(actor, 'old'), true);
  assert.equal(visibleSubjects(actor, 'old'), null);
  assert.equal(canWriteSubject(actor, 'old', 'Maths'), false);
});
