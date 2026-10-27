import 'dotenv/config';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE } from '../backend/library/keys.js';
import { columnsFor } from '../backend/library/features.js';
import { historyItems } from '../backend/library/historyRepo.js';
import * as platform from '../backend/library/platformRepo.js';
import * as risk from '../backend/library/riskRepo.js';

/**
 * Test data for the risk tests, for an environment where the full publish ->
 * predict pipeline cannot run (no scorer container, no Step Functions).
 *
 * It writes published checkpoint results and risk predictions for the seeded
 * test class so that FR-07 to FR-12 can be exercised through the API. The
 * numbers are fixed test data, not model output: anything measured about model
 * quality must come from ml/evaluate_models.py on the held-out data, never
 * from this fixture. Evidence produced against this fixture must say so.
 *
 *   node local/seed-risk-fixture.js [--class cls_test] [--year 2026]
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const SCHOOL = arg('school', 'sch_saint_innocent');
const CLASS = arg('class', 'cls_test');
const YEAR = Number(arg('year', 2026));
const SUBJECTS = ['Kiswahili', 'English', 'Mathematics', 'CRE'];

const marks = [82, 64, 48, 38, 30];                     // strong to weak
const drift = [[0, 1, 2], [0, -2, -1], [0, 4, 9], [0, 2, 1], [0, -1, 3]];
const risks = [0.08, 0.35, 0.71, 0.88, 0.95];

const run = async () => {
  const students = (await platform.listStudents(SCHOOL, CLASS)).slice(0, marks.length);
  if (!students.length) throw new Error(`no students in ${CLASS}; run npm run db:seed first`);
  const terms = await platform.listTerms(SCHOOL);
  const term = (n) => terms.find((t) => Number(t.academic_year) === YEAR && Number(t.term_number) === n);
  if (!term(1) || !term(2)) throw new Error(`terms 1 and 2 of ${YEAR} are not set up`);

  // Published checkpoint results: T1M, T1F, T2M.
  const checkpoints = [['T1M', term(1), 'MIDTERM', 0], ['T1F', term(1), 'ENDTERM', 1], ['T2M', term(2), 'MIDTERM', 2]];
  for (const [point, t, checkpoint, k] of checkpoints) {
    const set = {
      term_id: t.term_id, class_id: CLASS, checkpoint, kind: 'INTERIM',
      calculation_id: `calc_fixture_${point}`, published_at: `${YEAR}-0${k + 2}-20T10:00:00Z`, SK: 'fixture',
    };
    const rows = students.map((s, i) => ({
      student_id: s.student_id,
      checkpoint_average: marks[i] + drift[i][k],
      subjects: SUBJECTS.map((subject, j) => ({
        subject, score: marks[i] + drift[i][k] + (j % 2 ? -3 : 3), term: { grade: 'C' },
      })),
    }));
    const items = historyItems(SCHOOL, set, rows, t);
    for (let i = 0; i < items.length; i += 25) {
      await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
    }
  }

  // Predictions at T1M and T1F, with SHAP values and counterfactual targets.
  const predictions = [];
  for (const [point, k] of [['T1M', 0], ['T1F', 1]]) {
    const columns = columnsFor(point);
    const next = point === 'T1M' ? 'T1F' : 'T2M';
    students.forEach((s, i) => {
      const probability = Math.round((risks[i] - k * 0.05 * i) * 1000) / 1000;
      const features = Object.fromEntries(columns.map((c) => [c, c.startsWith('Attendance') ? 90 - i * 4 + k : marks[i] + (c.includes('_Kiswahili') ? -5 : 2)]));
      const shap = Object.fromEntries(columns.map((c, j) => [c, Math.round(((probability - 0.5) * (c.includes('Kiswahili') ? 1.2 : c.startsWith('Attendance') ? 0.8 : 0.15) + (j % 3 ? 0.01 : -0.01)) * 1e6) / 1e6]));
      const at_risk = probability >= 0.5;
      const from = features[`${point}_Kiswahili`];
      const attendance = features[`Attendance_${point}`];
      predictions.push({
        student_id: s.student_id, class_id: CLASS, term_id: term(k + 1 > 1 ? 1 : 1).term_id,
        checkpoint: point.endsWith('M') ? 'MIDTERM' : 'ENDTERM', academic_year: YEAR, prediction_point: point,
        calculation_id: `calc_fixture_${point}`, run_id: `run_fixture_${point}`, model_version: 'fixture-v1',
        threshold: 0.5, probability, at_risk, features, missing_scores: 0, missing_attendance: 0,
        explainer: 'xgboost-treeshap', shap_base_value: -0.4, shap_values: shap,
        counterfactuals: at_risk ? {
          status: 'FOUND', method: 'dice-random', reason: null, target_point: next,
          evaluation: { kind: 'model', model_point: next, threshold: 0.5, pass_mark: null, missing_score_policy: null, baseline_score: probability, baseline_at_risk: true },
          caps: {
            [`${next}_Kiswahili`]: { current: from, max_increase: 12, max_value: Math.min(100, from + 12), source: 'data' },
            [`Attendance_${next}`]: { current: attendance, max_increase: 5, max_value: Math.min(100, attendance + 5), source: 'data' },
          },
          dice: { found: true, reason: null },
          options: [{
            method: 'dice-random', score: 0.42, at_risk: false,
            changes: [
              { feature: `${next}_Kiswahili`, from, to: Math.min(100, from + 7) },
              { feature: `Attendance_${next}`, from: attendance, to: Math.min(100, attendance + 4) },
            ],
          }],
          stats_available: true,
          settings: { static_mark_cap: 20, static_attendance_cap: 10, options: 3, seed: 20261 },
          generated_at: new Date().toISOString(),
        } : null,
        predicted_at: `${YEAR}-0${k + 2}-20T11:00:00Z`,
      });
    });
  }
  await risk.putPredictions(SCHOOL, predictions);
  console.log(`Fixture written for ${CLASS}: results at T1M, T1F, T2M for ${students.length} students; ${predictions.length} predictions at T1M and T1F.`);
  console.log('These are fixed test values, not model output. Model quality evidence comes from ml/evaluate_models.py.');
};

run().catch((e) => { console.error(e.message); process.exit(1); });
