import assert from 'node:assert/strict';
import {
  CALCULATE_TERM_RESULTS, CREATE_ASSESSMENT, GET_CLASS_ROSTER, GET_TERM_RESULTS, LIST_ASSESSMENTS,
  LIST_REPORT_CARDS, LIST_SCORES, PUBLISH_RESULTS, SUBMIT_SCORES,
} from '../../src/api/operations.js';
import { ulid } from '../../backend/library/ids.js';
import { as, CLASS, SCHOOL, sleep } from '../helpers/api.js';
import { refused, tc } from '../helpers/harness.js';
import { calculate, CHAIN, publishThrough, resultSet, scope } from '../helpers/publishing.js';

/**
 * Gradebook Management Module (FR-01 to FR-06), through the API the browser uses.
 *
 * What the seed and the services impose, and how the cases respect it:
 *
 *  1. A paper is one of three slots (paper_no 1 to 3) of a subject's exam at a checkpoint, per
 *     class and term; the papers of an exam must total exactly 100% before it can publish; and a
 *     paper cannot be removed once marks exist. So cases that create papers take the next FREE
 *     slot with a small weight (a full run uses about eight). Reseed before a fresh full run.
 *
 *  2. The seed already holds complete, scored papers for the test class (all model subjects, 100%
 *     each) at Term 1 Opener/Mid-term/End-term, Term 2 Mid-term/End-term and Term 3 Mid-term.
 *     They carry the legacy type names MIDTERM and ENDTERM. The publication cases publish THOSE
 *     papers and add none, so they never push an exam past 100%.
 *
 *  3. Results publish in order (Opener, then Mid-term, then End of term) and End of term locks
 *     the class's marks, so the cases that create papers use one term (TEST_TERM) and the
 *     publication cases another (TEST_PUB_TERM).
 *
 *   TEST_TERM       papers are created here                   default term_2026_3
 *   TEST_CALC_TERM  the hand-calculated Opener (not published) default term_2026_2
 *   TEST_PUB_TERM   seeded Opener, Mid-term, End of term published default term_2026_1
 *
 * The pipeline cases (pipeline.test.js) use Term 2, a later term than TEST_PUB_TERM, so that
 * what they publish is the latest result and a missing prediction shows as "not current".
 */
const TERM = process.env.TEST_TERM || 'term_2026_3';
const CALC_TERM = process.env.TEST_CALC_TERM || 'term_2026_2';
const PUB_TERM = process.env.TEST_PUB_TERM || 'term_2026_1';
const SUBJECT = 'Kiswahili';          // jane.doe teaches this in the test class
const TYPES = ['Opener', 'Mid-term', 'End-term'];
const CHECKPOINT_TYPE = { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End-term' };
const unique = () => Math.random().toString(36).slice(2, 7);
const SLOT_TAKEN = /already has a paper|exam is left/;

const createRaw = async (who, input) => (await as(who, CREATE_ASSESSMENT, { input })).createAssessment;

/** Creates a paper in the next free slot (see 1 above). Weight is small so slots do not run out of budget. */
async function newPaper(who, patch = {}) {
  const { term_id = TERM, subject = SUBJECT } = patch;
  const types = patch.assessment_type ? [patch.assessment_type] : TYPES;
  const numbers = patch.paper_no ? [patch.paper_no] : [1, 2, 3];
  let last;
  for (const assessment_type of types) {
    for (const paper_no of numbers) {
      try {
        return await createRaw(who, {
          assessment_id: ulid(), school_id: SCHOOL, class_id: CLASS, title: `Test paper ${unique()}`,
          weight: 10, max_score: 100, ...patch, term_id, subject, assessment_type, paper_no,
        });
      } catch (e) {
        if (e.errorType === 'ValidationError' && SLOT_TAKEN.test(e.message)) { last = e; continue; }
        throw e;
      }
    }
  }
  throw new Error(`no free paper slot for ${subject} in ${term_id}: ${last?.message}. Reseed (npm run db:seed) and rerun.`);
}

const roster = async () => (await as('jane', GET_CLASS_ROSTER, { school_id: SCHOOL, class_id: CLASS })).getClassRoster;
const entry = (student_id, raw_score, extra = {}) => ({ student_id, raw_score, mark_status: 'SCORED', ...extra });
const submit = async (who, assessment_id, entries) =>
  (await as(who, SUBMIT_SCORES, { input: { school_id: SCHOOL, assessment_id, entries } })).submitScores;
const stored = async (who, assessment_id) =>
  (await as(who, LIST_SCORES, { school_id: SCHOOL, assessment_id })).listScoresByAssessment.items;
const outcomeOf = (res, i = 0) => res.results[i]?.outcome;

const shared = {};   // set by TC-G05 and TC-G06 for TC-G06, TC-G07 and TC-G12

// =============================================================== paper cases (TERM)

tc({
  id: 'TC-G01', requirement: 'FR-01', level: 'Integration', technique: 'Black box, positive',
  scenario: 'An authorised teacher creates an assessment with total marks and a weighting',
  data: 'Kiswahili paper, max_score 50, weight 30, created by jane.doe',
  expected: 'The assessment is stored with that mark total and weight, appears in the class list, and a score can then be submitted against it',
}, async (ev) => {
  const paper = await newPaper('jane', { max_score: 50, weight: 30 });
  assert.equal(paper.max_score, 50);
  assert.equal(paper.weight, 30);
  const list = (await as('jane', LIST_ASSESSMENTS, { school_id: SCHOOL, class_id: CLASS, term_id: TERM })).listAssessmentsByClass.items;
  assert.ok(list.some((x) => x.assessment_id === paper.assessment_id), 'the new assessment is not in the class list');
  const student = (await roster())[0];
  const out = await submit('jane', paper.assessment_id, [entry(student.student_id, 25)]);
  assert.equal(outcomeOf(out), 'APPLIED');
  assert.equal(out.accepted, 1);
  ev(`created ${paper.assessment_id} (${paper.assessment_type} paper ${paper.paper_no}, max 50, weight 30), listed, then a score of 25 was APPLIED`);
});

tc({
  id: 'TC-G02', requirement: 'FR-01', level: 'Integration', technique: 'Black box, negative and boundary',
  scenario: 'An assessment is created with an invalid weight or maximum mark',
  data: 'weight 0, weight 101, max_score 0, and a subject the teacher does not teach',
  expected: 'Each attempt is refused by the service with a validation or authorisation error, and nothing is stored',
}, async (ev) => {
  const attempt = (patch) => createRaw('jane', {
    assessment_id: ulid(), school_id: SCHOOL, class_id: CLASS, term_id: TERM, subject: SUBJECT, title: `Invalid ${unique()}`,
    assessment_type: 'End-term', paper_no: 3, weight: 10, max_score: 100, ...patch,
  });
  const seen = [];
  for (const [label, patch] of [['weight 0', { weight: 0 }], ['weight 101', { weight: 101 }], ['max 0', { max_score: 0 }]]) {
    const e = await refused(() => attempt(patch), 'ValidationError');
    seen.push(`${label} -> ${e.errorType}`);
  }
  const e = await refused(() => attempt({ subject: 'Physics' }), 'Forbidden');
  seen.push(`subject not taught -> ${e.errorType}`);
  ev(seen.join(', '));
});

tc({
  id: 'TC-G11', requirement: 'FR-01', level: 'Integration', technique: 'Black box, negative',
  scenario: 'Scores are submitted against an assessment that has not been created',
  data: 'a freshly generated assessment_id that was never created',
  expected: 'The service refuses the submission because the assessment is not found, and no score is stored',
}, async (ev) => {
  const student = (await roster())[0];
  const e = await refused(() => submit('jane', ulid(), [entry(student.student_id, 10)]));
  assert.match(e.message, /not found/i, `refused, but not because the assessment is missing: ${e.message}`);
  ev(`refused with ${e.errorType}: ${e.message}`);
});

tc({
  id: 'TC-G03', requirement: 'FR-02', level: 'Integration', technique: 'Black box, positive',
  scenario: 'A teacher submits and then edits scores for an assessment that is not published',
  data: 'three students scored 40, 50, 60, then the first corrected to 72 using the version the server returned',
  expected: 'The scores are APPLIED, and the correction replaces the earlier value',
}, async (ev) => {
  const paper = await newPaper('jane');
  const students = (await roster()).slice(0, 3);
  const first = await submit('jane', paper.assessment_id, students.map((s, i) => entry(s.student_id, 40 + i * 10)));
  assert.equal(first.accepted, 3);
  const version = first.results[0].item._version;
  const edited = await submit('jane', paper.assessment_id, [entry(students[0].student_id, 72, { _version: version })]);
  assert.equal(outcomeOf(edited), 'APPLIED');
  const now = (await stored('jane', paper.assessment_id)).find((x) => x.student_id === students[0].student_id);
  assert.equal(now.raw_score, 72);
  ev(`3 scores APPLIED, then 40 corrected to 72 for ${students[0].student_id} (version ${version} -> ${now._version})`);
});

tc({
  id: 'TC-G04', requirement: 'FR-03', level: 'Integration', technique: 'Black box, boundary and negative',
  scenario: 'Scores outside the assessment mark range are submitted',
  data: 'max_score 50; submitted -1, 0, 50 and 51',
  expected: 'The in-range values 0 and 50 are APPLIED and -1 and 51 are REJECTED',
}, async (ev) => {
  const paper = await newPaper('jane', { max_score: 50 });
  const students = (await roster()).slice(0, 4);
  const raws = [-1, 0, 50, 51];
  const out = await submit('jane', paper.assessment_id, raws.map((r, i) => entry(students[i].student_id, r)));
  const byRaw = Object.fromEntries(raws.map((r, i) => [r, outcomeOf(out, i)]));
  assert.deepEqual(byRaw, { '-1': 'REJECTED', 0: 'APPLIED', 50: 'APPLIED', 51: 'REJECTED' });
  assert.equal(out.accepted, 2);
  assert.equal(out.rejected, 2);
  ev(`outcomes ${JSON.stringify(byRaw)}; ${out.results.filter((r) => r.outcome === 'REJECTED').map((r) => r.reason).join(' / ')}`);
});

tc({
  id: 'TC-G08', requirement: 'FR-02', level: 'Integration', technique: 'Black box, negative',
  scenario: 'A teacher submits scores for a class or subject they do not teach',
  data: 'peter.otieno (English, Mathematics) submits for a Kiswahili paper',
  expected: 'The submission is refused as Forbidden and no score is stored',
}, async (ev) => {
  const paper = await newPaper('jane');
  const student = (await roster())[0];
  const e = await refused(() => submit('peter', paper.assessment_id, [entry(student.student_id, 10)]));
  assert.ok(['Forbidden', 'NotFound'].includes(e.errorType), `unexpected refusal ${e.errorType}: ${e.message}`);
  assert.equal((await stored('jane', paper.assessment_id)).length, 0);
  ev(`refused (${e.errorType}: ${e.message}); 0 scores stored`);
});

tc({
  id: 'TC-G09', requirement: 'FR-01', level: 'Integration', technique: 'Black box, idempotency',
  scenario: 'The same assessment creation is sent twice with the same client identifier',
  data: 'one assessment_id, two identical requests',
  expected: 'One assessment exists; the second request returns the same record rather than a duplicate',
}, async (ev) => {
  const first = await newPaper('jane', { assessment_id: ulid() });
  const again = await createRaw('jane', {
    assessment_id: first.assessment_id, school_id: SCHOOL, class_id: CLASS, term_id: first.term_id, subject: first.subject,
    title: first.title, assessment_type: first.assessment_type, paper_no: first.paper_no, weight: first.weight, max_score: first.max_score,
  });
  assert.equal(again.assessment_id, first.assessment_id);
  const list = (await as('jane', LIST_ASSESSMENTS, { school_id: SCHOOL, class_id: CLASS, term_id: TERM })).listAssessmentsByClass.items;
  assert.equal(list.filter((x) => x.assessment_id === first.assessment_id).length, 1);
  ev(`both requests returned ${first.assessment_id}; one record in the class list`);
});

tc({
  id: 'TC-G10', requirement: 'FR-02', level: 'Integration', technique: 'Black box, concurrency',
  scenario: 'A teacher edits a mark from a stale copy after someone else recorded a different mark',
  data: 'john.man (administrator) enters 55; jane.doe then sends 61 without the version john created, as if she had opened the sheet earlier',
  expected: 'The teacher\'s stale edit is held for review (REVIEW or CONFLICT) with her mark recorded beside the saved one, and the saved mark is not replaced',
}, async (ev) => {
  const paper = await newPaper('jane');
  const student = (await roster())[0];
  const theirs = await submit('john', paper.assessment_id, [entry(student.student_id, 55)]);
  assert.equal(outcomeOf(theirs), 'APPLIED');
  const mine = await submit('jane', paper.assessment_id, [entry(student.student_id, 61, { _version: null })]);
  const outcome = outcomeOf(mine);
  assert.ok(['CONFLICT', 'REVIEW'].includes(outcome), `a stale edit from a teacher over another user's mark was ${outcome}: ${mine.results[0]?.reason}`);
  const now = (await stored('jane', paper.assessment_id)).find((x) => x.student_id === student.student_id);
  assert.equal(now.raw_score, 55, 'the saved mark was replaced');
  assert.equal(now.conflict_with_score, 61, 'the stale mark was not recorded beside the saved one for a decision');
  ev(`stale edit ${outcome} (${mine.results[0]?.reason ?? 'no reason'}); saved mark still 55, 61 recorded for review`);
});

tc({
  id: 'TC-G13', requirement: 'FR-02', level: 'Integration', technique: 'Black box, designed rule',
  scenario: 'Conflict rules that let a later entry stand: the same person correcting themselves, and an administrator overriding',
  data: 'jane.doe enters 40, then sends 45 from a stale copy; then john.man sends 50 from a stale copy',
  expected: 'Jane\'s own later entry replaces her earlier one (stored 45); the administrator\'s stale entry is applied by design with the reason "Overridden by an administrator" (stored 50)',
}, async (ev) => {
  const paper = await newPaper('jane');
  const student = (await roster())[0];
  assert.equal(outcomeOf(await submit('jane', paper.assessment_id, [entry(student.student_id, 40)])), 'APPLIED');
  const own = await submit('jane', paper.assessment_id, [entry(student.student_id, 45, { _version: null })]);
  assert.equal(outcomeOf(own), 'APPLIED', `her own later entry was ${outcomeOf(own)}`);
  const readNow = async () => (await stored('jane', paper.assessment_id)).find((x) => x.student_id === student.student_id);
  assert.equal((await readNow()).raw_score, 45);
  const admin = await submit('john', paper.assessment_id, [entry(student.student_id, 50, { _version: null })]);
  assert.equal(outcomeOf(admin), 'APPLIED', `the administrator's entry was ${outcomeOf(admin)}`);
  assert.match(admin.results[0].reason ?? '', /administrator/i);
  assert.equal((await readNow()).raw_score, 50);
  ev(`own correction applied (40 -> 45: ${own.results[0].reason}); administrator override applied (45 -> 50: ${admin.results[0].reason})`);
});

tc({
  id: 'TC-G14', requirement: 'FR-04', level: 'Integration', technique: 'Black box, boundary (missing mark)',
  scenario: 'Results are calculated when one student has no mark in a subject that otherwise has valid, complete papers',
  data: 'seeded Term 1 Kiswahili Opener paper (100% of the exam, every student scored): the teacher clears the first student\'s mark, results are calculated, and the mark is then restored',
  expected: 'The calculation completes and warns (ZERO_COVERED) that the student has no counted Kiswahili paper, instead of failing; the restored mark equals the original',
}, async (ev, t) => {
  const term = 'term_2026_1';
  const papers = (await as('jane', LIST_ASSESSMENTS, { school_id: SCHOOL, class_id: CLASS, term_id: term })).listAssessmentsByClass.items;
  const paper = papers.find((a) => a.subject === SUBJECT && /^opener$/i.test(a.assessment_type) && a.score_count > 0);
  if (!paper) { const why = `no scored Kiswahili Opener paper in ${term} (reseed with npm run db:seed)`; ev(why); t.skip(why); return; }
  if ((await resultSet(term, 'OPENER'))?.status === 'PUBLISHED') { const why = `${term} Opener is already published; reseed and rerun`; ev(why); t.skip(why); return; }
  const original = (await stored('jane', paper.assessment_id))[0];
  const cleared = await submit('jane', paper.assessment_id, [{ student_id: original.student_id, raw_score: null, mark_status: 'SCORED', _version: original._version }]);
  assert.equal(outcomeOf(cleared), 'APPLIED', `the mark could not be cleared: ${cleared.results[0]?.reason}`);
  let set;
  try {
    set = (await as('john', CALCULATE_TERM_RESULTS, { input: scope(term, 'OPENER') })).calculateTermResults;
  } finally {
    const back = await submit('jane', paper.assessment_id, [entry(original.student_id, original.raw_score)]);
    assert.equal(outcomeOf(back), 'APPLIED', `the cleared mark could not be restored: ${back.results[0]?.reason}`);
  }
  const restored = (await stored('jane', paper.assessment_id)).find((x) => x.student_id === original.student_id);
  assert.equal(restored.raw_score, original.raw_score, 'the restored mark differs from the original');
  const zero = set.issues.find((i) => i.code === 'ZERO_COVERED' && i.subject === SUBJECT);
  assert.ok(zero, `no ZERO_COVERED warning for ${SUBJECT}; issues: ${set.issues.map((i) => i.code).join(', ') || 'none'}`);
  ev(`calculation returned (blocking ${set.blocking}); warning: ${zero.message}; mark restored to ${restored.raw_score}`);
});

// ========================================================= publication cases (PUB_TERM)

tc({
  id: 'TC-G05', requirement: 'FR-04', level: 'Integration', technique: 'White box, calculated result',
  scenario: 'Checkpoint results are calculated from weighted papers and checked against a hand calculation',
  data: 'Kiswahili Opener of the calculation term: paper 1 (weight 40, out of 100) and paper 2 (weight 60, out of 50); one student scored 60 and 20, the rest 50 and 25; no other Opener papers exist in that term',
  expected: 'The Kiswahili exam result is the weighted mean of the two papers as percentages: 0.4 x 60 + 0.6 x 40 = 48, within rounding',
}, async (ev) => {
  const p1 = await newPaper('jane', { term_id: CALC_TERM, assessment_type: 'Opener', paper_no: 1, weight: 40, max_score: 100 });
  const p2 = await newPaper('jane', { term_id: CALC_TERM, assessment_type: 'Opener', paper_no: 2, weight: 60, max_score: 50 });
  const everyone = await roster();
  const student = everyone[0];
  // The first student is the hand-calculated one; the rest are scored too, so no one is missing a mark here (TC-G14 covers that).
  const marks = (first, rest) => everyone.map((s, i) => entry(s.student_id, i === 0 ? first : rest));
  assert.equal((await submit('jane', p1.assessment_id, marks(60, 50))).accepted, everyone.length);
  assert.equal((await submit('jane', p2.assessment_id, marks(20, 25))).accepted, everyone.length);
  await calculate(CALC_TERM, 'OPENER');
  const rows = (await as('john', GET_TERM_RESULTS, scope(CALC_TERM, 'OPENER'))).getTermResults;
  const subject = rows.find((r) => r.student_id === student.student_id).subjects.find((s) => s.subject === SUBJECT);
  const expected = 0.4 * 60 + 0.6 * (20 / 50 * 100);
  assert.ok(Math.abs(subject.score - expected) < 0.51, `expected about ${expected}, got ${subject.score}`);
  ev(`hand calculation ${expected}, system ${subject.score}`);
});

tc({
  id: 'TC-G06', requirement: 'FR-05', level: 'Integration', technique: 'Black box, authorisation and state',
  scenario: 'An administrator reviews and publishes Opener, Mid-term and End of term results, and the term locks',
  data: 'the seeded Term 1 papers of cls_test (every model subject, every student scored); a teacher tries to publish first; afterwards a new End-term paper is added by the administrator',
  expected: 'A teacher cannot publish; the administrator publishes Opener, Mid-term and End of term in order and each becomes PUBLISHED; afterwards a new End-term paper is refused because the term is locked',
}, async (ev, t) => {
  if ((await resultSet(PUB_TERM, 'OPENER'))?.status === 'PUBLISHED') {
    const why = `${PUB_TERM} was already published by an earlier run; reseed (npm run db:seed) and rerun`;
    ev(why); t.skip(why); return;
  }
  await calculate(PUB_TERM, 'OPENER');
  const opener = await resultSet(PUB_TERM, 'OPENER');
  const teacher = await refused(() => as('jane', PUBLISH_RESULTS, { input: { ...scope(PUB_TERM, 'OPENER'), _version: opener._version } }), 'Forbidden');
  const done = await publishThrough(PUB_TERM, 'ENDTERM');
  assert.deepEqual(Object.keys(done), ['OPENER', 'MIDTERM', 'ENDTERM']);
  const states = await Promise.all(CHAIN.map(async (cp) => `${cp} ${(await resultSet(PUB_TERM, cp)).status}`));
  assert.ok(states.every((x) => x.endsWith('PUBLISHED')), states.join(', '));
  shared.published = true;
  const late = await refused(() => createRaw('john', {
    assessment_id: ulid(), school_id: SCHOOL, class_id: CLASS, term_id: PUB_TERM, subject: 'Chemistry', title: `After publish ${unique()}`,
    assessment_type: 'End-term', paper_no: 1, weight: 10, max_score: 100,
  }));
  assert.match(late.message, /lock|publish/i, `refused, but not because the term is locked: ${late.message}`);
  ev(`teacher refused (${teacher.errorType}); ${states.join(', ')}; new paper refused (${late.errorType}: ${late.message})`);
});

tc({
  id: 'TC-G07', requirement: 'FR-06', level: 'Integration', technique: 'Black box, positive',
  scenario: 'Report cards are produced for a published End of term set',
  data: 'the End of term set published in TC-G06; the report-card worker needs Step Functions and object storage',
  expected: 'Within TEST_REPORT_WAIT_S (default 30) seconds at least one student has an available OFFICIAL report card. (The PDF itself is checked by TC-M01.)',
}, async (ev, t) => {
  if (!shared.published) { const why = 'TC-G06 did not publish a set in this run'; ev(why); t.skip(why); return; }
  const cards = async () => (await as('john', LIST_REPORT_CARDS, scope(PUB_TERM, 'ENDTERM'))).listReportCards;
  let list = await cards();
  const waits = Math.ceil(Number(process.env.TEST_REPORT_WAIT_S || 30) / 3);
  for (let i = 0; i < waits && !list.some((c) => c.available); i++) { await sleep(3000); list = await cards(); }
  const ready = list.filter((c) => c.available);
  if (!ready.length) {
    const why = `no report card was produced for ${list.length} students: the report-card worker is not running (it needs Step Functions Local and object storage)`;
    ev(why); t.skip(why); return;
  }
  assert.ok(ready.every((c) => c.kind === 'OFFICIAL'), 'an End of term card is not marked OFFICIAL');
  ev(`${ready.length} of ${list.length} report cards available, kind ${ready[0].kind}`);
});

tc({
  id: 'TC-G12', requirement: 'FR-02', level: 'Integration', technique: 'Black box, negative and state',
  scenario: 'A teacher edits a score after the results containing it have been published',
  data: 'a seeded Kiswahili End-term paper of the publication term, whose marks were published in TC-G06; jane.doe tries to change the first mark to 99 with its current version',
  expected: 'The edit is refused because the term is locked, and the stored mark is unchanged',
}, async (ev, t) => {
  if (!shared.published) { const why = 'TC-G06 did not publish a set in this run'; ev(why); t.skip(why); return; }
  const papers = (await as('jane', LIST_ASSESSMENTS, { school_id: SCHOOL, class_id: CLASS, term_id: PUB_TERM })).listAssessmentsByClass.items;
  const paper = papers.find((a) => a.subject === SUBJECT && /^end-?term$/i.test(a.assessment_type) && a.score_count > 0);
  if (!paper) { const why = `no scored Kiswahili End-term paper in ${PUB_TERM}`; ev(why); t.skip(why); return; }
  const mark = (await stored('jane', paper.assessment_id))[0];
  const e = await refused(() => submit('jane', paper.assessment_id, [entry(mark.student_id, 99, { _version: mark._version })]));
  assert.match(e.message, /lock|publish/i, `refused, but not because results are published: ${e.message}`);
  const after = (await stored('jane', paper.assessment_id)).find((x) => x.student_id === mark.student_id);
  assert.equal(after.raw_score, mark.raw_score, 'the stored mark changed');
  ev(`${paper.title}: refused with ${e.errorType}: ${e.message}; mark still ${after.raw_score}`);
});
