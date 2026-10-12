export const TABLE = process.env.GRADEBOOK_TABLE_NAME || 'gradebook_platform_data';

const pad = (n) => String(n).padStart(16, '0');

export const pk = (schoolId) => `SCHOOL#${schoolId}`;

export const sk = {
  school: () => 'SCHOOL#PROFILE',
  term: (id) => `TERM#${id}`,
  termPrefix: () => 'TERM#',
  student: (id) => `STUDENT#${id}`,
  teacher: (id) => `TEACHER#${id}`,
  klass: (id) => `CLASS#${id}`,
  assessment: (id) => `ASSESSMENT#${id}`,
 
  paperSlot: (termId, classId, subject, assessmentType, paperNo) =>
    `PAPER#${termId}#CLASS#${classId}#${subject}#${assessmentType}#${paperNo}`,
  score: (assessmentId, studentId) => `SCORE#${assessmentId}#${studentId}`,
  gradeRule: (termId) => `GRADERULE#${termId}`,
  // Results are published per class, so the term lock is per class.
  termLock: (termId, classId) => `TERMLOCK#${termId}#CLASS#${classId}`,
  // One result set per class + term + checkpoint: the unit that is reviewed and published.
  resultSet: (termId, classId, checkpoint) => `RESULTSET#${termId}#CLASS#${classId}#${checkpoint}`,
  resultSetClassPrefix: (termId, classId) => `RESULTSET#${termId}#CLASS#${classId}#`,
  resultSetTermPrefix: (termId) => `RESULTSET#${termId}#CLASS#`,
  // Rows live under their calculation id, so an abandoned or concurrent
  // recalculation never mixes into the rows a result set points at.
  termResult: (termId, classId, checkpoint, calculationId, studentId) =>
    `TERMRESULT#${termId}#CLASS#${classId}#${checkpoint}#${calculationId}#${studentId}`,
  termResultPrefix: (termId, classId, checkpoint, calculationId) =>
    `TERMRESULT#${termId}#CLASS#${classId}#${checkpoint}#${calculationId}#`,
  reportCard: (termId, checkpoint, studentId) => `REPORTCARD#${termId}#${checkpoint}#${studentId}`,
  scoreAudit: (assessmentId, studentId, ulid) =>
    `SCOREAUDIT#${assessmentId}#${studentId}#${ulid}`,
  idempotency: (key) => `IDEMPOTENCY#${key}`,
};

export const gsi1 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}`,
  assessment: (termId, assessmentId) => `TERM#${termId}#ASSESSMENT#${assessmentId}`,
};

export const gsi2 = {
  pk: (schoolId, studentId) => `SCHOOL#${schoolId}#STUDENT#${studentId}`,
  score: (termId, assessmentId) => `TERM#${termId}#SCORE#${assessmentId}`,
};

export const gsi3 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}#SCORE`,
  sk: (lastChangedAt) => pad(lastChangedAt),
};