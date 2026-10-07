export const TABLE = process.env.GRADEBOOK_TABLE_NAME || 'gradebook_platform_data';

const pad = (n) => String(n).padStart(16, '0');

export const pk = (schoolId) => `SCHOOL#${schoolId}`;

export const sk = {
  student: (id) => `STUDENT#${id}`,
  teacher: (id) => `TEACHER#${id}`,
  klass: (id) => `CLASS#${id}`,
  assessment: (id) => `ASSESSMENT#${id}`,
  score: (assessmentId, studentId) => `SCORE#${assessmentId}#${studentId}`,
  gradeRule: (termId) => `GRADERULE#${termId}`,
  termResult: (termId, studentId) => `TERMRESULT#${termId}#${studentId}`,
  termLock: (termId) => `TERMLOCK#${termId}`,
  reportCard: (termId, studentId) => `REPORTCARD#${termId}#${studentId}`,
  scoreAudit: (assessmentId, studentId, ulid) =>
    `SCOREAUDIT#${assessmentId}#${studentId}#${ulid}`,
  idempotency: (key) => `IDEMPOTENCY#${key}`,
};

export const gsi1 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}`,
  assessment: (termId, assessmentId) => `TERM#${termId}#ASSESSMENT#${assessmentId}`,
  termResult: (termId, studentId) => `TERM#${termId}#TERMRESULT#${studentId}`,
};

export const gsi2 = {
  pk: (schoolId, studentId) => `SCHOOL#${schoolId}#STUDENT#${studentId}`,
  score: (termId, assessmentId) => `TERM#${termId}#SCORE#${assessmentId}`,
};

export const gsi3 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}#SCORE`,
  sk: (lastChangedAt) => pad(lastChangedAt),
};