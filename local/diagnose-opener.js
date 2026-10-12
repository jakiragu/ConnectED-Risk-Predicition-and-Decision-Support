import 'dotenv/config';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk, gsi1 } from '../backend/library/keys.js';
import * as assessments from '../backend/library/assessmentRepo.js';
import * as platform from '../backend/library/platformRepo.js';
import * as results from '../backend/library/resultsRepo.js';

const schoolId = 'sch_saint_innocent';
const classId = 'cls_test';
const termId = 'term_2026_1';
const checkpoint = 'OPENER';
const set = await results.getSet(schoolId, { termId, classId, checkpoint });
console.log('result set:', JSON.stringify(set && {
  status: set.status, blocking: set.blocking, issues: set.issues,
  assessment_count: set.assessment_count, student_count: set.student_count,
  calculated_at: set.calculated_at, calculation_id: set.calculation_id,
  published_from_version: set.published_from_version,
}));
const live = await assessments.listAllLive(schoolId, classId, termId);
const inScope = live.filter((a) => a.assessment_type === 'Opener');
console.log('all Term 1 live assessments:', JSON.stringify(live.map((a) => ({
  id: a.assessment_id, title: a.title, subject: a.subject,
  assessment_type: a.assessment_type, term_id: a.term_id, score_count: a.score_count,
}))));
console.log('opener assessments:', JSON.stringify(inScope.map((a) => ({
  id: a.assessment_id, title: a.title, subject: a.subject, paper_no: a.paper_no,
  weight: a.weight, max_score: a.max_score, score_count: a.score_count,
}))));
const roster = await platform.roster(schoolId, classId);
console.log('active roster count:', roster.length);
for (const a of inScope) {
  const scores = await (await import('../backend/library/scoreRepo.js')).listByAssessment(schoolId, a.assessment_id);
  console.log('scores:', a.title, JSON.stringify(scores.map((s) => ({
    student_id: s.student_id, raw_score: s.raw_score, mark_status: s.mark_status,
    status: s.status, _deleted: s._deleted,
  }))));
}
const rule = await platform.gradeRule(schoolId, termId);
console.log('grade rule:', JSON.stringify(rule && {
  missing_score_policy: rule.missing_score_policy,
  checkpoint_weights: rule.checkpoint_weights,
  band_count: rule.bands?.length,
}));
for (const otherTermId of ['term_2026_2', 'term_2026_3']) {
  const otherTerm = await assessments.listAllLive(schoolId, classId, otherTermId);
  console.log(`live assessments in ${otherTermId}:`, JSON.stringify(otherTerm.map((a) => ({
    title: a.title, subject: a.subject, assessment_type: a.assessment_type, score_count: a.score_count,
  }))));
}
