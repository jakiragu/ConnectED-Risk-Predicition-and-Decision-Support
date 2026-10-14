import { pointFor } from '../../library/features.js';
import { ulid } from '../../library/ids.js';
import { invoke, scorerFunction } from '../../library/invoke.js';
import * as features from '../../library/featureStore.js';
import * as platform from '../../library/platformRepo.js';
import * as results from '../../library/resultsRepo.js';
import * as risk from '../../library/riskRepo.js';

/**
 * Risk prediction for one published class checkpoint:
 *   ResultsPublished (Mid-term or End-term)  ->  model inputs for each student
 *   ->  the risk scorer (current published model)  ->  RiskPrediction per student
 *
 * Triggered by the EventBridge rule in infra/event-rules.json, or by an
 * administrator re-running it ({ action: 'run', ... } from the risk service).
 * Opener and Term 3 End-term are not prediction points and are skipped.
 * Delivery is at least once: a repeated event for a run that already completed
 * is skipped, and every write is keyed so a retry overwrites, never duplicates.
 * A failure here never touches the published results.
 */
const BATCH = 200;
const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'risk-prediction', ...o }));

function requestOf(event) {
  if (event?.['detail-type'] === 'ResultsPublished') {
    const d = event.detail || {};
    return {
      school_id: d.school_id, class_id: d.class_id, term_id: d.term_id, checkpoint: d.checkpoint_type,
      calculation_id: d.calculation_id, trigger: 'ResultsPublished', event_id: d.event_id ?? event.id ?? null,
      run_id: null, requested_by: d.published_by ?? null,
    };
  }
  if (event?.action === 'run') {
    return {
      school_id: event.school_id, class_id: event.class_id, term_id: event.term_id, checkpoint: event.checkpoint,
      calculation_id: null, trigger: 'manual', event_id: null, run_id: event.run_id ?? null, requested_by: event.requested_by ?? null,
    };
  }
  throw new Error('Expected a ResultsPublished event or { action: "run" }');
}

export async function handler(event) {
  const req = requestOf(event);
  const { school_id: schoolId } = req;
  const term = await platform.term(schoolId, req.term_id);
  if (!term) throw new Error(`Term ${req.term_id} not found`);
  const point = pointFor(term.term_number, req.checkpoint);
  if (!point) {
    log({ msg: 'not a prediction point', term: req.term_id, checkpoint: req.checkpoint });
    return { skipped: 'not a prediction point' };
  }

  const set = await results.getSet(schoolId, { termId: req.term_id, classId: req.class_id, checkpoint: req.checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) return { skipped: 'results are not published' };
  if (req.calculation_id && req.calculation_id !== set.calculation_id) return { skipped: 'event is for an older calculation' };

  const previous = await risk.getRun(schoolId, req.term_id, req.class_id, req.checkpoint);
  if (req.trigger === 'ResultsPublished' && previous?.status === risk.RUN.COMPLETE && previous.calculation_id === set.calculation_id) {
    log({ msg: 'duplicate event; predictions already made', run_id: previous.run_id });
    return { skipped: 'already predicted', run_id: previous.run_id };
  }

  const run = await risk.putRun(schoolId, {
    run_id: req.run_id || ulid(),
    term_id: req.term_id,
    class_id: req.class_id,
    checkpoint: req.checkpoint,
    prediction_point: point,
    academic_year: term.academic_year,
    calculation_id: set.calculation_id,
    status: risk.RUN.RUNNING,
    trigger: req.trigger,
    event_id: req.event_id,
    requested_by: req.requested_by,
    started_at: new Date().toISOString(),
  });

  try {
    const terms = await features.termsOfYear(schoolId, term.academic_year);
    const students = [];
    for (const id of set.student_ids || []) {
      const student = await platform.student(schoolId, id);
      if (!student) continue;
      const row = await features.buildForStudent(schoolId, id, point, term.academic_year, terms);
      students.push({ student, row });
    }

    // The scorer sees model inputs only: row numbers stand in for students.
    let model = null;
    const scored = [];
    for (let i = 0; i < students.length; i += BATCH) {
      const batch = students.slice(i, i + BATCH);
      const out = await invoke(scorerFunction(), {
        action: 'score',
        prediction_point: point,
        rows: batch.map((s, j) => ({ row_id: i + j, features: s.row.values })),
      });
      if (model && out.model_version !== model.model_version) throw new Error('The model changed during the run; run it again');
      model = { model_version: out.model_version, threshold: out.threshold };
      scored.push(...out.predictions);
    }

    const predictedAt = new Date().toISOString();
    const predictions = scored.map((p) => {
      const { student, row } = students[p.row_id];
      return {
        student_id: student.student_id,
        class_id: req.class_id,
        term_id: req.term_id,
        checkpoint: req.checkpoint,
        academic_year: term.academic_year,
        prediction_point: point,
        calculation_id: set.calculation_id,
        run_id: run.run_id,
        model_version: model.model_version,
        threshold: model.threshold,
        probability: p.probability,
        at_risk: p.at_risk,
        features: row.values,
        missing_scores: row.missing.scores.length,
        missing_attendance: row.missing.attendance.length,
        predicted_at: predictedAt,
      };
    });
    await risk.putPredictions(schoolId, predictions);
    const done = await risk.finishRun(schoolId, run, {
      status: risk.RUN.COMPLETE,
      model_version: model?.model_version ?? null,
      threshold: model?.threshold ?? null,
      students: predictions.length,
      at_risk: predictions.filter((p) => p.at_risk).length,
      error: null,
    });
    log({ msg: 'predicted', run_id: run.run_id, point, class: req.class_id, students: predictions.length, model: model?.model_version });
    return { run_id: run.run_id, status: done?.status ?? risk.RUN.COMPLETE, students: predictions.length, model_version: model?.model_version ?? null };
  } catch (e) {
    await risk.finishRun(schoolId, run, { status: risk.RUN.FAILED, error: e.message }).catch(() => {});
    log({ level: 'error', msg: 'risk prediction failed', run_id: run.run_id, err: e.message });
    throw e; // let the platform retry an event-triggered run
  }
}