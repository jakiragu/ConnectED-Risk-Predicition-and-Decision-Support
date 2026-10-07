import { db, scoreKey } from './db.js';
import { gql } from '../api/graphql.js';
import {
  CREATE_ASSESSMENT,
  GET_ASSESSMENT,
  GET_CLASS_ROSTER,
  LIST_MY_CLASSES,
  RESOLVE_SCORE_CONFLICT,
} from '../api/operations.js';
import * as outbox from './outbox.js';
import { isOnline, queueAssessment, queueScore, refreshAssessments, refreshScores } from './syncEngine.js';


async function quietly(fn) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    return await fn();
  } catch (e) {
    if (e.errorType === 'Network') return null;
    throw e;
  }
}

export const repository = {
  loadClasses: (schoolId) =>
    quietly(async () => {
      const { listMyClasses } = await gql(LIST_MY_CLASSES, { school_id: schoolId });
      await db().transaction('rw', db().classes, async () => {
        await db().classes.clear();
        await db().classes.bulkPut(listMyClasses);
      });
    }),

  loadRoster: (schoolId, classId) =>
    quietly(async () => {
      const { getClassRoster } = await gql(GET_CLASS_ROSTER, { school_id: schoolId, class_id: classId });
      await db().transaction('rw', db().students, async () => {
        await db().students.where('class_id').equals(classId).delete();
        await db().students.bulkPut(getClassRoster);
      });
    }),

  loadAssessment: (schoolId, assessmentId) =>
    quietly(async () => {
      const { getAssessment } = await gql(GET_ASSESSMENT, { school_id: schoolId, assessment_id: assessmentId });
      const cached = await db().assessments.get(assessmentId);
      if (getAssessment) await db().assessments.put(getAssessment);
      else if (cached && !cached._pending) await db().assessments.delete(assessmentId);
      return getAssessment;
    }),

  loadAssessments: (schoolId, classId, termId) => quietly(() => refreshAssessments(schoolId, classId, termId)),
  loadScores: (schoolId, assessmentId) => quietly(() => refreshScores(schoolId, assessmentId)),

  saveScore: queueScore,

  /** Online: create now, so validation errors come back to the form. Offline: queue. */
  async createAssessment(input, actor) {
    if (isOnline()) {
      try {
        const { createAssessment } = await gql(CREATE_ASSESSMENT, { input });
        await db().assessments.put(createAssessment);
        return { queued: false, assessment: createAssessment };
      } catch (e) {
        if (e.errorType !== 'Network') throw e;
      }
    }
    return { queued: true, assessment: await queueAssessment(input, actor) };
  },

  /** Deciding between two marks needs the server; it is online-only. */
  async resolveConflict({ schoolId, assessmentId, studentId, chosenRawScore, version }) {
    const { resolveScoreConflict } = await gql(RESOLVE_SCORE_CONFLICT, {
      input: {
        school_id: schoolId,
        assessment_id: assessmentId,
        student_id: studentId,
        chosen_raw_score: chosenRawScore,
        _version: version,
      },
    });
    const id = scoreKey(assessmentId, studentId);
    if (resolveScoreConflict) await db().scores.put({ ...resolveScoreConflict, id });
    else await db().scores.delete(id);
    await outbox.supersede(id);
    return resolveScoreConflict;
  },
};