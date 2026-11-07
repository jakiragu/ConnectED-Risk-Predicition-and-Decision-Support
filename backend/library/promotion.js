/**
 * Year-end promotion: the pure rules, with no database access.
 *
 * A school year closes by moving every active student of that year's classes
 * into next year's classes. Classes are year-scoped (Form 3 East 2026 and
 * Form 4 East 2027 are different classes), so nothing historical is renamed:
 * published results, report cards, risk predictions and interventions keep the
 * class they were made in, and only the student's class pointer moves.
 *
 * Each active student gets one action:
 *   PROMOTE   passing student, next level, next year
 *   REPEAT    below-pass student, same level, next year
 *   GRADUATE  passing student at a known terminal level; the student stays on their
 *             final class and becomes GRADUATED
 *   LEAVE     the student becomes INACTIVE and stays on their class
 *
 * A destination is named by a key, `<level>|<stream>`, so the plan can point at
 * a class that does not exist yet ("Form 4 East 2027, will be created").
 *
 * The plan is always rebuilt on the server from what is stored; the client only
 * sends overrides. Anything that would make the run unsafe is a blocker.
 */

export const DEFAULT_FORMS = ['Form 1', 'Form 2', 'Form 3', 'Form 4'];

export const ACTION = { PROMOTE: 'PROMOTE', REPEAT: 'REPEAT', GRADUATE: 'GRADUATE', LEAVE: 'LEAVE' };
export const ACTIONS = Object.values(ACTION);
/** Actions that move the student to a class of the next year. */
export const MOVES_CLASS = new Set([ACTION.PROMOTE, ACTION.REPEAT]);

export const STUDENT_STATUS = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE', GRADUATED: 'GRADUATED' };

export const BLOCKER = {
  NO_CLASSES: 'NO_CLASSES',
  NO_TERM3: 'NO_TERM3',
  UNPUBLISHED: 'UNPUBLISHED',
  UNKNOWN_LEVEL: 'UNKNOWN_LEVEL',
  NAME_TAKEN: 'NAME_TAKEN',
  INVALID_CHOICE: 'INVALID_CHOICE',
};

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const isActive = (s) => (s.status || STUDENT_STATUS.ACTIVE) === STUDENT_STATUS.ACTIVE;

/**
 * "Form 3" -> { track: 'form', n: 3 }; "Grade 10" -> { track: 'grade', n: 10 }.
 * A form with no number cannot be ordered, so it has no place in a ladder.
 */
export function parseForm(name) {
  const m = String(name ?? '').trim().replace(/\s+/g, ' ').match(/^(.*?)\s*(\d+)$/);
  return m ? { track: m[1].toLowerCase(), n: Number(m[2]) } : null;
}

/** Explicit curricula: configured class lists never define graduation. */
export const PATHWAYS = {
  FORM: ['Form 1', 'Form 2', 'Form 3', 'Form 4'],
  GRADE: ['Grade 10', 'Grade 11', 'Grade 12'],
};
export function levelsFromForms(forms = DEFAULT_FORMS, pathways = null) {
  const enabled = pathways ?? Object.keys(PATHWAYS).filter((key) =>
    forms.some((f) => PATHWAYS[key].some((l) => norm(l) === norm(f))));
  const levels = [], finals = new Set();
  for (const key of ['FORM', 'GRADE']) if (enabled.includes(key)) {
    levels.push(...PATHWAYS[key]);
    finals.add(levels.length);
  }
  return { levels, finals };
}

/** Validate the published aggregate; never invent a result from marks or risk. */
export function finalResultProblem(row, set) {
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  if (!row) return 'Published final result is missing';
  if (!valid(row.term_average)) return 'Final overall average is missing or invalid';
  if (row.kind !== 'FINAL' || !row.subjects?.length || !set?.subjects?.length) return 'Final result is incomplete';
  if (set.subjects.some((name) => !row.subjects.some((s) => s.subject === name))) return 'Final result is missing subjects';
  if (row.subjects.some((s) => !valid(s.term?.term_score) || s.term?.weight_applied !== 100 || (s.missing_count || 0) > 0)) return 'Final result has incomplete subject or checkpoint coverage';
  return null;
}

/** The school's forms, or the defaults plus any form its classes already use when it has not saved its own. */
export function formsForSchool(savedSetup, classes = []) {
  if (savedSetup?.forms?.length) return savedSetup.forms;
  return [...new Set([...DEFAULT_FORMS, ...classes.map((c) => c.grade).filter(Boolean)])];
}

/** 1-based position of a grade ("Form 3") in the levels, or null when it is not one of them. */
export function levelOfGrade(grade, levels = DEFAULT_FORMS) {
  const i = levels.findIndex((l) => norm(l) === norm(grade));
  return i < 0 ? null : i + 1;
}

/** The form name decides; nothing is stored, so a change in Settings can never leave a class with a stale level. */
export const levelOfClass = (klass, levels = DEFAULT_FORMS) => levelOfGrade(klass?.grade, levels);

export const defaultClassName = (grade, stream) => `${String(grade).trim()} ${String(stream).trim()}`;
export const destinationKey = (level, stream) => `${level}|${norm(stream)}`;

/** Two classes of one year may not share a name; different years may. */
export const sameName = (a, b) => norm(a) === norm(b);

/**
 * @param {object} p
 * @param {number} p.fromYear
 * @param {{levels:string[], finals:Set<number>}} [p.ladder]   from levelsFromForms
 * @param {object[]} p.classes            every class of the school
 * @param {Map<string, object[]>} p.studentsByClass   students of each source class (any status)
 * @param {object|null} p.term3           the Term 3 of fromYear, if set up
 * @param {object[]} p.term3Sets          result sets of that term (any checkpoint, any class)
 * @param {{student_id:string, action:string, to_key?:string}[]} [p.overrides]
 * @param {Map<string,string>} [p.teacherNames]
 */
export function buildPlan({ fromYear, ladder = levelsFromForms(DEFAULT_FORMS), classes, studentsByClass, term3, term3Sets = [], overrides = [], teacherNames = new Map(), finalRows = new Map(), passMark = 50, teacherStrategy = 'FOLLOW', studentCounts = new Map() }) {
  const toYear = fromYear + 1;
  const { levels, finals } = ladder;
  const isFinal = (level) => finals.has(level);
  const blockers = [];
  const block = (code, message, classId = null) => blockers.push({ code, class_id: classId, message });

  const sources = classes
    .filter((c) => Number(c.year) === fromYear && (c.status || 'CURRENT') === 'CURRENT')
    .sort((a, b) => (levelOfClass(a, levels) ?? 99) - (levelOfClass(b, levels) ?? 99) || a.name.localeCompare(b.name));
  const nextYear = classes.filter((c) => Number(c.year) === toYear);

  if (!sources.length) block(BLOCKER.NO_CLASSES, `There are no current classes in ${fromYear} to promote.`);
  if (!term3) block(BLOCKER.NO_TERM3, `Term 3 of ${fromYear} has not been set up, so its End of term results cannot have been published.`);

  // --- destinations: existing next-year classes first, then the ones the plan would create
  const choices = new Map();
  for (const c of nextYear) {
    if ((c.status || 'CURRENT') !== 'CURRENT') continue;
    const level = levelOfClass(c, levels);
    if (!level) continue;
    const key = destinationKey(level, c.stream);
    if (!choices.has(key)) {
      choices.set(key, { key, class_id: c.class_id, name: c.name, grade: c.grade, stream: c.stream, year: toYear, level, exists: true });
    }
  }
  const candidate = (level, stream) => {
    const key = destinationKey(level, stream);
    if (!choices.has(key)) {
      const grade = levels[level - 1];
      choices.set(key, { key, class_id: null, name: defaultClassName(grade, stream), grade, stream: String(stream).trim(), year: toYear, level, exists: false });
    }
    return choices.get(key);
  };

  // --- published Term 3 End of term results, per class
  const published = new Set(
    term3Sets.filter((s) => s.checkpoint === 'ENDTERM' && s.status === 'PUBLISHED').map((s) => s.class_id)
  );

  if (typeof passMark !== 'number' || !Number.isFinite(passMark) || passMark < 0 || passMark > 100) block('INVALID_PASS_MARK', 'Fix the school pass mark in grading settings.');
  const planned = [];
  const byStudent = new Map();
  for (const c of sources) {
    const level = levelOfClass(c, levels);
    const all = studentsByClass.get(c.class_id) || [];
    const activeCount = studentCounts.get(c.class_id)?.active ?? all.filter(isActive).length;
    const active = (published.has(c.class_id) ? all.filter(isActive) : []).sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
    if (!level) {
      block(BLOCKER.UNKNOWN_LEVEL, `${c.name}: "${c.grade}" is not one of the school's numbered forms (${levels.join(', ')}), so where its students go next is unknown. Fix the class's form, or add the form in Settings, Classes.`, c.class_id);
    }
    if (activeCount && term3 && !published.has(c.class_id)) {
      block(BLOCKER.UNPUBLISHED, `${c.name}: Term 3 End of term results are not published. Publish them first; once students move, this class's results can no longer be calculated.`, c.class_id);
    }
    const graduating = Boolean(level) && isFinal(level);
    const destination = level && !graduating ? candidate(level + 1, c.stream) : null;
    const repeatDestination = level ? candidate(level, c.stream) : null;
    const entry = {
      source_class_id: c.class_id,
      source_name: c.name,
      grade: c.grade,
      stream: c.stream,
      level,
      graduating,
      subjects: term3Sets.find((r) => r.class_id === c.class_id && r.checkpoint === 'ENDTERM')?.subjects || [],
      publication_status: published.has(c.class_id) ? 'PUBLISHED' : 'UNPUBLISHED',
      class_teacher_id: c.class_teacher_id || null,
      class_teacher_name: c.class_teacher_id ? teacherNames.get(c.class_teacher_id) ?? null : null,
      destination,
      repeat_destination: repeatDestination,
      active_count: activeCount,
      inactive_count: studentCounts.get(c.class_id)?.inactive ?? all.filter((s) => !isActive(s)).length,
      students: active.map((s) => {
        const set = term3Sets.find((r) => r.class_id === c.class_id && r.checkpoint === 'ENDTERM' && r.status === 'PUBLISHED');
        const result = set ? finalRows.get(c.class_id)?.get(s.student_id) : null;
        const resultProblem = finalResultProblem(result, set);
        if (resultProblem && set) block('INVALID_FINAL_RESULT', `${c.name}: ${s.first_name} ${s.last_name} (${s.admission_no}): ${resultProblem}. Resolve the published result before closing the year.`, c.class_id);
        const action = resultProblem ? null : result.term_average < passMark ? ACTION.REPEAT : graduating ? ACTION.GRADUATE : ACTION.PROMOTE;
        const row = {
          student_id: s.student_id,
          admission_no: s.admission_no,
          first_name: s.first_name,
          last_name: s.last_name,
          _version: s._version ?? 1,
          average: resultProblem ? null : result.term_average,
          pass_mark: passMark,
          result_problem: resultProblem,
          calculation_id: set?.calculation_id ?? null,
          override_reason: null,
          default_action: action,
          action,
          to_key: action === ACTION.PROMOTE ? destination?.key ?? null : action === ACTION.REPEAT ? repeatDestination?.key ?? null : null,
          overridden: false,
        };
        byStudent.set(s.student_id, { row, klass: c, level });
        return row;
      }),
    };
    planned.push(entry);
  }

  // --- overrides: checked against the rules, never trusted
  const invalid = (studentId, message) => block(BLOCKER.INVALID_CHOICE, message, byStudent.get(studentId)?.klass.class_id ?? null);
  for (const o of overrides || []) {
    const found = byStudent.get(o.student_id);
    if (!found) { invalid(o.student_id, 'A choice was made for a student who is not in a class being promoted. Reload the plan.'); continue; }
    const { row, level } = found;
    const who = `${row.first_name} ${row.last_name}`;
    if (!ACTIONS.includes(o.action)) { invalid(o.student_id, `${who}: unknown action ${o.action}.`); continue; }
    if (!level) continue; // the class already blocks
    let toKey = null;
    if (o.action === ACTION.PROMOTE) {
      if (isFinal(level)) { invalid(o.student_id, `${who} is in ${levels[level - 1]}, the last form, so they can graduate or repeat, not move up.`); continue; }
      toKey = o.to_key || destinationKey(level + 1, found.klass.stream);
      if (choices.get(toKey)?.level !== level + 1) { invalid(o.student_id, `${who}: moving up must go to a ${levels[level]} class.`); continue; }
    } else if (o.action === ACTION.REPEAT) {
      toKey = o.to_key || destinationKey(level, found.klass.stream);
      if (choices.get(toKey)?.level !== level) { invalid(o.student_id, `${who}: repeating must go to a ${levels[level - 1]} class.`); continue; }
    } else if (o.action === ACTION.GRADUATE && !isFinal(level)) {
      invalid(o.student_id, `${who}: only students in a last form (${[...finals].map((f) => levels[f - 1]).join(', ')}) can graduate.`);
      continue;
    }
    const defaultKey = row.default_action === ACTION.PROMOTE ? destinationKey(level + 1, found.klass.stream) : row.default_action === ACTION.REPEAT ? destinationKey(level, found.klass.stream) : null;
    row.action = o.action;
    row.to_key = toKey;
    row.override_reason = String(o.reason || '').trim().slice(0, 500) || null;
    row.overridden = o.action !== row.default_action || toKey !== defaultKey;
  }

  // --- which destinations are used, and which of those must be created
  const used = new Set();
  for (const { row } of byStudent.values()) if (row.to_key) used.add(row.to_key);
  if (teacherStrategy === 'STAY') for (const c of planned) if (c.repeat_destination) used.add(c.repeat_destination.key);
  const creates = [...used].map((k) => choices.get(k)).filter((d) => d && !d.exists);
  for (const d of creates) {
    const clash = nextYear.find((c) => sameName(c.name, d.name));
    if (clash) {
      block(BLOCKER.NAME_TAKEN, `${d.name} ${toYear} would be created, but a ${toYear} class with that name already exists as "${clash.grade}" (or is archived). Rename or fix that class first.`, clash.class_id);
    }
  }

  // --- names for each student's destination
  for (const { row } of byStudent.values()) {
    const d = row.to_key ? choices.get(row.to_key) : null;
    row.to_class_id = d?.class_id ?? null;
    row.to_class_name = d ? `${d.name} ${d.year}` : null;
  }

  const rows = [...byStudent.values()].map((v) => v.row);
  const count = (a) => rows.filter((r) => r.action === a).length;
  const summary = {
    promote: count(ACTION.PROMOTE),
    repeat: count(ACTION.REPEAT),
    graduate: count(ACTION.GRADUATE),
    leave: count(ACTION.LEAVE),
    classes_created: creates.length,
    classes_archived: sources.length,
  };

  const moves = [...byStudent.values()].map(({ row, klass }) => ({
    student_id: row.student_id,
    name: `${row.first_name} ${row.last_name}`,
    admission_no: row.admission_no,
    from_class_id: klass.class_id,
    action: row.action,
    automatic_action: row.default_action,
    average: row.average,
    pass_mark: row.pass_mark,
    calculation_id: row.calculation_id,
    overridden: row.overridden,
    override_reason: row.override_reason,
    student_version: row._version,
    to_key: row.to_key,
  }));

  return {
    from_year: fromYear,
    to_year: toYear,
    levels,
    finals,
    classes: planned,
    choices: [...choices.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
    blockers,
    summary,
    moves,
    creates,
  };
}

/**
 * Teacher changes a run makes. With copyTeachers, each teacher's subject
 * assignments in a promoted class are added for its main destination, and a
 * class teacher follows their class; without it, nothing is added. Either way a
 * teacher stops being class teacher of a class that is archived (they would
 * otherwise block their own deactivation and keep class-teacher scope over it).
 * Past assignments are kept: subject teachers may still read classes they taught,
 * the same rule archived classes already follow.
 *
 * @returns {{teacher_id, before:{assignments, class_teacher_of, _version}, after:{assignments, class_teacher_of}}[]}
 */
export function teacherChanges({ teachers, sourceIds, mainDestination, copyTeachers, takenClassTeachers = new Set() }) {
  const out = [];
  const claimed = new Set(takenClassTeachers);
  for (const t of teachers) {
    const before = { assignments: t.assignments || [], class_teacher_of: t.class_teacher_of || null, _version: t._version ?? 1 };
    let assignments = before.assignments;
    let classTeacherOf = before.class_teacher_of;
    if (copyTeachers) {
      const added = before.assignments
        .filter((a) => sourceIds.has(a.class_id) && mainDestination.get(a.class_id))
        .map((a) => ({ class_id: mainDestination.get(a.class_id), subject: a.subject }));
      const seen = new Set(before.assignments.map((a) => `${a.class_id}|${a.subject}`));
      const fresh = added.filter((a) => !seen.has(`${a.class_id}|${a.subject}`) && seen.add(`${a.class_id}|${a.subject}`));
      if (fresh.length) assignments = [...before.assignments, ...fresh];
    }
    if (classTeacherOf && sourceIds.has(classTeacherOf)) {
      const next = copyTeachers ? mainDestination.get(classTeacherOf) ?? null : null;
      classTeacherOf = next && !claimed.has(next) ? next : null;
      if (classTeacherOf) claimed.add(classTeacherOf);
    }
    if (assignments !== before.assignments || classTeacherOf !== before.class_teacher_of) {
      out.push({ teacher_id: t.teacher_id, before, after: { assignments, class_teacher_of: classTeacherOf } });
    }
  }
  return out;
}

/** Teacher preview uses destination keys, then apply translates exactly those keys to IDs. */
export function planTeachers(plan, teachers, classes, strategy, excluded = []) {
  const active = teachers.filter((t) => (t.status || 'ACTIVE') === 'ACTIVE' && (t.role || 'Teacher') === 'Teacher');
  const choices = new Map(plan.choices.map((c) => [c.key, c]));
  const byId = new Map(classes.map((c) => [c.class_id, c]));
  const source = new Map(plan.classes.map((c) => [c.source_class_id, c]));
  const used = new Set([...plan.moves.map((m) => m.to_key), ...plan.creates.map((c) => c.key)].filter(Boolean));
  const rows = [], blockers = [], warnings = [];
  const claims = new Map();
  for (const t of active) for (const a of t.assignments || []) {
    const d = plan.choices.find((c) => c.class_id === a.class_id);
    if (d) claims.set(`${d.key}|${a.subject}`, t.teacher_id);
  }
  for (const c of plan.choices) if (byId.get(c.class_id)?.class_teacher_id) claims.set(`${c.key}|CLASS`, byId.get(c.class_id).class_teacher_id);
  const targets = (id) => {
    const c = source.get(id);
    if (!c || strategy === 'MANUAL') return [];
    if (strategy === 'STAY') return c.repeat_destination ? [c.repeat_destination.key] : [];
    return [...new Set(c.students.map((s) => s.to_key).filter(Boolean))];
  };
  for (const t of active) {
    const omitted = excluded.includes(t.teacher_id);
    const assignments = [];
    for (const a of t.assignments || []) for (const key of targets(a.class_id)) {
      if (!assignments.some((x) => x.key === key && x.subject === a.subject)) assignments.push({ key, subject: a.subject });
    }
    const classTargets = targets(t.class_teacher_of);
    // A teacher can lead only one class. Follow the progressing cohort first,
    // otherwise the repeat cohort; split subject assignments cover both.
    const preferred = source.get(t.class_teacher_of)?.destination?.key;
    const classKey = classTargets.includes(preferred) ? preferred : classTargets[0] ?? null;
    if (!assignments.length && !source.has(t.class_teacher_of)) continue;
    const conflicts = [];
    const claim = (key, subject) => {
      const slot = `${key}|${subject}`, owner = claims.get(slot);
      if (owner && owner !== t.teacher_id) conflicts.push(`${choices.get(key)?.name}: ${subject === 'CLASS' ? 'class teacher' : subject} already assigned`);
      else claims.set(slot, t.teacher_id);
    };
    if (!omitted) {
      for (const a of assignments) claim(a.key, a.subject);
      if (classKey) claim(classKey, 'CLASS');
    }
    const name = `${t.first_name} ${t.last_name}`;
    if (conflicts.length) blockers.push({ code: 'TEACHER_CONFLICT', class_id: null, message: `${name}: ${conflicts.join('; ')}. Exclude this teacher from carry-over or fix the assignments before confirming.` });
    rows.push({ teacher_id: t.teacher_id, name, excluded: omitted,
      assignments: omitted ? [] : assignments,
      class_key: omitted ? null : classKey, conflicts,
      description: omitted ? 'No carry-over; assign manually' : [...assignments.map((a) => `${a.subject} → ${choices.get(a.key)?.name}`), ...(classKey ? [`Class teacher → ${choices.get(classKey)?.name}`] : [])].join('; ') || 'Historical assignments retained; no new assignment',
    });
  }
  for (const key of used) {
    if (!claims.has(`${key}|CLASS`)) warnings.push(`${choices.get(key)?.name}: class teacher needs manual assignment.`);
    const expected = new Set(plan.classes.filter((c) => strategy === 'STAY' ? c.repeat_destination?.key === key : c.students.some((s) => s.to_key === key)).flatMap((c) => c.subjects));
    if (expected.size) {
      for (const subject of expected) if (!claims.has(`${key}|${subject}`)) warnings.push(`${choices.get(key)?.name}: ${subject} teacher needs manual assignment.`);
    } else if (![...claims.keys()].some((slot) => slot.startsWith(`${key}|`) && !slot.endsWith('|CLASS'))) warnings.push(`${choices.get(key)?.name}: subject teachers need manual assignment.`);
  }
  return { rows, blockers, warnings };
}
