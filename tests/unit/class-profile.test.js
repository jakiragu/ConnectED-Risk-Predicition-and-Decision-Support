import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClassProfile, describe, SCOPE } from '../../backend/library/classProfile.js';
import { riskScope } from '../../backend/library/decisionSupport.js';

const bands = [
  { grade: 'A', min_score: 70, max_score: 100 },
  { grade: 'B', min_score: 50, max_score: 69 },
  { grade: 'C', min_score: 0, max_score: 49 },
];
const roster = ['s1', 's2', 's3', 's4'].map((id, i) => ({ student_id: id, first_name: `F${i}`, last_name: `L${i}`, admission_no: `${100 + i}` }));
const subj = (subject, score, extra = {}) => ({ subject, score, absent_count: 0, missing_count: 0, not_assessed_count: 0, ...extra });
const row = (id, avg, maths, chem, extra) => ({ student_id: id, checkpoint_average: avg, subjects: [subj('Mathematics', maths, extra), subj('Chemistry', chem)] });
const rows = new Map([
  ['s1', row('s1', 80, 90, 70)],
  ['s2', row('s2', 55, 40, 70)],
  ['s3', row('s3', 30, 20, 40, { absent_count: 1 })],
  ['s4', row('s4', 60, 60, 60)],
]);
const previous = { checkpoint: 'MIDTERM', rows: new Map([
  ['s1', row('s1', 70, 70, 70)], ['s2', row('s2', 65, 60, 70)], ['s3', row('s3', 35, 30, 40)],
]) };

test('class profile: describe gives mean, median and quartiles', () => {
  assert.deepEqual(describe([1, 2, 3, 4, null]), { count: 4, mean: 2.5, median: 2.5, q1: 1.8, q3: 3.3, min: 1, max: 4 });
  assert.equal(describe([]).mean, null);
});

test('class profile: whole-class summary, distribution, subjects and movement', () => {
  const p = buildClassProfile({ checkpoint: 'MIDTERM', roster, rows, previousRows: previous, rule: { bands, pass_mark: 50 } });
  assert.equal(p.scope, SCOPE.FULL);
  assert.equal(p.summary.mean, 56.3);
  assert.equal(p.summary.pass_rate, 0.75);
  assert.equal(p.summary.incomplete, 1);
  assert.deepEqual(p.distribution.map((b) => [b.label, b.count, b.previous_count]), [['C', 1, 1], ['B', 2, 1], ['A', 1, 1]]);
  assert.equal(p.subject_results[0].subject, 'Mathematics', 'weakest subject first');
  assert.deepEqual(p.movement.risers.map((m) => [m.student_id, m.change]), [['s1', 10]]);
  assert.deepEqual(p.movement.fallers.map((m) => [m.student_id, m.change]), [['s2', -10], ['s3', -5]]);
  assert.equal(p.students.find((s) => s.student_id === 's4').change, null, 'no earlier result, no change');
});

test('class profile: a subject teacher sees only their subject, never attendance', () => {
  const p = buildClassProfile({
    checkpoint: 'MIDTERM', roster, rows, rule: { bands, pass_mark: 50 }, subjects: ['Chemistry'],
    attendance: new Map([['s1', 90]]),
  });
  assert.equal(p.scope, SCOPE.SUBJECT);
  assert.deepEqual(p.subject_results.map((s) => s.subject), ['Chemistry']);
  assert.equal(p.summary.mean, 60);
  assert.equal(p.summary.attendance_rate, null);
  assert.ok(p.students.every((s) => s.attendance === null));
});

test('class profile: a subject teacher sees flagged students only when their subject raised the estimate', () => {
  const prediction = (id, chemEffect, mathsEffect) => ({
    student_id: id, at_risk: true, probability: 0.7, threshold: 0.5, shap_base_value: 0,
    shap_values: { T1M_Chemistry: chemEffect, T1M_Mathematics: mathsEffect }, features: { T1M_Chemistry: 40, T1M_Mathematics: 40 },
  });
  const predictions = [prediction('s1', 0.8, 0.1), prediction('s2', -0.2, 0.9)];
  const chem = buildClassProfile({
    checkpoint: 'MIDTERM', roster, rows, rule: { bands, pass_mark: 50 }, subjects: ['Chemistry'],
    riskScope: riskScope({ subjects: ['Chemistry'] }), predictions,
    interventions: [{ student_id: 's1', status: 'ONGOING', factor: 'Mathematics' }],
  });
  assert.deepEqual(chem.risk.students.map((s) => s.student_id), ['s1']);
  assert.deepEqual(chem.risk.students[0].raised_by, ['Chemistry']);
  assert.equal(chem.risk.students[0].interventions, 0, 'a Mathematics intervention is outside a Chemistry teacher’s view');
  const all = buildClassProfile({
    checkpoint: 'MIDTERM', roster, rows, rule: { bands, pass_mark: 50 }, riskScope: riskScope({ isAdmin: true }), predictions,
  });
  assert.equal(all.risk.flagged, 2);
  assert.equal(all.risk.without_intervention, 2);
});

import { rangeCounts, examValue, topFactors, interventionMethods, riskSeries } from '../../backend/library/classProfile.js';

test('class profile: ten equal ranges, 100 in the top one', () => {
  assert.deepEqual(rangeCounts([0, 9.4, 9.6, 55, 100, null]), [2, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('class profile: an exam value never mixes in earlier exams', () => {
  const row = { checkpoint_average: 60, term_average: 70, subjects: [subj('Mathematics', 40), subj('Chemistry', 80)] };
  assert.equal(examValue(row, null), 60);
  assert.equal(examValue(row, ['Chemistry']), 80);
});

test('class profile: top factors and intervention methods respect the viewer’s scope', () => {
  const p = (id, chem, maths) => ({
    student_id: id, at_risk: true, probability: 0.7, threshold: 0.5, shap_base_value: 0,
    shap_values: { T1M_Chemistry: chem, T1M_Mathematics: maths }, features: { T1M_Chemistry: 40, T1M_Mathematics: 40 },
  });
  const preds = [p('s1', 0.6, 0.2), p('s2', -0.6, 0.2)];
  const all = topFactors(preds, riskScope({ isAdmin: true }));
  assert.deepEqual(all.map((f) => f.factor), ['Chemistry', 'Mathematics']);
  assert.equal(all[0].share, 0.75);
  assert.deepEqual(topFactors(preds, riskScope({ subjects: ['Mathematics'] })).map((f) => f.factor), ['Mathematics']);

  const ids = new Set(['s1', 's2', 's3']);
  const intv = [
    { student_id: 's1', status: 'ONGOING', factor: 'Kiswahili', method: 'Daily reading of set books', frequency: 'DAILY' },
    { student_id: 's2', status: 'ONGOING', factor: 'Kiswahili', method: 'daily  reading of set books', frequency: 'DAILY' },
    { student_id: 's3', status: 'STOPPED', factor: 'Kiswahili', method: 'Daily reading of set books' },
    { student_id: 's3', status: 'ONGOING', factor: 'Mathematics', method: 'Past papers' },
  ];
  assert.deepEqual(interventionMethods(intv, riskScope({ isAdmin: true }), ids).map((m) => [m.method, m.factor, m.students]),
    [['Daily reading of set books', 'Kiswahili', 2], ['Past papers', 'Mathematics', 1]]);
  assert.deepEqual(interventionMethods(intv, riskScope({ subjects: ['Mathematics'] }), ids).map((m) => m.factor), ['Mathematics']);
  assert.deepEqual(riskSeries([{ student_id: 's1', probability: 0.72, at_risk: true }, { student_id: 'x', probability: 0.1 }], ids),
    { counts: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], predicted: 1, flagged: 1 });
});
