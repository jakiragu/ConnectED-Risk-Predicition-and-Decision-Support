import { assertAdmin, isAdmin, readableClassIds, subjectsITeach } from '../../library/authz.js';
import { recordingStatus, SUBJECTS } from '../../library/assessment.js';
import { termStatus, todayIn } from '../../library/calendar.js';
import { canSeeFactor, CHECKPOINT_ORDER, INTERVENTION_STATUS, pointIndex, scopeFactors, scopeTargets, scopeView } from '../../library/decisionSupport.js';
import { explain } from '../../library/explanations.js';
import { POINT_NAMES } from '../../library/features.js';
import { CHECKPOINT_LABEL, targetsOf } from '../../library/targets.js';
import { forbidden, notFound } from '../../library/errors.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as interventions from '../../library/interventionRepo.js';
import * as platform from '../../library/platformRepo.js';
import * as risk from '../../library/riskRepo.js';
import { currentYear, latestOf, scopeFor, studentContext, studentYear, visibleInterventions, zone } from '../../library/riskProfile.js';

/**
 * Decision support reads (FR-11, US-01..US-06): a student's risk profile, a
 * teacher's dashboard, and the school-wide overview for administrators. Every
 * factor-level detail (SHAP pushes, targets, interventions, subject results) is
 * cut down to what the person may see: everything for administrators and the
 * class teacher; their own subjects for a subject teacher.
 */

const summary = (p) => p && ({
  prediction_point: p.prediction_point,
  label: CHECKPOINT_LABEL[p.prediction_point] ?? p.prediction_point,
  probability: p.probability,
  at_risk: Boolean(p.at_risk),
  threshold: p.threshold,
  model_version: p.model_version,
  predicted_at: p.predicted_at ?? null,
  targets_status: p.counterfactuals?.status ?? null,
});

const studentView = (s, klass) => ({
  student_id: s.student_id,
  admission_no: s.admission_no ?? '',
  first_name: s.first_name ?? '',
  last_name: s.last_name ?? '',
  class_id: s.class_id ?? null,
  class_name: klass?.name ?? null,
});

const subjectsIn = (row, scope) => (row?.subjects || [])
  .filter((s) => canSeeFactor(scope, s.subject))
  .map((s) => ({ subject: s.subject, score: s.score ?? null, grade: s.grade ?? null }));

/** The first option's changes the person may see, for cards and lists. */
function bestChanges(prediction, scope) {
  const t = scopeTargets(targetsOf(prediction?.counterfactuals), scope);
  if (!t || !['FOUND', 'FALLBACK'].includes(t.status)) return [];
  return t.options[0]?.changes ?? [];
}

// ------------------------------------------------------------------ profile

export async function getStudentRiskProfile(actor, { school_id, student_id, academic_year }) {
  const ctx = await studentContext(actor, school_id, student_id, academic_year ?? null);
  if (!ctx) throw notFound('Student not found');
  if (!ctx.scope) throw forbidden('You do not teach this student');
  const { scope } = ctx;
  const klass = ctx.student.class_id ? await platform.klass(school_id, ctx.student.class_id) : null;
  const year = await studentYear(school_id, student_id, ctx.academicYear, ctx.terms);
  const { latest, current, last_published_point } = latestOf(year);
  const previous = year.predictions.length > 1 ? year.predictions[year.predictions.length - 2] : null;
  const e = latest ? explain(latest) : null;
  const lastResult = year.results[year.results.length - 1] ?? null;

  return {
    student: studentView(ctx.student, klass),
    academic_year: ctx.academicYear,
    scope: ctx.scopeView,
    current,
    last_published_point,
    latest: summary(latest),
    previous: summary(previous),
    base_probability: e?.base_probability ?? null,
    explained: Boolean(e),
    factors: e ? scopeFactors(e.factors, scope) : [],
    targets: latest ? scopeTargets(targetsOf(latest.counterfactuals), scope) : null,
    results: lastResult && {
      point: lastResult.point,
      label: CHECKPOINT_LABEL[lastResult.point] ?? lastResult.point,
      average: scope.all ? lastResult.checkpoint_average ?? null : null,
      subjects: subjectsIn(lastResult, scope),
    },
    risk_trend: year.predictions.map(summary),
    performance_trend: year.results.map((r) => ({
      point: r.point,
      label: CHECKPOINT_LABEL[r.point] ?? r.point,
      average: scope.all ? r.checkpoint_average ?? null : null,
      subjects: subjectsIn(r, scope),
    })),
    interventions: await visibleInterventions(school_id, student_id, scope, year),
  };
}

// ---------------------------------------------------------------- dashboard

/**
 * Each student's latest prediction this year, and every prediction in
 * checkpoint order (for the dashboard's trend lines), from one query per point.
 */
async function latestByStudent(schoolId, year) {
  const out = new Map();
  const trend = new Map();
  if (!year) return { latest: out, trend };
  const lists = await Promise.all(POINT_NAMES.map((point) => risk.listForPoint(schoolId, year, point)));
  for (const p of lists.flat()) {
    const prev = out.get(p.student_id);
    if (!prev || pointIndex(p.prediction_point) > pointIndex(prev.prediction_point)) out.set(p.student_id, p);
    trend.set(p.student_id, [...(trend.get(p.student_id) || []), p]);
  }
  for (const list of trend.values()) list.sort((a, b) => pointIndex(a.prediction_point) - pointIndex(b.prediction_point));
  return { latest: out, trend };
}

export async function getRiskDashboard(actor, { school_id }) {
  const [allClasses, terms] = await Promise.all([platform.listClasses(school_id), platform.listTerms(school_id)]);
  const ids = isAdmin(actor) ? null : readableClassIds(actor);
  const classes = allClasses.filter((c) => (ids ? ids.has(c.class_id) : c.status !== 'PAST'));
  const today = todayIn(zone());
  const year = currentYear(terms, today);
  const currentTerm = terms.find((t) => Number(t.academic_year) === Number(year) && termStatus(t, today) === 'CURRENT') ?? null;
  const { latest, trend } = await latestByStudent(school_id, year);

  const atRisk = [];
  const ongoing = [];
  const pending = [];
  let students = 0;
  let flagged = 0;

  for (const klass of classes) {
    const scope = scopeFor(actor, klass.class_id);
    const [roster, logged] = await Promise.all([
      platform.listStudents(school_id, klass.class_id),
      scope ? interventions.listForClass(school_id, klass.class_id) : [],
    ]);
    const names = new Map(roster.map((s) => [s.student_id, s]));

    if (scope) {
      students += roster.length;
      const mine = logged.filter((i) => canSeeFactor(scope, i.factor) && i.status === INTERVENTION_STATUS.ONGOING && names.has(i.student_id));
      for (const i of mine) {
        const s = names.get(i.student_id);
        ongoing.push({
          intervention_id: i.intervention_id, student_id: i.student_id, student_name: `${s.first_name} ${s.last_name}`,
          class_name: klass.name, factor: i.factor, method: i.method, frequency: i.frequency, started_on: i.started_on,
        });
      }
      for (const s of roster) {
        const p = latest.get(s.student_id);
        if (!p?.at_risk) continue;
        flagged += 1;
        atRisk.push({
          student: studentView(s, klass),
          latest: summary(p),
          trend: (trend.get(s.student_id) || []).map(summary),
          targets: bestChanges(p, scope),
          partial: !scope.all,
          interventions: mine.filter((i) => i.student_id === s.student_id).map((i) => i.method),
        });
      }
    }

    // Papers this person enters marks for, still being recorded this term.
    if (currentTerm) {
      const subjects = isAdmin(actor) ? new Set(SUBJECTS) : new Set(subjectsITeach(actor, klass.class_id));
      if (subjects.size) {
        const papers = await assessments.listAllLive(school_id, klass.class_id, currentTerm.term_id);
        for (const a of papers.filter((x) => subjects.has(x.subject))) {
          const status = recordingStatus(a, roster.length);
          if (status !== 'UNRECORDED' && status !== 'RECORDING') continue;
          pending.push({
            assessment_id: a.assessment_id, class_name: klass.name, subject: a.subject, title: a.title,
            assessment_type: a.assessment_type, status, missing: Math.max(roster.length - (a.score_count || 0), 0), due_date: a.due_date ?? null,
          });
        }
      }
    }
  }

  return {
    academic_year: year,
    term_name: currentTerm?.name ?? null,
    classes: classes.length,
    students,
    at_risk: flagged,
    at_risk_students: atRisk.sort((a, b) => b.latest.probability - a.latest.probability),
    ongoing_interventions: ongoing.sort((a, b) => String(b.started_on).localeCompare(String(a.started_on))),
    pending_assessments: pending,
  };
}

// --------------------------------------------------------- school overview

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export async function getSchoolRiskOverview(actor, { school_id, academic_year }) {
  assertAdmin(actor);
  const [classes, terms] = await Promise.all([platform.listClasses(school_id), platform.listTerms(school_id)]);
  const year = academic_year ?? currentYear(terms);
  const byPoint = year ? await Promise.all(POINT_NAMES.map((point) => risk.listForPoint(school_id, year, point))) : POINT_NAMES.map(() => []);
  const classById = new Map(classes.map((c) => [c.class_id, c]));

  const points = POINT_NAMES.map((point, i) => {
    const list = byPoint[i];
    const flagged = list.filter((p) => p.at_risk).length;
    return { point, label: CHECKPOINT_LABEL[point], students: list.length, at_risk: flagged, rate: rate(flagged, list.length) };
  });

  // Per class and per form (grade): the at-risk rate at each point, from the class the prediction was made in.
  const groupRows = (keyOf, labelOf) => {
    const rows = new Map();
    POINT_NAMES.forEach((point, i) => {
      for (const p of byPoint[i]) {
        const key = keyOf(p);
        if (key == null) continue;
        if (!rows.has(key)) rows.set(key, { key, label: labelOf(key), points: Object.fromEntries(POINT_NAMES.map((x) => [x, { students: 0, at_risk: 0 }])) });
        const cell = rows.get(key).points[point];
        cell.students += 1;
        if (p.at_risk) cell.at_risk += 1;
      }
    });
    return [...rows.values()].map((r) => {
      const series = POINT_NAMES.map((point) => ({ point, students: r.points[point].students, at_risk: r.points[point].at_risk, rate: rate(r.points[point].at_risk, r.points[point].students) }));
      const last = [...series].reverse().find((x) => x.students) ?? null;
      return { key: r.key, label: r.label, series, latest: last };
    }).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  };

  const classRows = groupRows((p) => p.class_id ?? null, (id) => classById.get(id)?.name ?? id);
  const counts = await Promise.all(classRows.map((r) => interventions.listForClass(school_id, r.key)));
  classRows.forEach((r, i) => {
    r.interventions_ongoing = counts[i].filter((x) => x.status === INTERVENTION_STATUS.ONGOING).length;
    r.interventions_logged = counts[i].length;
  });
  const formRows = groupRows((p) => classById.get(p.class_id)?.grade ?? null, (g) => String(g)); // grade is already "Form 4"

  return {
    academic_year: year ?? null,
    points,
    forms: formRows,
    classes: classRows,
    interventions_ongoing: classRows.reduce((s, r) => s + r.interventions_ongoing, 0),
    interventions_logged: classRows.reduce((s, r) => s + r.interventions_logged, 0),
    checkpoints: CHECKPOINT_ORDER,
  };
}
