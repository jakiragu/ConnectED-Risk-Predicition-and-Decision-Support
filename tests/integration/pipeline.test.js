import 'dotenv/config';   // must load before the AWS clients below are created
import assert from 'node:assert/strict';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GET_CLASS_ROSTER } from '../../src/api/operations.js';
import { GET_STUDENT_RISK_PROFILE } from '../../src/api/decisionOperations.js';
import { LIST_RISK_PREDICTIONS } from '../../src/api/riskOperations.js';
import { s3 } from '../../backend/library/client.js';
import { invoke, scorerFunction } from '../../backend/library/invoke.js';
import { as, CLASS, SCHOOL, sleep, waitFor } from '../helpers/api.js';
import { tc } from '../helpers/harness.js';
import { publishThrough, resultSet } from '../helpers/publishing.js';

/**
 * The publish -> predict path through the real pipeline (FR-07, FR-08) and what happens to the
 * gradebook when the prediction service cannot do its job (NFR-2).
 *
 * Both cases use the seeded Term 2 Mid-term and End-term papers (TEST_PIPELINE_TERM, default
 * term_2026_2); the seed has no Term 2 Opener, so one minimal Opener paper is added if needed.
 * Term 2 is a later term than the one TC-G06 publishes, so its results are the latest and a
 * missing prediction shows as "not current" (T2M then T2F). Publishing is permanent for a seed, so reseed (npm run db:seed)
 * before a fresh run.
 *
 * Both need the scorer to be able to run (Python with xgboost, shap and dice-ml, LOCAL_PYTHON set
 * for `npm run api`, and a published model: npm run model:publish). That is checked first with the
 * scorer's own selftest, and the cases are SKIPPED, with the reason, when it is not available,
 * because an unavailable scorer is a problem with the environment, not a result.
 *
 *   TC-P01  publishes Opener and Mid-term, then expects a model prediction for every student.
 *   TC-P02  makes the scorer unable to load a model (it removes models/current.json from the model
 *           bucket, waits for the scorer's pointer cache to expire, and restores it afterwards),
 *           publishes End of term, and expects the gradebook to be unaffected and the profile to
 *           show the earlier prediction as not current. Run it after TC-P01.
 */
const TERM = process.env.TEST_PIPELINE_TERM || 'term_2026_2';
const N = /(\d)$/.exec(TERM)?.[1];
const MID = `T${N}M`;      // the prediction point Mid-term publication triggers
const FIN = `T${N}F`;      // the next point, whose End of term publication TC-P02 delays
const TIMEOUT = Number(process.env.TEST_PIPELINE_TIMEOUT_MS || 120000);
const POINTER = 'models/current.json';
const POINTER_TTL_MS = (Number(process.env.MODEL_POINTER_TTL_SECONDS) || 60) * 1000;

const isFixture = (p) => String(p.model_version ?? '').startsWith('fixture');
const roster = async () => (await as('jane', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: CLASS })).getClassRoster;
const predictionsAt = async (point) =>
  (await as('john', LIST_RISK_PREDICTIONS, { school_id: SCHOOL, class_id: CLASS, prediction_point: point })).listRiskPredictions;
const profileOf = async (student_id) =>
  (await as('john', GET_STUDENT_RISK_PROFILE, { school_id: SCHOOL, student_id })).getStudentRiskProfile;

const pointerObject = async () => {
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.MODEL_BUCKET, Key: POINTER }));
  return res.Body.transformToString();
};

/** The scorer's own selftest on the published model: is the scorer able to run at all? */
async function scorerStatus() {
  try {
    const pointer = JSON.parse(await pointerObject());
    await invoke(scorerFunction(), { action: 'selftest', model_version: pointer.model_version });
    return { ok: true, model_version: pointer.model_version };
  } catch (e) {
    return { ok: false, why: `${e.name}: ${e.message}` };
  }
}

tc({
  id: 'TC-P01', requirement: 'FR-07 / FR-08', level: 'System', technique: 'Black box, end to end',
  scenario: 'Publishing Mid-term results causes a risk classification to be generated for every student in the class',
  data: 'the seeded Term 2 Mid-term papers of cls_test (plus one minimal Opener paper, as the seed has none), published in order by the administrator; the pipeline (event, risk-prediction, scorer) runs unmodified',
  expected: 'Within the timeout every student has a prediction at T2M produced by the published model (not a fixture), made after the publication, with a probability between 0 and 1 and an at-risk flag that agrees with the threshold',
}, async (ev, t) => {
  const scorer = await scorerStatus();
  if (!scorer.ok) { const why = `the scorer is not available: ${scorer.why}`; ev(why); t.skip(why); return; }
  if ((await resultSet(TERM, 'MIDTERM'))?.status === 'PUBLISHED') {
    const why = `${TERM} Mid-term is already published (an earlier run); reseed with npm run db:seed and rerun`;
    ev(why); t.skip(why); return;
  }
  const students = await roster();
  const published = await publishThrough(TERM, 'MIDTERM');
  assert.ok(published.MIDTERM, 'Mid-term was not published');
  const fresh = await waitFor(async () => {
    const list = await predictionsAt(MID);
    const byStudent = new Map(list.map((p) => [p.student_id, p]));
    const ready = students.every((s) => {
      const p = byStudent.get(s.student_id);
      return p && !isFixture(p) && Date.parse(p.predicted_at) >= published.MIDTERM - 1000;
    });
    return ready ? byStudent : null;
  }, { timeout: TIMEOUT, every: 3000 });
  assert.ok(fresh, `not every one of ${students.length} students had a new T2M prediction within ${TIMEOUT / 1000}s of publishing; check the api terminal for risk-prediction errors`);
  for (const s of students) {
    const p = fresh.get(s.student_id);
    assert.ok(typeof p.probability === 'number' && p.probability >= 0 && p.probability <= 1, `probability out of range for ${s.student_id}`);
    assert.equal(p.at_risk, p.probability >= p.threshold, `at_risk disagrees with the threshold for ${s.student_id}`);
    assert.equal(p.model_version, scorer.model_version, `${s.student_id} was scored by ${p.model_version}, not the published ${scorer.model_version}`);
  }
  const any = fresh.values().next().value;
  const flagged = [...fresh.values()].filter((p) => p.at_risk).length;
  ev(`${students.length} predictions at T2M within ${Math.round((Date.now() - published.MIDTERM) / 1000)}s of publishing; ${flagged} flagged at threshold ${any.threshold}; model ${any.model_version}; run ${any.run_id}`);
});

tc({
  id: 'TC-P02', requirement: 'NFR-2', level: 'System', technique: 'Fault injection',
  scenario: 'End of term results are published while the scorer cannot load a model',
  data: 'models/current.json removed from the model bucket after TC-P01; once the scorer\'s pointer cache expires the scorer fails; the administrator publishes Term 2 End of term; the pointer is restored afterwards',
  expected: 'Publishing completes without error, the student\'s profile still returns the T2M prediction unchanged, and it is marked as not current while the last published point is T2F',
}, async (ev, t) => {
  const scorer = await scorerStatus();
  if (!scorer.ok) { const why = `the scorer is not available: ${scorer.why}`; ev(why); t.skip(why); return; }
  const earlier = (await predictionsAt(MID)).filter((p) => !isFixture(p));
  if (!earlier.length) { const why = 'no model prediction exists at T2M to fall back on; run TC-P01 first'; ev(why); t.skip(why); return; }
  if ((await resultSet(TERM, 'ENDTERM'))?.status === 'PUBLISHED') {
    const why = `${TERM} End of term is already published (an earlier run); reseed with npm run db:seed and rerun`;
    ev(why); t.skip(why); return;
  }
  const student = earlier[0].student_id;
  const before = await profileOf(student);
  assert.equal(before.latest.prediction_point, MID);
  assert.equal(before.current, true, 'before the fault the T2M prediction should be current');

  const saved = await pointerObject();
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.MODEL_BUCKET, Key: POINTER }));
  let published;
  let restoredOk = false;
  try {
    // The scorer re-reads its pointer at most every POINTER_TTL seconds; wait until it really fails.
    const broken = await waitFor(async () => (await scorerStatus()).ok === false, { timeout: POINTER_TTL_MS + 30000, every: 2000 });
    assert.ok(broken, 'the fault did not take effect: the scorer still loads a model after the pointer was removed');
    published = await publishThrough(TERM, 'ENDTERM');
    await sleep(8000);                                    // time for the prediction run to attempt, and fail
  } finally {
    await s3.send(new PutObjectCommand({ Bucket: process.env.MODEL_BUCKET, Key: POINTER, Body: saved, ContentType: 'application/json' }));
    restoredOk = await waitFor(async () => (await scorerStatus()).ok, { timeout: POINTER_TTL_MS + 30000, every: 2000 });
  }
  assert.ok(restoredOk, 'the scorer did not recover after the model pointer was restored');
  assert.ok(published.ENDTERM, 'End of term was not published while the scorer was down');

  const after = await profileOf(student);
  assert.equal(after.latest.prediction_point, before.latest.prediction_point, 'the displayed prediction changed');
  assert.equal(after.latest.probability, before.latest.probability, 'the displayed risk value changed');
  assert.equal(after.current, false, 'the previous prediction is not marked as not current');
  assert.equal(after.last_published_point, FIN);
  ev(`End of term published with the scorer down; profile still showed ${after.latest.prediction_point} at ${after.latest.probability}, current=${after.current}, last published point ${after.last_published_point}; pointer restored and scorer recovered`);
});
