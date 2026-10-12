import {
  assertTenant,
  assertClassRead,
  assertClassTeacherOrAdmin,
  assertCanPublish,
  assertGradebookRole,
  canReviewResults,
  readableClassIds,
  visibleSubjects,
} from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, s3 } from '../../library/client.js';
import { TABLE, pk, sk } from '../../library/keys.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import {
  calculateCheckpoint,
  checkpointWeightProblems,
  resultsPublishedEvent,
  CHECKPOINT,
  CHECKPOINTS,
  CHECKPOINT_LABEL,
  assessmentCheckpoint,
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
import * as history from '../../library/historyRepo.js';

export async function handler(event) {
  const actor = await resolveActor(event);
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
    case 'listReportCards':
      return listReportCards(actor, args);
    case 'requestReportCardDownload':
      return requestReportCardDownload(actor, input);
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
  assertClassRead(actor, classId);
}

/** A subject teacher sees only their subjects; the class teacher and administrators see all. */
function subjectsFor(actor, classId, subjects) {
  const visible = visibleSubjects(actor, classId);
  return visible === null ? subjects : subjects.filter((s) => visible.has(s));
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
    subjects: subjectsFor(actor, scope.classId, set.subjects || []),
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
  const scoresByAssessment = new Map(
    await Promise.all(
      live.filter((a) => assessmentCheckpoint(a.assessment_type) === scope.checkpoint)
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

/**
 * Copies the published rows into each student's history (historyRepo). Runs
 * before ResultsPublished is sent, because consumers of the event read the
 * history. Idempotent; a failure is retried by publishing again.
 */
async function ensureHistory(schoolId, set) {
  if (history.historyWritten(set)) return { set, ok: true };
  try {
    const [rows, term] = await Promise.all([results.listRows(schoolId, set), platform.term(schoolId, set.term_id)]);
    await history.writeHistory(schoolId, set, rows, term);
    return { set: await history.markHistoryWritten(schoolId, set), ok: true };
  } catch (e) {
    log({ level: 'error', msg: 'Student history not written; publish again to retry', set: set.SK, err: e.message });
    return { set, ok: false };
  }
}

async function afterPublish(schoolId, set) {
  const recorded = await ensureHistory(schoolId, set);
  // The event tells consumers the history is there, so it waits for it; report cards do not.
  const withEvent = recorded.ok ? await ensureEvent(schoolId, recorded.set) : recorded.set;
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
    const mine = readableClassIds(actor);
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
    subjects: subjectsFor(actor, scope.classId, r.subjects.map((x) => x.subject))
      .map((name) => r.subjects.find((x) => x.subject === name)),
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

// ------------------------------------------------------------ report cards

const DOWNLOAD_SECONDS = 300;
const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** Report cards of a published class checkpoint. Administrators and the class's class teacher only. */
async function listReportCards(actor, args) {
  assertTenant(actor, args.school_id);
  const scope = scopeOf(args);
  if (!(await platform.klass(args.school_id, scope.classId))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, scope.classId);
  const set = await results.getSet(args.school_id, scope);
  if (set?.status !== results.STATUS.PUBLISHED) return [];

  const cards = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      FilterExpression: 'class_id = :c AND calculation_id = :k',
      ExpressionAttributeValues: {
        ':p': pk(args.school_id), ':s': sk.reportCardPrefix(scope.termId, scope.checkpoint),
        ':c': scope.classId, ':k': set.calculation_id,
      },
      ExclusiveStartKey,
    }));
    cards.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const byStudent = new Map(cards.map((c) => [c.student_id, c]));

  const students = await Promise.all((set.student_ids || []).map((id) => platform.student(args.school_id, id)));
  return students.filter(Boolean)
    .sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }))
    .map((st) => {
      const card = byStudent.get(st.student_id);
      return {
        student_id: st.student_id,
        admission_no: st.admission_no,
        first_name: st.first_name,
        last_name: st.last_name,
        student_status: st.status || 'ACTIVE',
        checkpoint: scope.checkpoint,
        kind: card?.kind ?? null,
        available: Boolean(card),
        generated_at: card?.generated_at ?? null,
      };
    });
}

async function requestReportCardDownload(actor, input) {
  assertTenant(actor, input.school_id);
  const scope = scopeOf(input);
  if (!(await platform.klass(input.school_id, scope.classId))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, scope.classId);
  const set = await results.getSet(input.school_id, scope);
  if (set?.status !== results.STATUS.PUBLISHED) throw validation('These results are not published', 'checkpoint');
  const card = await results.getReportCard(input.school_id, scope.termId, scope.checkpoint, input.student_id);
  if (!card || card.class_id !== scope.classId || card.calculation_id !== set.calculation_id) {
    throw notFound('This report card has not been produced yet');
  }
  const student = await platform.student(input.school_id, input.student_id);
  const fileName = `${safe(student?.admission_no)}-${safe(`${student?.first_name ?? ''} ${student?.last_name ?? ''}`)}-${safe(scope.termId)}-${scope.checkpoint}.pdf`;

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: card.s3_bucket || process.env.REPORT_BUCKET,
      Key: card.s3_key,
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
      ResponseContentType: 'application/pdf',
    }),
    { expiresIn: DOWNLOAD_SECONDS }
  );
  const at = new Date();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: pk(input.school_id),
      SK: sk.reportCardDownload(ulid()),
      entity: 'ReportCardDownload',
      school_id: input.school_id,
      class_id: scope.classId,
      term_id: scope.termId,
      checkpoint: scope.checkpoint,
      student_id: input.student_id,
      calculation_id: set.calculation_id,
      s3_key: card.s3_key,
      requested_by: actor.sub,
      requested_at: at.toISOString(),
    },
  }));
  log({ op: 'report-card-download', ...scope, student_id: input.student_id, by: actor.sub });
  return { url, file_name: fileName, expires_at: new Date(at.getTime() + DOWNLOAD_SECONDS * 1000).toISOString() };
}