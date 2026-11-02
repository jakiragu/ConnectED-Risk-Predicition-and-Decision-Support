import assert from 'node:assert/strict';
import {
  DELETE_INTERVENTION, GET_STUDENT_RISK_PROFILE,
  LIST_STUDENT_INTERVENTIONS, SAVE_INTERVENTION,
} from '../../src/api/decisionOperations.js';
import { GET_RISK_EXPLANATION, LIST_RISK_PREDICTIONS } from '../../src/api/riskOperations.js';
import { GET_CLASS_ROSTER } from '../../src/api/operations.js';
import { ulid } from '../../backend/library/ids.js';
import { as, CLASS, SCHOOL } from '../helpers/api.js';
import { refused, tc } from '../helpers/harness.js';

/**
 * The risk layer end to end (FR-07 to FR-12), increments #9 to #13, read
 * through the same API the dashboard uses.
 *
 * These cases need predictions to exist for the test class. Produce them by
 * publishing a checkpoint (the gradebook tests do this) or by running the
 * prediction for the class, then run this file. Where no prediction exists the
 * case is skipped and says so, rather than being recorded as a pass.
 *
 * Provenance: local/seed-risk-fixture.js writes fixed test values with
 * model_version 'fixture-v1'. They are fine for checking what the API returns and
 * what an educator can do with it (FR-11, FR-12, NFR-1), but they are not model
 * output, so FR-07, FR-09 and FR-10 cases run only on predictions whose
 * model_version is not a fixture. Where only fixture data exists they are SKIPPED.
 */
// Which prediction point to read: TEST_POINT if set, otherwise the first of these that has predictions
// (T1M is what publishing Term 1 Mid-term produces, which TC-P01 does; the fixture also writes T1M and T1F).
const CANDIDATES = process.env.TEST_POINT ? [process.env.TEST_POINT] : ['T1M', 'T1F', 'T2M', 'T2F', 'T3M'];
let chosen = null;
const listAt = async (point) =>
  (await as('john', LIST_RISK_PREDICTIONS, { school_id: SCHOOL, class_id: CLASS, prediction_point: point })).listRiskPredictions;
async function pointNow() {
  if (chosen) return chosen;
  for (const point of CANDIDATES) if ((await listAt(point)).length) return (chosen = point);
  return CANDIDATES[0];
}
const today = () => new Date().toISOString().slice(0, 10);

const predictions = async () => listAt(await pointNow());

const isFixture = (p) => String(p.model_version ?? '').startsWith('fixture');
const source = (p) => (isFixture(p) ? `fixture data (${p.model_version})` : `pipeline output (${p.model_version})`);

async function flagged(t, ev, { pipelineOnly = false } = {}) {
  const point = await pointNow();
  const all = await predictions();
  const list = pipelineOnly ? all.filter((p) => !isFixture(p)) : all;
  const one = list.find((p) => p.at_risk) ?? list[0];
  if (!one) {
    const why = all.length
      ? `all ${all.length} predictions for ${CLASS} at ${point} are fixture data; this case needs model output (see tests/integration/pipeline.test.js)`
      : `no prediction exists for ${CLASS} at ${point}: publish results for the class first`;
    ev(why);
    t.skip(why);
    return null;
  }
  return one;
}

tc({
  id: 'TC-R01', requirement: 'FR-07', level: 'Integration', technique: 'Black box, positive',
  scenario: 'A risk classification exists for each student of a published checkpoint',
  data: 'class cls_test at the first prediction point that has predictions',
  expected: 'Every student has a probability between 0 and 1, a threshold, and the model version that produced it',
}, async (ev, t) => {
  const all = await predictions();
  const list = all.filter((p) => !isFixture(p));
  if (!list.length) { const why = all.length ? 'only fixture predictions exist; FR-07 needs model output' : 'no predictions for this class and point'; ev(why); t.skip(why); return; }
  for (const p of list) {
    assert.ok(p.probability >= 0 && p.probability <= 1, `probability out of range: ${p.probability}`);
    assert.equal(p.at_risk, p.probability >= p.threshold);
    assert.ok(p.model_version, 'the prediction must record the model that produced it');
  }
  ev(`${list.length} predictions, ${list.filter((p) => p.at_risk).length} flagged, model ${list[0].model_version}, threshold ${list[0].threshold}`);
});

tc({
  id: 'TC-R02', requirement: 'FR-09', level: 'Integration', technique: 'Black box, content check',
  scenario: 'A SHAP explanation reaches the educator with its factors ranked by effect',
  data: 'one flagged student whose prediction came from the model pipeline (not the fixture)',
  expected: 'The explanation is present and its factors are ordered from largest to smallest effect. (That base value plus contributions equals the model output is checked on the model itself by TC-M02.)',
}, async (ev, t) => {
  const one = await flagged(t, ev, { pipelineOnly: true });
  if (!one) return;
  const e = (await as('john', GET_RISK_EXPLANATION, { school_id: SCHOOL, student_id: one.student_id, prediction_point: await pointNow() })).getRiskExplanation;
  assert.ok(e.explained, 'the prediction carries no explanation');
  const shares = e.factors.map((f) => f.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a), 'factors are not ordered by size of effect');
  const total = e.factors.reduce((s, f) => s + Math.abs(f.effect), 0);
  assert.ok(total > 0);
  ev(`base ${e.base_probability}, ${e.factors.length} factors, largest ${e.factors[0].group} at ${Math.round(e.factors[0].share * 100)}% of the total effect`);
});

tc({
  id: 'TC-R03', requirement: 'FR-10', level: 'Integration', technique: 'White box, constraint check',
  scenario: 'Counterfactual targets stay within the permitted changes',
  data: 'the targets of a flagged student whose prediction came from the model pipeline (not the fixture)',
  expected: 'Each change raises a result without passing its cap or 100, and a FOUND option is stored as not at risk. (That re-scoring each option through the model reproduces its score is checked by TC-M03.)',
}, async (ev, t) => {
  const list = (await predictions()).filter((p) => !isFixture(p));
  const one = list.find((p) => p.at_risk && ['FOUND', 'FALLBACK'].includes(p.targets_status));
  if (!one) { ev('no flagged student with pipeline-generated targets in this environment'); t.skip('no pipeline targets'); return; }
  const e = (await as('john', GET_RISK_EXPLANATION, { school_id: SCHOOL, student_id: one.student_id, prediction_point: await pointNow() })).getRiskExplanation;
  const targets = e.targets;
  const caps = new Map(targets.caps.map((c) => [c.column, c]));
  for (const option of targets.options) {
    for (const c of option.changes) {
      assert.ok(c.to > c.from, `${c.column} does not increase`);
      assert.ok(c.to <= 100.0001, `${c.column} exceeds 100`);
      const cap = caps.get(c.column);
      if (cap) assert.ok(c.to <= cap.max_value + 0.0001, `${c.column} exceeds its permitted maximum`);
    }
    if (targets.status === 'FOUND') assert.equal(option.at_risk, false, 'a FOUND option must clear the next checkpoint');
  }
  ev(`${targets.status} via ${targets.method} for ${targets.target_label}; ${targets.options.length} option(s), first [${targets.options[0].changes.map((c) => `${c.group} ${c.from}->${c.to}`).join(', ')}]`);
});

tc({
  id: 'TC-R04', requirement: 'FR-11', level: 'Integration', technique: 'Black box, positive',
  scenario: 'One request returns the prediction, its explanation and its targets together',
  data: 'the student risk profile of a flagged student',
  expected: 'The profile carries the risk estimate, the SHAP factors and the targets in a single response',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const p = (await as('john', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: one.student_id })).getStudentRiskProfile;
  assert.ok(p.latest, 'no risk estimate on the profile');
  assert.ok(p.factors.length > 0, 'no explanation on the profile');
  assert.ok(p.risk_trend.length > 0);
  ev(`[${source(one)}] one response carried the estimate (${p.latest.probability}), ${p.factors.length} factors, targets ${p.targets?.status ?? 'none'} and ${p.interventions.length} interventions`);
});

tc({
  id: 'TC-R05', requirement: 'FR-12', level: 'Integration', technique: 'Black box, lifecycle',
  scenario: 'An educator records an intervention, edits it, stops it, restarts it and deletes it',
  data: 'one intervention on a flagged student, as the class teacher',
  expected: 'Each change is stored with a new version, and the deleted intervention no longer appears',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const id = ulid();
  const input = (patch) => ({
    school_id: SCHOOL, student_id: one.student_id, intervention_id: id, factor: 'Kiswahili',
    method: 'Daily reading of set books', frequency: 'DAILY', status: 'ONGOING', started_on: today(), ...patch,
  });
  const made = (await as('jane', SAVE_INTERVENTION, { input: input({}) })).saveIntervention;
  assert.equal(made._version, 1);
  const edited = (await as('jane', SAVE_INTERVENTION, { input: input({ method: 'Daily reading, 20 minutes', _version: 1 }) })).saveIntervention;
  const stopped = (await as('jane', SAVE_INTERVENTION, { input: input({ method: edited.method, status: 'STOPPED', stopped_on: today(), _version: 2 }) })).saveIntervention;
  const restarted = (await as('jane', SAVE_INTERVENTION, { input: input({ method: edited.method, status: 'ONGOING', _version: 3 }) })).saveIntervention;
  assert.deepEqual([edited._version, stopped.status, restarted.status, restarted.stopped_on], [2, 'STOPPED', 'ONGOING', null]);
  await as('jane', DELETE_INTERVENTION, { input: { school_id: SCHOOL, student_id: one.student_id, intervention_id: id, _version: restarted._version } });
  const after = (await as('jane', LIST_STUDENT_INTERVENTIONS, { school_id: SCHOOL, student_id: one.student_id })).listStudentInterventions;
  assert.ok(!after.some((i) => i.intervention_id === id), 'the deleted intervention is still listed');
  ev('created v1, edited v2, stopped, restarted and deleted; no longer listed');
});

tc({
  id: 'TC-R06', requirement: 'FR-12', level: 'Integration', technique: 'Black box, traceability',
  scenario: 'A recorded intervention is linked to the prediction it responded to',
  data: 'a new intervention on a flagged student',
  expected: 'The stored record carries the point, run, model version and estimate of the student\'s latest prediction',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const i = (await as('jane', SAVE_INTERVENTION, { input: {
    school_id: SCHOOL, student_id: one.student_id, intervention_id: ulid(), factor: 'Kiswahili',
    method: 'Traceability check', frequency: 'ONCE', status: 'ONGOING', started_on: today(),
  } })).saveIntervention;
  assert.ok(i.linked, 'the intervention is not linked to a prediction');
  // It links to the student's latest prediction of the year, which may be later than the point under test.
  const profile = (await as('john', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: one.student_id })).getStudentRiskProfile;
  assert.equal(i.linked.prediction_point, profile.latest.prediction_point);
  assert.equal(i.linked.probability, profile.latest.probability);
  assert.equal(i.linked.model_version, profile.latest.model_version);
  ev(`linked to ${i.linked.prediction_point}, run ${i.linked.run_id}, model ${i.linked.model_version}, estimate ${i.linked.probability}`);
});

tc({
  id: 'TC-R07', requirement: 'FR-12', level: 'Integration', technique: 'Black box, concurrency',
  scenario: 'Two educators edit the same intervention from the same starting version',
  data: 'both send _version 1',
  expected: 'The first edit succeeds and the second is refused as a conflict, so no change is silently lost',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const id = ulid();
  const input = (patch) => ({
    school_id: SCHOOL, student_id: one.student_id, intervention_id: id, factor: 'Kiswahili',
    method: 'Conflict probe', frequency: 'ONCE', status: 'ONGOING', started_on: today(), ...patch,
  });
  await as('jane', SAVE_INTERVENTION, { input: input({}) });
  await as('jane', SAVE_INTERVENTION, { input: input({ notes: 'first edit', _version: 1 }) });
  const e = await refused(() => as('john', SAVE_INTERVENTION, { input: input({ notes: 'second edit', _version: 1 }) }), 'Conflict');
  ev(`second edit refused with ${e.errorType}: ${e.message}`);
});

tc({
  id: 'TC-R08', requirement: 'FR-12', level: 'Integration', technique: 'Black box, idempotency',
  scenario: 'The same intervention is sent twice, as the offline queue does after a lost response',
  data: 'two identical requests with one client identifier',
  expected: 'One intervention exists and the second request returns it rather than creating a duplicate',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const input = {
    school_id: SCHOOL, student_id: one.student_id, intervention_id: ulid(), factor: 'Kiswahili',
    method: 'Replay probe', frequency: 'ONCE', status: 'ONGOING', started_on: today(),
  };
  const a = (await as('jane', SAVE_INTERVENTION, { input })).saveIntervention;
  const b = (await as('jane', SAVE_INTERVENTION, { input })).saveIntervention;
  const list = (await as('jane', LIST_STUDENT_INTERVENTIONS, { school_id: SCHOOL, student_id: one.student_id })).listStudentInterventions;
  assert.equal(a.intervention_id, b.intervention_id);
  assert.equal(list.filter((i) => i.intervention_id === a.intervention_id).length, 1);
  ev(`both requests returned ${a._version === b._version ? 'the same record' : 'different versions'}; one record stored`);
});

tc({
  id: 'TC-R09', requirement: 'NFR-4', level: 'Integration', technique: 'Automated inspection (no educator review)',
  scenario: 'Explanation and target labels contain no raw model feature names',
  data: 'the labels of every factor, cap and target change on a profile',
  expected: 'No raw model column name such as T1F_Religious_Education appears in any label',
}, async (ev, t) => {
  const one = await flagged(t, ev);
  if (!one) return;
  const p = (await as('john', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id: one.student_id })).getStudentRiskProfile;
  const labels = [
    ...p.factors.map((f) => f.label),
    ...(p.targets?.caps ?? []).map((c) => c.label),
    ...(p.targets?.options ?? []).flatMap((o) => o.changes.map((c) => c.label)),
  ];
  const raw = labels.filter((l) => /_(T[123][MF]|Religious_Education)|^T[123][MF]_|Attendance_T/.test(l));
  assert.deepEqual(raw, [], `raw model names reached the interface: ${raw.join(', ')}`);
  ev(`${labels.length} labels checked, none raw; examples: ${labels.slice(0, 2).join(' / ')}`);
});
