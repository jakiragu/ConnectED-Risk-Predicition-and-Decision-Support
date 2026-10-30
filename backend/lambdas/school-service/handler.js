import {
  assertTenant,
  assertAdmin,
  assertClassRead,
  assertClassTeacherOrAdmin,
  ROLE,
  ROLES,
} from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { SUBJECTS } from '../../library/assessment.js';
import { validation, notFound, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import * as identity from '../../library/identity.js';
import * as platform from '../../library/platformRepo.js';
import * as school from '../../library/schoolRepo.js';

export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id ?? args.school_id);

  switch (event.info.fieldName) {
    case 'me':
      return me(actor);
    case 'listTeachers':
      return listTeachers(actor, args);
    case 'createTeacher':
      return createTeacher(actor, input);
    case 'updateTeacher':
      return updateTeacher(actor, input);
    case 'updateMyProfile':
      return updateMyProfile(actor, input);
    case 'setTeacherAssignments':
      return setTeacherAssignments(actor, input);
    case 'setClassTeacher':
      return setClassTeacher(actor, input);
    case 'deactivateTeacher':
      return setTeacherStatus(actor, input, 'INACTIVE');
    case 'reactivateTeacher':
      return setTeacherStatus(actor, input, 'ACTIVE');
    case 'resetTeacherPassword':
      return resetTeacherPassword(actor, input);
    case 'listSchoolClasses':
      return listSchoolClasses(actor, args);
    case 'createClass':
      return createClass(actor, input);
    case 'updateClass':
      return updateClass(actor, input);
    case 'deleteClass':
      return deleteClass(actor, input);
    case 'listStudents':
      return listStudents(actor, args);
    case 'createStudent':
      return createStudent(actor, input);
    case 'updateStudent':
      return updateStudent(actor, input);
    case 'transferStudent':
      return transferStudent(actor, input);
    case 'setStudentStatus':
      return setStudentStatus(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const STALE = 'Someone else changed this record. Reload and try again.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMISSION = /^[A-Za-z0-9/-]{1,20}$/;
const CLASS_STATUS = ['CURRENT', 'PAST'];

const clean = (s) => (typeof s === 'string' ? s.trim() : s);
const requireText = (value, field, label, max = 60) => {
  const v = clean(value);
  if (!v) throw validation(`Enter the ${label}`, field);
  if (v.length > max) throw validation(`The ${label} is too long`, field);
  return v;
};
const fullName = (t) => [t.first_name, t.last_name].filter(Boolean).join(' ');
const staleOr = (e) => {
  if (e.name === school.STALE || e.name === 'ConditionalCheckFailedException') throw conflict(STALE);
  throw e;
};

// ------------------------------------------------------------------- views

const teacherView = (t) => ({
  teacher_id: t.teacher_id,
  school_id: t.school_id,
  school_name: t.school_name ?? null,
  email: t.email,
  first_name: t.first_name,
  last_name: t.last_name,
  role: t.role || t.groups?.[0] || ROLE.TEACHER,
  status: t.status || 'ACTIVE',
  assignments: t.assignments || [],
  class_teacher_of: t.class_teacher_of || null,
  created_at: t.created_at ?? null,
  updated_at: t.updated_at ?? null,
  _version: t._version ?? 1,
});

const classView = (c, extra = {}) => ({
  class_id: c.class_id,
  school_id: c.school_id,
  name: c.name,
  grade: c.grade,
  stream: c.stream,
  year: c.year ?? null,
  status: c.status || 'CURRENT',
  class_teacher_id: c.class_teacher_id || null,
  _version: c._version ?? 1,
  ...extra,
});

const studentView = (s) => ({
  student_id: s.student_id,
  school_id: s.school_id,
  first_name: s.first_name,
  last_name: s.last_name,
  admission_no: s.admission_no,
  class_id: s.class_id,
  status: s.status || 'ACTIVE',
  _version: s._version ?? 1,
});

async function loadTeacher(schoolId, teacherId) {
  const t = await platform.teacher(schoolId, teacherId);
  if (!t) throw notFound('Teacher not found');
  return t;
}

async function loadClass(schoolId, classId) {
  const c = await platform.klass(schoolId, classId);
  if (!c) throw notFound('Class not found');
  return c;
}

async function loadStudent(schoolId, studentId) {
  const s = await platform.student(schoolId, studentId);
  if (!s) throw notFound('Student not found');
  return s;
}

// --------------------------------------------------------------- teachers

async function me(actor) {
  const [teacher, schoolProfile] = await Promise.all([
    loadTeacher(actor.schoolId, actor.sub),
    platform.school(actor.schoolId),
  ]);

  return {
    ...teacherView(teacher),
    school_name: schoolProfile?.name ?? null,
  };
}

async function listTeachers(actor, { school_id }) {
  assertAdmin(actor);
  return (await platform.listTeachers(school_id)).map(teacherView);
}

function readRole(role) {
  if (!ROLES.includes(role)) throw validation(`Role must be ${ROLES.join(' or ')}`, 'role');
  return role;
}

/**
 * Creates the sign-in account first, then the Teacher record keyed by the
 * account's sub. If a previous attempt stopped half way, the retry finds the
 * account and finishes the record. The temporary password is returned once.
 */
async function createTeacher(actor, input) {
  assertAdmin(actor);
  const email = requireText(input.email, 'email', 'email address', 120).toLowerCase();
  if (!EMAIL.test(email)) throw validation('Enter a valid email address', 'email');
  const first = requireText(input.first_name, 'first_name', 'first name');
  const last = requireText(input.last_name, 'last_name', 'last name');
  const role = readRole(input.role || ROLE.TEACHER);

  if (await platform.teacherByEmail(input.school_id, email)) {
    throw validation('A teacher with this email already exists at this school', 'email');
  }
  const account = await identity.createAccount({ email, name: `${first} ${last}`, schoolId: input.school_id });
  if (!account.created && account.schoolId !== input.school_id) {
    throw conflict('This email is already registered at another school');
  }
  await identity.setRole(account.sub, role);
  const temporaryPassword = account.temporaryPassword ?? (await identity.resetPassword(account.sub));

  const { item, created } = await school.putTeacher(input.school_id, {
    teacher_id: account.sub, email, first_name: first, last_name: last, role, created_by: actor.sub,
  });
  const row = created ? item : await loadTeacher(input.school_id, account.sub);
  return { teacher: teacherView(row), temporary_password: temporaryPassword };
}

async function updateTeacher(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  const patch = {
    first_name: input.first_name != null ? requireText(input.first_name, 'first_name', 'first name') : undefined,
    last_name: input.last_name != null ? requireText(input.last_name, 'last_name', 'last name') : undefined,
    role: input.role != null ? readRole(input.role) : undefined,
  };
  if (patch.role && patch.role !== existing.role) {
    if (existing.teacher_id === actor.sub) throw validation('You cannot change your own role', 'role');
    if (patch.role === ROLE.ADMIN && existing.class_teacher_of) {
      throw validation('Choose another class teacher for their class before making them an administrator', 'role');
    }
  }
  const updated = await school.updateTeacher(input.school_id, input.teacher_id, patch, input._version).catch(staleOr);
  // The record is authoritative; bring the account in line (idempotent, so a retry repairs a partial failure).
  await identity.setRole(updated.teacher_id, updated.role);
  if (fullName(updated) !== fullName(existing)) await identity.setName(updated.teacher_id, fullName(updated));
  return teacherView(updated);
}

async function updateMyProfile(actor, input) {
  const existing = await loadTeacher(input.school_id, actor.sub);

  const patch = {
    first_name: input.first_name != null
      ? requireText(input.first_name, 'first_name', 'first name')
      : undefined,
    last_name: input.last_name != null
      ? requireText(input.last_name, 'last_name', 'last name')
      : undefined,
  };

  const updated = await school.updateTeacher(
    input.school_id,
    actor.sub,
    patch,
    input._version
  ).catch(staleOr);

  if (fullName(updated) !== fullName(existing)) {
    await identity.setName(updated.teacher_id, fullName(updated));
  }

  return teacherView(updated);
}

async function setTeacherAssignments(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.status !== 'ACTIVE') throw validation('Reactivate this teacher before assigning classes', 'assignments');
  if ((existing.role || ROLE.TEACHER) !== ROLE.TEACHER) {
    throw validation('Administrators can work in every class; assignments are for teachers', 'assignments');
  }
  const classes = new Map((await platform.listClasses(input.school_id)).map((c) => [c.class_id, c]));
  const seen = new Set();
  const assignments = [];
  for (const a of input.assignments || []) {
    const c = classes.get(a.class_id);
    if (!c) throw validation('One of the classes no longer exists', 'assignments');
    if (!SUBJECTS.includes(a.subject)) throw validation(`${a.subject} is not a subject this school teaches`, 'assignments');
    const key = `${a.class_id}|${a.subject}`;
    if (seen.has(key)) continue;
    if (c.status !== 'CURRENT' && !(existing.assignments || []).some((x) => x.class_id === a.class_id && x.subject === a.subject)) {
      throw validation(`${c.name} is archived, so it cannot get new assignments`, 'assignments');
    }
    seen.add(key);
    assignments.push({ class_id: a.class_id, subject: a.subject });
  }
  assignments.sort((x, y) => classes.get(x.class_id).name.localeCompare(classes.get(y.class_id).name) || x.subject.localeCompare(y.subject));
  const updated = await school.updateTeacher(input.school_id, input.teacher_id, { assignments }, input._version).catch(staleOr);
  return teacherView(updated);
}

async function setClassTeacher(actor, input) {
  assertAdmin(actor);
  const klass = await loadClass(input.school_id, input.class_id);
  const teacherId = input.teacher_id || null;
  let next = null;
  if (teacherId) {
    if (klass.status !== 'CURRENT') throw validation(`${klass.name} is archived`, 'teacher_id');
    next = await loadTeacher(input.school_id, teacherId);
  }
  try {
    await school.setClassTeacher(input.school_id, klass, teacherId, input._version);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    const at = e.classTeacherIndex;
    if (school.reasonAt(e, at.klass)) throw conflict(STALE);
    if (at.previous !== undefined && school.reasonAt(e, at.previous)) throw conflict(STALE);
    if (at.next !== undefined && school.reasonAt(e, at.next)) {
      if (next.status !== 'ACTIVE') throw validation(`${fullName(next)} is deactivated`, 'teacher_id');
      if ((next.role || ROLE.TEACHER) !== ROLE.TEACHER) throw validation('Administrators cannot be class teachers', 'teacher_id');
      const other = next.class_teacher_of ? await platform.klass(input.school_id, next.class_teacher_of) : null;
      throw validation(`${fullName(next)} is already the class teacher of ${other?.name || 'another class'}`, 'teacher_id');
    }
    throw e;
  }
  return classView(await loadClass(input.school_id, input.class_id));
}

async function setTeacherStatus(actor, input, status) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.teacher_id === actor.sub) throw validation('You cannot deactivate your own account', 'teacher_id');
  if (status === 'INACTIVE' && existing.class_teacher_of) {
    const klass = await platform.klass(input.school_id, existing.class_teacher_of);
    throw validation(`Choose another class teacher for ${klass?.name || 'their class'} first`, 'teacher_id');
  }
  const updated = existing.status === status
    ? existing
    : await school.updateTeacher(input.school_id, input.teacher_id, { status }, input._version).catch(staleOr);
  // The record already blocks or allows access on every request; the account follows it.
  if (status === 'INACTIVE') await identity.disable(updated.teacher_id);
  else await identity.enable(updated.teacher_id);
  return teacherView(updated);
}

async function resetTeacherPassword(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.status !== 'ACTIVE') throw validation('Reactivate this teacher first', 'teacher_id');
  return { teacher: teacherView(existing), temporary_password: await identity.resetPassword(existing.teacher_id) };
}

// ----------------------------------------------------------------- classes

async function listSchoolClasses(actor, { school_id }) {
  assertAdmin(actor);
  const [classes, teachers] = await Promise.all([platform.listClasses(school_id), platform.listTeachers(school_id)]);
  const names = new Map(teachers.map((t) => [t.teacher_id, fullName(t)]));
  return Promise.all(classes.map(async (c) => classView(c, {
    student_count: (await platform.listStudents(school_id, c.class_id)).length,
    class_teacher_name: c.class_teacher_id ? names.get(c.class_teacher_id) ?? null : null,
  })));
}

function readClassFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.grade != null) out.grade = requireText(input.grade, 'grade', 'form', 30);
  if (!partial || input.stream != null) out.stream = requireText(input.stream, 'stream', 'stream', 30);
  if (!partial || input.year != null) {
    const year = Number(input.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw validation('Enter a year such as 2026', 'year');
    out.year = year;
  }
  if (input.name != null) out.name = requireText(input.name, 'name', 'class name');
  if (input.status != null) {
    if (!CLASS_STATUS.includes(input.status)) throw validation('Status must be CURRENT or PAST', 'status');
    out.status = input.status;
  }
  return out;
}

async function assertNameFree(schoolId, name, classId = null) {
  const taken = (await platform.listClasses(schoolId)).some(
    (c) => c.class_id !== classId && c.name.toLowerCase() === name.toLowerCase()
  );
  if (taken) throw validation(`There is already a class called ${name}`, 'name');
}

async function createClass(actor, input) {
  assertAdmin(actor);
  const fields = readClassFields(input);
  const name = fields.name || `${fields.grade} ${fields.stream}`;
  await assertNameFree(input.school_id, name);
  const item = await school.createClass(input.school_id, {
    class_id: `cls_${ulid().toLowerCase()}`, ...fields, name, status: 'CURRENT', created_by: actor.sub,
  });
  return classView(item, { student_count: 0, class_teacher_name: null });
}

async function updateClass(actor, input) {
  assertAdmin(actor);
  const existing = await loadClass(input.school_id, input.class_id);
  const patch = readClassFields(input, { partial: true });
  if (patch.name) await assertNameFree(input.school_id, patch.name, existing.class_id);
  const updated = await school.updateClass(input.school_id, input.class_id, patch, input._version).catch(staleOr);
  return classView(updated);
}

/** Only a class nothing refers to; otherwise archive it (status PAST). */
async function deleteClass(actor, input) {
  assertAdmin(actor);
  const existing = await loadClass(input.school_id, input.class_id);
  const keep = 'Archive it instead (set it to Past).';
  if (existing.class_teacher_id) throw validation(`Remove the class teacher first, or ${keep.toLowerCase()}`, 'class_id');
  const students = await platform.listStudents(input.school_id, input.class_id, { includeInactive: true });
  if (students.length) throw validation(`${existing.name} has ${students.length} student record${students.length === 1 ? '' : 's'}. ${keep}`, 'class_id');
  if (await school.classHasAssessments(input.school_id, input.class_id)) {
    throw validation(`${existing.name} has assessments. ${keep}`, 'class_id');
  }
  const assigned = (await platform.listTeachers(input.school_id))
    .filter((t) => (t.assignments || []).some((a) => a.class_id === input.class_id));
  if (assigned.length) {
    throw validation(`Remove ${existing.name} from ${assigned.map(fullName).join(', ')}'s assignments first`, 'class_id');
  }
  await school.deleteClass(input.school_id, input.class_id, input._version).catch(staleOr);
  return input.class_id;
}

// ---------------------------------------------------------------- students

async function listStudents(actor, { school_id, class_id, include_inactive }) {
  await loadClass(school_id, class_id);
  assertClassRead(actor, class_id);
  return (await platform.listStudents(school_id, class_id, { includeInactive: Boolean(include_inactive) })).map(studentView);
}

function readStudentFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.first_name != null) out.first_name = requireText(input.first_name, 'first_name', 'first name');
  if (!partial || input.last_name != null) out.last_name = requireText(input.last_name, 'last_name', 'last name');
  if (!partial || input.admission_no != null) {
    const no = requireText(input.admission_no, 'admission_no', 'admission number', 20);
    if (!ADMISSION.test(no)) throw validation('Admission numbers use letters, digits, / and - only', 'admission_no');
    out.admission_no = no;
  }
  return out;
}

async function admissionTaken(schoolId, admissionNo) {
  const holder = await platform.admissionClaim(schoolId, admissionNo);
  const student = holder ? await platform.student(schoolId, holder.student_id) : null;
  return validation(
    `Admission number ${admissionNo} already belongs to ${student ? `${student.first_name} ${student.last_name}` : 'another student'}`,
    'admission_no'
  );
}

async function createStudent(actor, input) {
  const klass = await loadClass(input.school_id, input.class_id);
  assertClassTeacherOrAdmin(actor, input.class_id);
  if (klass.status !== 'CURRENT') throw validation(`${klass.name} is archived`, 'class_id');
  const fields = readStudentFields(input);
  try {
    const item = await school.createStudent(input.school_id, {
      student_id: `stu_${ulid().toLowerCase()}`, class_id: input.class_id, ...fields,
    }, actor);
    return studentView(item);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 1)) throw await admissionTaken(input.school_id, fields.admission_no);
    if (school.reasonAt(e, 2)) throw validation(`${klass.name} is archived or was removed`, 'class_id');
    throw e;
  }
}

async function updateStudent(actor, input) {
  const existing = await loadStudent(input.school_id, input.student_id);
  assertClassTeacherOrAdmin(actor, existing.class_id);
  const patch = readStudentFields(input, { partial: true });
  try {
    await school.updateStudent(input.school_id, existing, patch, input._version, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 0)) throw conflict(STALE);
    if (school.reasonAt(e, 2)) throw await admissionTaken(input.school_id, patch.admission_no);
    throw e;
  }
  return studentView(await loadStudent(input.school_id, input.student_id));
}

/**
 * Admin only: a transfer touches two classes. Marks stay with the papers of
 * the old class; published results are unchanged; the student appears in the
 * new class's roster from now on.
 */
async function transferStudent(actor, input) {
  assertAdmin(actor);
  const existing = await loadStudent(input.school_id, input.student_id);
  if (existing.class_id === input.to_class_id) throw validation('The student is already in that class', 'to_class_id');
  const destination = await loadClass(input.school_id, input.to_class_id);
  if (destination.status !== 'CURRENT') throw validation(`${destination.name} is archived`, 'to_class_id');
  try {
    await school.transferStudent(input.school_id, existing, input.to_class_id, input._version, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 0)) throw conflict(STALE);
    if (school.reasonAt(e, 1)) throw validation(`${destination.name} is archived or was removed`, 'to_class_id');
    throw e;
  }
  return studentView(await loadStudent(input.school_id, input.student_id));
}

/** Deactivate, never delete: marks, results and report cards refer to the student. */
async function setStudentStatus(actor, input) {
  const existing = await loadStudent(input.school_id, input.student_id);
  assertClassTeacherOrAdmin(actor, existing.class_id);
  if (!['ACTIVE', 'INACTIVE'].includes(input.status)) throw validation('Status must be ACTIVE or INACTIVE', 'status');
  if (existing.status === input.status) return studentView(existing);
  const updated = await school.setStudentStatus(input.school_id, input.student_id, input.status, input._version, actor).catch(staleOr);
  return studentView(updated);
}