import Dexie from 'dexie';
const SCHEMA = {
  classes: 'class_id',
  assessments: 'assessment_id, [class_id+term_id]',
  students: 'student_id, class_id',
  scores: 'id, assessment_id, class_id',
  outbox: '++seq, status, target, entity',
  meta: 'key',
};

let current = null;
let owner = null;

const nameFor = (sub) => `connected_gradebook_${sub}`;

export function openFor(sub) {
  if (current && owner === sub) return current;
  current?.close();
  current = new Dexie(nameFor(sub));
  current.version(1).stores(SCHEMA);
  owner = sub;
  return current;
}

export function db() {
  if (!current) throw new Error('No local database: nobody is signed in');
  return current;
}

/** Removes a user's local data entirely. */
export async function dropFor(sub) {
  if (owner === sub) {
    current.close();
    current = null;
    owner = null;
  }
  await Dexie.delete(nameFor(sub));
}

export const scoreKey = (assessmentId, studentId) => `${assessmentId}#${studentId}`;

export const meta = {
  async get(key, fallback = null) {
    const row = await db().meta.get(key);
    return row ? row.value : fallback;
  },
  set: (key, value) => db().meta.put({ key, value }),
};

export const cursor = {
  get: (classId) => meta.get(`cursor:${classId}`, 0),
  set: (classId, startedAt) => meta.set(`cursor:${classId}`, startedAt),
};