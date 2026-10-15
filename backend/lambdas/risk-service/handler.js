import { assertTenant, assertAdmin, assertClassTeacherOrAdmin } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { todayIn } from '../../library/calendar.js';
import { POINT_NAMES, pointFor } from '../../library/features.js';
import { validation, notFound } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import { invoke, predictionFunction, scorerFunction } from '../../library/invoke.js';
import * as features from '../../library/featureStore.js';
import * as platform from '../../library/platformRepo.js';
import * as results from '../../library/resultsRepo.js';
import * as risk from '../../library/riskRepo.js';

/**
 * Reading risk predictions and the model behind them, and re-running a class's
 * predictions (for example after the model is replaced). Predictions are
 * decision-support signals for administrators and the student's class teacher;
 * they never decide anything on their own.
 */
export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id);

  switch (event.info.fieldName) {
    case 'listRiskPredictions':
      return listRiskPredictions(actor, args);
    case 'getRiskRun':
      return getRiskRun(actor, args);
    case 'getRiskModel':
      return getRiskModel(actor);
    case 'runRiskPredictions':
      return runRiskPredictions(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const zone = () => process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

const runView = (r) => r && {
  run_id: r.run_id,
  class_id: r.class_id,
  term_id: r.term_id,
  checkpoint: r.checkpoint,
  prediction_point: r.prediction_point,
  academic_year: r.academic_year ?? null,
  status: r.status,
  trigger: r.trigger ?? null,
  model_version: r.model_version ?? null,
  threshold: r.threshold ?? null,
  students: r.students ?? null,
  at_risk: r.at_risk ?? null,
  error: r.error ?? null,
  started_at: r.started_at ?? null,
  finished_at: r.finished_at ?? null,
};

async function listRiskPredictions(actor, { school_id, class_id, prediction_point, academic_year }) {
  if (!(await platform.klass(school_id, class_id))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, class_id);
  if (!POINT_NAMES.includes(prediction_point)) throw validation(`Prediction point must be one of ${POINT_NAMES.join(', ')}`, 'prediction_point');
  const year = academic_year ?? (await features.defaultYear(school_id, prediction_point, todayIn(zone())));
  if (!year) return [];
  const items = await risk.listForClass(school_id, year, prediction_point, class_id);
  const students = await Promise.all(items.map((p) => platform.student(school_id, p.student_id)));
  return items
    .map((p, i) => ({
      student_id: p.student_id,
      admission_no: students[i]?.admission_no ?? '',
      first_name: students[i]?.first_name ?? '',
      last_name: students[i]?.last_name ?? '',
      academic_year: p.academic_year,
      prediction_point: p.prediction_point,
      probability: p.probability,
      at_risk: p.at_risk,
      threshold: p.threshold,
      model_version: p.model_version,
      missing_scores: p.missing_scores,
      missing_attendance: p.missing_attendance,
      run_id: p.run_id,
      predicted_at: p.predicted_at,
    }))
    .sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
}

async function getRiskRun(actor, { school_id, class_id, term_id, checkpoint }) {
  if (!(await platform.klass(school_id, class_id))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, class_id);
  return runView(await risk.getRun(school_id, term_id, class_id, checkpoint));
}

async function getRiskModel(actor) {
  assertAdmin(actor);
  try {
    const m = await invoke(scorerFunction(), { action: 'describe' });
    return { available: true, message: null, ...m };
  } catch (e) {
    return { available: false, message: e.message, model_version: null, points: [] };
  }
}

/** Queues a fresh run for a published Mid-term or End-term (Terms 1-2) or Term 3 Mid-term. */
async function runRiskPredictions(actor, input) {
  assertAdmin(actor);
  const term = await platform.term(input.school_id, input.term_id);
  if (!term) throw notFound('Term not found');
  if (!(await platform.klass(input.school_id, input.class_id))) throw notFound('Class not found');
  const point = pointFor(term.term_number, input.checkpoint);
  if (!point) throw validation('The model predicts at Mid-term and End of term in terms 1 and 2, and at Term 3 Mid-term', 'checkpoint');
  const set = await results.getSet(input.school_id, { termId: input.term_id, classId: input.class_id, checkpoint: input.checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) throw validation('Publish these results first', 'checkpoint');

  const run = await risk.putRun(input.school_id, {
    run_id: ulid(),
    term_id: input.term_id,
    class_id: input.class_id,
    checkpoint: input.checkpoint,
    prediction_point: point,
    academic_year: term.academic_year,
    calculation_id: set.calculation_id,
    status: risk.RUN.QUEUED,
    trigger: 'manual',
    requested_by: actor.sub,
    started_at: new Date().toISOString(),
  });
  await invoke(predictionFunction(), {
    action: 'run', school_id: input.school_id, class_id: input.class_id, term_id: input.term_id,
    checkpoint: input.checkpoint, run_id: run.run_id, requested_by: actor.sub,
  }, { wait: false });
  return runView(run);
}