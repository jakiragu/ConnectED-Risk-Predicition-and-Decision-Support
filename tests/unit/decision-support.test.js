import assert from 'node:assert/strict';
import { tc } from '../helpers/harness.js';
import {
  canSeeFactor, checkpointPoint, contributorLevel, factorSeries, methodKey, outcomeOf, riskScope,
  scopeFactors, scopeTargets, targetForFactor, validateIntervention,
} from '../../backend/library/decisionSupport.js';
import { latestOf } from '../../backend/library/riskProfile.js';
import { targetsOf } from '../../backend/library/targets.js';

const stored = {
  status: 'FOUND', method: 'dice-random', target_point: 'T1F',
  evaluation: { kind: 'model', model_point: 'T1F', threshold: 0.5, baseline_score: 0.8, baseline_at_risk: true },
  caps: { T1F_Kiswahili: { max_increase: 12, max_value: 52, source: 'data' }, Attendance_T1F: { max_increase: 5, max_value: 85, source: 'data' } },
  options: [
    { method: 'dice-random', score: 0.4, at_risk: false, changes: [{ feature: 'T1F_Kiswahili', from: 40, to: 47 }, { feature: 'Attendance_T1F', from: 80, to: 84 }] },
    { method: 'dice-random', score: 0.45, at_risk: false, changes: [{ feature: 'Attendance_T1F', from: 80, to: 85 }] },
  ],
};

tc({
  id: 'TC-U01', requirement: 'NFR-1', level: 'Unit', technique: 'White box, equivalence classes',
  scenario: 'Which risk factors each role may see',
  data: 'administrator; class teacher; subject teacher of one model subject and one non-model subject; teacher with no subjects',
  expected: 'Administrator and class teacher see every factor; a subject teacher sees only their model subject; a teacher with no subjects gets no scope',
}, () => {
  assert.equal(riskScope({ isAdmin: true }).all, true);
  assert.equal(riskScope({ isClassTeacher: true }).all, true);
  const subject = riskScope({ subjects: ['Kiswahili', 'Computer Studies'] });
  assert.deepEqual([subject.all, [...subject.factors]], [false, ['Kiswahili']]); // not a model subject: no factor
  assert.equal(riskScope({ subjects: [] }), null);
  assert.equal(canSeeFactor(subject, 'Attendance'), false);
  assert.equal(canSeeFactor(riskScope({ isClassTeacher: true }), 'Attendance'), true);
});

tc({
  id: 'TC-U02', requirement: 'NFR-1 / FR-09 / FR-10', level: 'Unit', technique: 'White box, filtering',
  scenario: "A subject teacher's explanation and targets are limited to their subject",
  data: 'one SHAP factor list and one set of stored counterfactual options covering attendance and Kiswahili',
  expected: "Factors and options outside the teacher's subject are removed and the view is marked partial; an administrator sees everything",
}, () => {
  const scope = riskScope({ subjects: ['Kiswahili'] });
  const factors = scopeFactors([
    { group: 'Attendance', direction: 'RAISES', share: 0.4 },
    { group: 'Kiswahili', direction: 'RAISES', share: 0.15 },
  ], scope);
  assert.deepEqual(factors.map((f) => [f.group, f.level]), [['Kiswahili', 'MEDIUM']]);
  const t = scopeTargets(targetsOf(stored), scope);
  assert.equal(t.partial, true);
  assert.equal(t.options.length, 1); // the attendance-only option is left out
  assert.deepEqual(t.options[0].changes.map((c) => c.group), ['Kiswahili']);
  assert.deepEqual(t.caps.map((c) => c.column), ['T1F_Kiswahili']);
  const full = scopeTargets(targetsOf(stored), riskScope({ isAdmin: true }));
  assert.deepEqual([full.partial, full.options.length], [false, 2]);
});

tc({
  id: 'TC-U03', requirement: 'FR-09 / FR-10', level: 'Unit', technique: 'White box, boundary',
  scenario: 'Contribution levels and the target shown for a factor',
  data: 'shares 0.3, 0.05 and a factor that lowers risk; stored options for Attendance and an absent factor',
  expected: 'A share maps to HIGH or LOW; a factor that lowers risk is not shown as a contributor; the target is read from the stored options; an unknown factor has none',
}, () => {
  assert.equal(contributorLevel({ direction: 'RAISES', share: 0.3 }), 'HIGH');
  assert.equal(contributorLevel({ direction: 'RAISES', share: 0.05 }), 'LOW');
  assert.equal(contributorLevel({ direction: 'LOWERS', share: 0.5 }), null);
  const t = targetForFactor(targetsOf(stored), 'Attendance');
  assert.deepEqual([t.column, t.from, t.to, t.gain], ['Attendance_T1F', 80, 84, 4]);
  assert.equal(targetForFactor(targetsOf(stored), 'History'), null);
});

tc({
  id: 'TC-U04', requirement: 'FR-12', level: 'Unit', technique: 'White box, positive and negative',
  scenario: 'An intervention record is validated before it is stored',
  data: 'one valid record; records with an invalid factor, empty method, unknown frequency, malformed date, and missing or earlier stop date',
  expected: 'The valid record is accepted with its method trimmed; every invalid record is rejected naming the offending field',
}, () => {
  const ok = validateIntervention({ factor: 'Kiswahili', method: '  Daily  reading of set books ', frequency: 'DAILY', status: 'ONGOING', started_on: '2026-02-23' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.method, 'Daily reading of set books');
  assert.equal(ok.value.stopped_on, null);
  const bad = (patch) => validateIntervention({ factor: 'Kiswahili', method: 'x', frequency: 'DAILY', status: 'ONGOING', started_on: '2026-02-23', ...patch });
  assert.equal(bad({ factor: 'Religious_Education' }).field, 'factor');
  assert.equal(bad({ method: '   ' }).field, 'method');
  assert.equal(bad({ frequency: 'HOURLY' }).field, 'frequency');
  assert.equal(bad({ started_on: '23/02/2026' }).field, 'started_on');
  assert.equal(bad({ status: 'STOPPED' }).field, 'stopped_on');
  assert.equal(bad({ status: 'STOPPED', stopped_on: '2026-02-01' }).field, 'stopped_on');
  assert.equal(bad({ status: 'STOPPED', stopped_on: '2026-03-01' }).ok, true);
  assert.equal(methodKey(' Talk  to Guardian'), 'talk to guardian');
});

tc({
  id: 'TC-U05', requirement: 'FR-07 / FR-08', level: 'Unit', technique: 'White box, mapping',
  scenario: 'A published checkpoint maps to the prediction point it triggers',
  data: 'Term 1 Mid-term, Term 3 End-term, Term 2 Opener',
  expected: 'T1M and T3F respectively; the Opener triggers no prediction',
}, () => {
  assert.deepEqual([checkpointPoint(1, 'MIDTERM'), checkpointPoint(3, 'ENDTERM'), checkpointPoint(2, 'OPENER')], ['T1M', 'T3F', null]);
});

tc({
  id: 'TC-U06', requirement: 'FR-12', level: 'Unit', technique: 'White box, calculation',
  scenario: 'What followed an intervention is reported descriptively',
  data: 'three checkpoints of results and predictions; interventions on Kiswahili and Attendance; one with no later result',
  expected: 'Later result, change, target reached and risk before and after are reported as observed; where nothing followed every value is null.',
}, () => {
  const results = [
    { point: 'T1M', subjects: [{ subject: 'Kiswahili', score: 40 }] },
    { point: 'T1F', subjects: [{ subject: 'Kiswahili', score: 46 }] },
    { point: 'T2M', subjects: [{ subject: 'Kiswahili', score: 49.5 }] },
  ];
  const predictions = [
    { prediction_point: 'T1M', probability: 0.8, features: { Attendance_T1M: 80 } },
    { prediction_point: 'T1F', probability: 0.6, features: { Attendance_T1F: 83 } },
    { prediction_point: 'T2M', probability: 0.45, features: { Attendance_T2M: 85 } },
  ];
  const item = { factor: 'Kiswahili', linked: { prediction_point: 'T1M', probability: 0.8, target: { gain: 7 } } };
  const o = outcomeOf(item, factorSeries('Kiswahili', results, predictions), predictions);
  assert.deepEqual([o.from, o.to, o.to_point, o.change, o.reached_target, o.risk_from, o.risk_to], [40, 49.5, 'T2M', 9.5, true, 0.8, 0.45]);
  const att = outcomeOf({ factor: 'Attendance', linked: { prediction_point: 'T1F', probability: 0.6, target: { gain: 4 } } },
    factorSeries('Attendance', results, predictions), predictions);
  assert.deepEqual([att.from, att.to, att.change, att.reached_target], [83, 85, 2, false]);
  const none = outcomeOf({ factor: 'Kiswahili', linked: { prediction_point: 'T2M', probability: 0.45 } }, factorSeries('Kiswahili', results, predictions), predictions);
  assert.deepEqual([none.to, none.change, none.reached_target, none.risk_to], [null, null, null, null]);
});

tc({
  id: 'TC-U07', requirement: 'NFR-2', level: 'Unit', technique: 'White box, state',
  scenario: 'A prediction is marked not current once later results exist without one',
  data: 'prediction and result histories that match, lag by one checkpoint, end at the never-predicted final checkpoint, and are empty',
  expected: 'Current only when predictions keep pace with results; the previous prediction is still returned when stale; an empty history is not current',
}, () => {
  const year = (preds, res) => ({ predictions: preds.map((p) => ({ prediction_point: p })), results: res.map((p) => ({ point: p })) });
  assert.equal(latestOf(year(['T1M', 'T1F'], ['T1M', 'T1F'])).current, true);
  const stale = latestOf(year(['T1M'], ['T1M', 'T1F']));
  assert.deepEqual([stale.current, stale.latest.prediction_point, stale.last_published_point], [false, 'T1M', 'T1F']);
  assert.equal(latestOf(year(['T3M'], ['T3M', 'T3F'])).current, true); // T3F is the outcome, never predicted
  assert.equal(latestOf(year([], [])).current, false);
});
