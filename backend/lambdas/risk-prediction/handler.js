import { nextPeriodSchoolDays, pointFor } from '../../library/features.js';
import { ulid } from '../../library/ids.js';
import { invoke, scorerFunction } from '../../library/invoke.js';
import * as features from '../../library/featureStore.js';
import * as platform from '../../library/platformRepo.js';
import * as results from '../../library/resultsRepo.js';
import * as risk from '../../library/riskRepo.js';

/**
 * Risk prediction for one published class checkpoint:
 *   ResultsPublished (Mid-term or End-term)  ->  model inputs for each student
 *   ->  the risk scorer (current published model)  ->  probability + SHAP explanation
 *   ->  for students the model flags: counterfactual targets for the NEXT
 *       checkpoint (the scorer's counterfactuals action: the next checkpoint's
 *       model, or at T3M the pass-mark rule on the projected Term 3 Final)
 *   ->  RiskPrediction per student
 *
 * Targets are worked out after the predictions themselves; if that fails, the
 * predictions are still stored, with the targets marked ERROR and the reason.
 * The scorer only ever receives row numbers, never student identities.
 *
 * Triggered by the EventBridge rule in infra/event-rules.json, or by an
 * administrator re-running it ({ action: 'run', ... } from the risk service).
 * Opener and Term 3 End-term are not prediction points and are skipped.
 * Delivery is at least once: a repeated event for a run that already completed
 * is skipped, and every write is keyed so a retry overwrites, never duplicates.
 * A failure here never touches the published results.
 */
const BATCH = 200;
const CF_BATCH = 25;
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

/**
 * Counterfactual targets for the flagged rows. Never throws: a failure is
 * recorded on each affected row so the predictions can still be stored.
 */
async function targetsFor({ schoolId, run, point, model, students, flagged, terms, term }) {
  const out = new Map();
  if (!flagged.length) return out;
  const rule = await platform.gradeRule(schoolId, term.term_id).catch(() => null);
  const nextDays = nextPeriodSchoolDays(point, terms);
  for (let i = 0; i < flagged.length; i += CF_BATCH) {
    const batch = flagged.slice(i, i + CF_BATCH);
    try {
      const res = await invoke(scorerFunction(), {
        action: 'counterfactuals',
        prediction_point: point,
        model_version: model.model_version,
        pass_mark: rule?.pass_mark ?? null,
        missing_score_policy: rule?.missing_score_policy ?? null,
        rows: batch.map((p) => {
          const row = students[p.row_id].row;
          const totals = row.attendance_totals?.[point] ?? {};
          return {
            row_id: p.row_id,
            features: row.values,
            attendance: { attended: totals.attended ?? null, counted: totals.counted ?? null, next_school_days: nextDays },
          };
        }),
      });
      for (const r of res.results) {
        out.set(r.row_id, {
          status: r.status,
          reason: r.reason ?? null,
          method: r.method ?? null,
          target_point: r.target_point,
          evaluation: r.evaluation,
          caps: r.caps,
          dice: r.dice ?? null,
          options: r.options || [],
          settings: res.settings,
          stats_available: res.stats?.available ?? false,
          model_version: res.model_version,
        });
      }
    } catch (e) {
      log({ level: 'error', msg: 'counterfactual targets failed', run_id: run.run_id, err: e.message });
      for (const p of batch) out.set(p.row_id, { status: 'ERROR', reason: e.message, method: null, options: [] });
    }
  }
  return out;
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
      model = { model_version: out.model_version, threshold: out.threshold, explainer: out.explainer ?? null };
      scored.push(...out.predictions);
    }

    const predictedAt = new Date().toISOString();
    const predictions = scored.map((p) => {
      const { student, row } = students[p.row_id];
      return {
        row_id: p.row_id,
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
        explainer: model.explainer,
        shap_base_value: p.base_value ?? null,
        shap_values: p.contributions ?? null,
        counterfactuals: null,
        predicted_at: predictedAt,
      };
    });
    // The predictions are stored first; targets are added for flagged students afterwards.
    const strip = ({ row_id, ...rest }) => rest;
    await risk.putPredictions(schoolId, predictions.map(strip));

    const flagged = scored.filter((p) => p.at_risk);
    const targets = await targetsFor({ schoolId, run, point, model, students, flagged, terms, term });
    if (targets.size) {
      const withTargets = predictions
        .filter((p) => targets.has(p.row_id))
        .map((p) => ({ ...strip(p), counterfactuals: { ...targets.get(p.row_id), generated_at: new Date().toISOString() } }));
      await risk.putPredictions(schoolId, withTargets);
    }

    const count = (status) => [...targets.values()].filter((t) => t.status === status).length;
    const done = await risk.finishRun(schoolId, run, {
      status: risk.RUN.COMPLETE,
      model_version: model?.model_version ?? null,
      threshold: model?.threshold ?? null,
      students: predictions.length,
      at_risk: flagged.length,
      with_targets: count('FOUND') + count('FALLBACK') + count('MAINTAIN'),
      targets_found: count('FOUND'),
      targets_fallback: count('FALLBACK'),
      targets_maintain: count('MAINTAIN'),
      targets_failed: count('ERROR'),
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
