import {
  identityOf,
  assertTenant,
  assertClassAccess,
  assertCanPublish,
  assertGradebookRole,
  canReviewResults,
} from '../../library/authz.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import {
  calculateCheckpoint,
  checkpointWeightProblems,
  resultsPublishedEvent,
  CHECKPOINT,
  CHECKPOINTS,
  CHECKPOINT_LABEL,
  CHECKPOINT_TYPE,
  PREVIOUS,
  SEVERITY,
  kindOf,
} from '../../library/results.js';
import { emit } from '../../library/events.js';
import { startReportCards, executionName } from '../../library/workflow.js';
import * as results from '../../library/resultsRepo.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as scores from '../../library/scoreRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function handler(event) {
  const actor = identityOf(event);
  const args = event.arguments || {};
  const input = args.input || args;

  switch (event.info.fieldName) {
    case 'calculateTermResults':
      return calculateTermResults(actor, input);
    case 'calculateSchoolResults':
      return forClasses(actor, input, (classId) => calculateTermResults(actor, { ...input, class_id: classId }));
    case 'publishResults':
      return publishResults(actor, input);
    case 'publishSchoolResults':
      return forClasses(actor, { ...input, class_ids: (input.classes || []).map((c) => c.class_id) }, (classId) =>
        publishResults(actor, { ...input, class_id: classId, _version: input.classes.find((c) => c.class_id === classId)._version })
      );
    case 'listResultSets':
      return listResultSets(actor, args);
    case 'listCheckpointStatus':
      return listCheckpointStatus(actor, args);
    case 'getTermResults':
      return getTermResults(actor, args);
    case 'getGradeRule':
      return getGradeRule(actor, args);
    case 'setCheckpointWeights':
      return setCheckpointWeights(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const TERM_LOCKED = 'End of term results for this class are published, so the term is locked';
const ALREADY_PUBLISHED = 'These results are already published. Correcting published results is not available yet.';
const STALE = 'These results were recalculated after you opened them. Review the latest calculation and try again.';
const MARKS_MOVED = 'Marks or papers changed after these results were calculated. Recalculate and review again.';
const STALE_PUBLISHED = 'These results were published from a different calculation than the one you reviewed.';
const WEIGHTS_MOVED = 'Checkpoint weights changed after these results were calculated. Recalculate and review again.';
const WEIGHTS_LOCKED = 'End of term results are published for this term, so checkpoint weights can no longer change.';
const notYet = (checkpoint) =>
  `${CHECKPOINT_LABEL[PREVIOUS[checkpoint]]} results must be published before ${CHECKPOINT_LABEL[checkpoint]} results`;

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'results-service', ...o }));

function scopeOf(input) {
  const checkpoint = input.checkpoint;
  if (!CHECKPOINTS.includes(checkpoint)) throw validation(`Checkpoint must be one of ${CHECKPOINTS.join(', ')}`, 'checkpoint');
  if (!input.class_id) throw validation('Choose a class', 'class_id');
  if (!input.term_id) throw validation('Choose a term', 'term_id');
  return { termId: input.term_id, classId: input.class_id, checkpoint };
}

async function requireTerm(schoolId, termId) {
  if (!termId || !(await platform.term(schoolId, termId))) throw notFound('Term not found');
}

async function requireClass(actor, schoolId, classId) {
  if (!(await platform.klass(schoolId, classId))) throw notFound('Class not found');
  assertClassAccess(actor, classId, await platform.assignments(actor.schoolId, actor.sub));
}

const reportCount = (set) => (set.report_cards_done ? [...set.report_cards_done].length : 0);

/** The GraphQL view of a result set. Teachers only ever see published sets. */
function view(set, scope, schoolId, actor) {
  const base = {
    school_id: schoolId, class_id: scope.classId, term_id: scope.termId, checkpoint: scope.checkpoint,
    kind: kindOf(scope.checkpoint), subjects: [], issues: [], blocking: false, assessment_count: 0, student_count: 0,
    report_cards_generated: 0, report_cards_expected: 0,
  };
  if (!set) return { ...base, status: 'NOT_CALCULATED' };
  const reviewer = canReviewResults(actor);
  const published = set.status === results.STATUS.PUBLISHED;
  if (!reviewer && !published) return { ...base, status: 'UNPUBLISHED' };
  return {
    ...base,
    status: set.status,
    calculation_id: set.calculation_id,
    subjects: set.subjects || [],
    assessment_count: (set.basis || []).length,
    student_count: (set.student_ids || []).length,
    blocking: Boolean(set.blocking),
    issues: reviewer ? set.issues || [] : [],
    calculated_at: set.calculated_at,
    calculated_by: set.calculated_by,
    published_at: set.published_at ?? null,
    published_by: set.published_by ?? null,
    event_status: reviewer ? set.event_status ?? null : null,
    report_cards_status: published ? set.report_cards_status ?? null : null,
    report_cards_generated: published ? reportCount(set) : 0,
    report_cards_expected: published ? set.report_cards_expected ?? (set.student_ids || []).length : 0,
    report_error: reviewer ? set.report_error ?? null : null,
    checkpoint_weights: set.basis_checkpoint_weights ?? null,
    _version: set._version,
  };
}

/** Rows of a published checkpoint, by student, for the End of term combination. */
async function publishedRows(schoolId, scope, checkpoint) {
  const set = await results.getSet(schoolId, { ...scope, checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) return null;
  return { set, rows: new Map((await results.listRows(schoolId, set)).map((r) => [r.student_id, r])) };
}

async function calculateTermResults(actor, input) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  const scope = scopeOf(input);
  const schoolId = input.school_id;
  await requireTerm(schoolId, scope.termId);
  await requireClass(actor, schoolId, scope.classId);

  if (await assessments.termLocked(schoolId, scope.termId, scope.classId)) throw locked(TERM_LOCKED);
  const existing = await results.getSet(schoolId, scope);
  if (existing?.status === results.STATUS.PUBLISHED) throw locked(ALREADY_PUBLISHED);

  const [live, roster, gradeRule] = await Promise.all([
    assessments.listAllLive(schoolId, scope.classId, scope.termId),
    platform.roster(schoolId, scope.classId),
    platform.gradeRule(schoolId, scope.termId),
  ]);
  const type = CHECKPOINT_TYPE[scope.checkpoint];
  const scoresByAssessment = new Map(
    await Promise.all(
      live.filter((a) => a.assessment_type === type)
        .map(async (a) => [a.assessment_id, await scores.listByAssessment(schoolId, a.assessment_id)])
    )
  );

  const previous = PREVIOUS[scope.checkpoint];
  const prior = previous ? await publishedRows(schoolId, scope, previous) : null;
  const previousRows = {};
  const extra = {};
  if (scope.checkpoint === CHECKPOINT.ENDTERM) {
    const opener = await publishedRows(schoolId, scope, CHECKPOINT.OPENER);
    if (opener) previousRows.OPENER = opener.rows;
    if (prior) previousRows.MIDTERM = prior.rows;
    extra.basis_previous = { OPENER: opener?.set.calculation_id ?? null, MIDTERM: prior?.set.calculation_id ?? null };
    extra.basis_checkpoint_weights = gradeRule?.checkpoint_weights ?? null;
    extra.basis_weights_version = gradeRule?.checkpoint_weights_version ?? 0;
  }

  const calc = calculateCheckpoint({
    checkpoint: scope.checkpoint,
    assessments: live,
    scoresByAssessment,
    roster,
    gradeRule,
    previousPublished: Boolean(prior),
    previousRows,
  });

  let saved;
  try {
    saved = await results.saveCalculation(schoolId, scope, { calculationId: ulid(), calc, existing, actor, extra });
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (assessments.cancelledAt(e, 1)) throw locked(TERM_LOCKED);
    throw conflict('Someone else recalculated these results at the same time. Reload and try again.');
  }
  if (existing) await results.dropRows(schoolId, existing).catch((e) => log({ msg: 'drop rows failed', err: e.message }));
  log({ op: 'calculate', ...scope, students: calc.rows.length, blocking: calc.blocking, version: saved._version });
  return view(saved, scope, schoolId, actor);
}

/** At-least-once ResultsPublished. A failure never undoes the publication. */
async function ensureEvent(schoolId, set) {
  if (set.event_status === results.EVENT_STATUS.SENT) return set;
  try {
    await emit(resultsPublishedEvent(set));
    return await results.markEventSent(schoolId, set);
  } catch (e) {
    log({ level: 'error', msg: 'ResultsPublished not delivered; publish again to resend', event_id: set.event_id, err: e.message });
    return set;
  }
}

/** Starts (or restarts after failure) the report-card workflow for a published set. */
async function ensureReports(schoolId, set) {
  let current = set;
  if (current.report_cards_status === results.REPORTS.FAILED) current = await results.retryReports(schoolId, current);
  if (current.report_cards_status !== results.REPORTS.PENDING) return current;
  try {
    const { executionArn } = await startReportCards(
      executionName('rc', current.calculation_id, `a${current.report_attempt}`),
      {
        school_id: current.school_id,
        class_id: current.class_id,
        term_id: current.term_id,
        checkpoint: current.checkpoint,
        calculation_id: current.calculation_id,
        student_ids: current.student_ids || [],
      }
    );
    return await results.markReportsRunning(schoolId, current, executionArn);
  } catch (e) {
    log({ level: 'error', msg: 'Report cards not started; publish again to retry', set: current.SK, err: e.message });
    return current;
  }
}

async function afterPublish(schoolId, set) {
  const withEvent = await ensureEvent(schoolId, set);
  return ensureReports(schoolId, withEvent);
}

async function publishResults(actor, input) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  const scope = scopeOf(input);
  const schoolId = input.school_id;
  await requireClass(actor, schoolId, scope.classId);

  const set = await results.getSet(schoolId, scope);
  if (!set) throw notFound(`Calculate the ${CHECKPOINT_LABEL[scope.checkpoint]} results before publishing them`);

  if (set.status === results.STATUS.PUBLISHED) {
    if (input._version !== set.published_from_version) throw conflict(STALE_PUBLISHED);
    return view(await afterPublish(schoolId, set), scope, schoolId, actor); // retry: same outcome, resumes side effects
  }
  if (input._version !== set._version) throw conflict(STALE);
  if (set.blocking) {
    const first = set.issues.find((i) => i.severity === SEVERITY.BLOCKING);
    throw validation(`Cannot publish: ${first?.message || 'the calculation has blocking problems'}`, 'checkpoint');
  }
  const previous = PREVIOUS[scope.checkpoint];
  if (previous && (await results.getSet(schoolId, { ...scope, checkpoint: previous }))?.status !== results.STATUS.PUBLISHED) {
    throw validation(notYet(scope.checkpoint), 'checkpoint');
  }
  if (scope.checkpoint === CHECKPOINT.ENDTERM) {
    const rule = await platform.gradeRule(schoolId, scope.termId);
    if (checkpointWeightProblems(rule?.checkpoint_weights).length) {
      throw validation(`Cannot publish: ${checkpointWeightProblems(rule?.checkpoint_weights)[0]}`, 'checkpoint');
    }
    if ((rule.checkpoint_weights_version ?? 0) !== set.basis_weights_version) throw conflict(WEIGHTS_MOVED);
  }
  if (set.basis.length > results.MAX_PUBLISH_PAPERS) {
    throw validation(`At most ${results.MAX_PUBLISH_PAPERS} papers can be published together`, 'checkpoint');
  }

  let published;
  try {
    published = await results.publish(schoolId, set, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    const failed = (name) => assessments.cancelledAt(e, e.publishIndex[name]);
    if (failed('set')) {
      const fresh = await results.getSet(schoolId, scope);
      if (fresh?.status === results.STATUS.PUBLISHED && fresh.published_from_version === input._version) {
        return view(await afterPublish(schoolId, fresh), scope, schoolId, actor); // a concurrent retry won
      }
      throw conflict(STALE);
    }
    if (failed('gate')) throw locked(TERM_LOCKED);
    if (e.publishIndex.previous !== undefined && failed('previous')) throw validation(notYet(scope.checkpoint), 'checkpoint');
    if (e.publishIndex.weights !== undefined && failed('weights')) throw conflict(WEIGHTS_MOVED);
    if ((e.CancellationReasons || []).slice(e.publishIndex.papers).some((r) => r?.Code === 'ConditionalCheckFailed')) {
      throw conflict(MARKS_MOVED);
    }
    throw e;
  }
  log({ op: 'publish', ...scope, version: published._version, event_id: published.event_id });
  return view(await afterPublish(schoolId, published), scope, schoolId, actor);
}

/**
 * School-wide action: runs the per-class operation for each selected class.
 * Each class succeeds or fails on its own; one blocked class never stops the others.
 */
async function forClasses(actor, input, run) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  if (!CHECKPOINTS.includes(input.checkpoint)) throw validation('Choose a checkpoint', 'checkpoint');
  await requireTerm(input.school_id, input.term_id);
  const classes = await platform.listClasses(input.school_id);
  const wanted = input.class_ids?.length ? input.class_ids : classes.map((c) => c.class_id);
  const byId = new Map(classes.map((c) => [c.class_id, c]));

  const outcomes = [];
  for (const classId of [...new Set(wanted)]) {
    const klass = byId.get(classId);
    try {
      if (!klass) throw notFound('Class not found');
      const set = await run(classId);
      outcomes.push({ class_id: classId, class_name: klass.name, ok: true, error_type: null, message: null, result_set: set });
    } catch (e) {
      if (!e.type) throw e; // infrastructure failure: surface it rather than hide it per class
      const current = klass ? await results.getSet(input.school_id, { termId: input.term_id, classId, checkpoint: input.checkpoint }) : null;
      outcomes.push({
        class_id: classId,
        class_name: klass?.name ?? classId,
        ok: false,
        error_type: e.type,
        message: e.message,
        result_set: klass ? view(current, { termId: input.term_id, classId, checkpoint: input.checkpoint }, input.school_id, actor) : null,
      });
    }
  }
  return outcomes;
}

async function listResultSets(actor, { school_id, class_id, term_id }) {
  assertTenant(actor, school_id);
  await requireClass(actor, school_id, class_id);
  const sets = await results.listSetsForClass(school_id, { termId: term_id, classId: class_id });
  const byCheckpoint = new Map(sets.map((s) => [s.checkpoint, s]));
  return CHECKPOINTS.map((checkpoint) =>
    view(byCheckpoint.get(checkpoint) || null, { termId: term_id, classId: class_id, checkpoint }, school_id, actor)
  );
}

/** One checkpoint across every class the actor may see: the school-wide publishing list. */
async function listCheckpointStatus(actor, { school_id, term_id, checkpoint }) {
  assertTenant(actor, school_id);
  assertGradebookRole(actor);
  if (!CHECKPOINTS.includes(checkpoint)) throw validation('Choose a checkpoint', 'checkpoint');
  let classes = await platform.listClasses(school_id);
  if (!canReviewResults(actor)) {
    const mine = new Set(await platform.assignments(actor.schoolId, actor.sub));
    classes = classes.filter((c) => mine.has(c.class_id));
  }
  const sets = await results.listSetsForTerm(school_id, term_id);
  const byClass = new Map(sets.filter((s) => s.checkpoint === checkpoint).map((s) => [s.class_id, s]));
  return classes.map((c) => ({
    class_id: c.class_id,
    class_name: c.name,
    result_set: view(byClass.get(c.class_id) || null, { termId: term_id, classId: c.class_id, checkpoint }, school_id, actor),
  }));
}

async function getTermResults(actor, args) {
  assertTenant(actor, args.school_id);
  const scope = scopeOf(args);
  await requireClass(actor, args.school_id, scope.classId);
  const set = await results.getSet(args.school_id, scope);
  if (!set) return [];
  const published = set.status === results.STATUS.PUBLISHED;
  if (!published && !canReviewResults(actor)) return [];
  const rows = await results.listRows(args.school_id, set);
  return rows.map((r) => ({
    term_result_id: r.term_result_id,
    school_id: r.school_id,
    class_id: r.class_id,
    term_id: r.term_id,
    student_id: r.student_id,
    checkpoint: r.checkpoint,
    kind: r.kind,
    subjects: r.subjects,
    checkpoint_average: r.checkpoint_average,
    term_average: r.term_average,
    term_grade: r.term_grade,
    published,
    published_at: published ? set.published_at : null,
  }));
}

const weightsView = (w) => (w ? { opener: w.OPENER ?? null, midterm: w.MIDTERM ?? null, endterm: w.ENDTERM ?? null } : null);

async function finalPublishedInTerm(schoolId, termId) {
  const sets = await results.listSetsForTerm(schoolId, termId);
  return sets.some((s) => s.checkpoint === CHECKPOINT.ENDTERM && s.status === results.STATUS.PUBLISHED);
}

async function getGradeRule(actor, { school_id, term_id }) {
  assertTenant(actor, school_id);
  assertGradebookRole(actor);
  const rule = await platform.gradeRule(school_id, term_id);
  if (!rule) return null;
  return {
    term_id,
    pass_mark: rule.pass_mark ?? null,
    missing_score_policy: rule.missing_score_policy ?? null,
    bands: rule.bands || [],
    checkpoint_weights: weightsView(rule.checkpoint_weights),
    checkpoint_weights_version: rule.checkpoint_weights_version ?? 0,
    checkpoint_weights_problems: checkpointWeightProblems(rule.checkpoint_weights),
    checkpoint_weights_locked: await finalPublishedInTerm(school_id, term_id),
  };
}

async function setCheckpointWeights(actor, input) {
  assertTenant(actor, input.school_id);
  assertGradebookRole(actor);
  await requireTerm(input.school_id, input.term_id);
  const weights = { OPENER: Number(input.opener), MIDTERM: Number(input.midterm), ENDTERM: Number(input.endterm) };
  const problems = checkpointWeightProblems(weights);
  if (problems.length) throw validation(problems[0], 'checkpoint_weights');
  if (!(await platform.gradeRule(input.school_id, input.term_id))) throw notFound('No grading rule is set for this term');
  if (await finalPublishedInTerm(input.school_id, input.term_id)) throw locked(WEIGHTS_LOCKED);
  try {
    await platform.setCheckpointWeights(input.school_id, input.term_id, weights, input._version ?? 0, actor);
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw conflict('Someone else changed the checkpoint weights. Reload and try again.');
  }
  return getGradeRule(actor, { school_id: input.school_id, term_id: input.term_id });
}