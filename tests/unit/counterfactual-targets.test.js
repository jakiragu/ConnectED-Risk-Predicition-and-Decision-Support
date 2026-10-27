import assert from 'node:assert/strict';
import { tc } from '../helpers/harness.js';
import { cumulativeAttendance } from '../../backend/library/attendance.js';
import { buildFeatureRow, NEXT_CHECKPOINT, nextPeriodSchoolDays } from '../../backend/library/features.js';
import { bestTarget, changeView, parseTargetColumn, targetText, targetsOf } from '../../backend/library/targets.js';

const term1 = {
  term_id: 't1', name: 'Term 1', term_number: 1, start_date: '2026-01-05', mid_term_date: '2026-02-20', end_date: '2026-04-03',
  closures: [{ from: '2026-02-26', to: '2026-03-01' }, { from: '2026-04-03', to: '2026-04-03' }],
};

tc({
  id: 'TC-U08', requirement: 'FR-07', level: 'Unit', technique: 'White box, calculation',
  scenario: 'Year-to-date attendance is derived from attendance records',
  data: '35 school days, 30 attended, 3 excused; and no records',
  expected: '93.75% from 30 attended of 32 counted (excused days leave the denominator); no records give null',
}, () => {
  const r = cumulativeAttendance([{ key: 'a', school_days: 35 }], new Map([['a', { days_attended: 30, days_excused: 3 }]]));
  assert.deepEqual([r.percentage, r.attended, r.counted], [93.75, 30, 32]);
  const missing = cumulativeAttendance([{ key: 'a', school_days: 35 }], new Map());
  assert.deepEqual([missing.percentage, missing.attended, missing.counted], [null, null, null]);
});

tc({
  id: 'TC-U09', requirement: 'FR-07', level: 'Unit', technique: 'White box, feature construction',
  scenario: 'The feature row sent to the scorer is built from published history and attendance',
  data: 'point T1M, Term 1 attendance of 30 attended and 3 excused, no earlier history',
  expected: 'Attendance_T1M equals 93.75 and the totals behind it travel with the row',
}, () => {
  const row = buildFeatureRow({
    point: 'T1M', termsByNumber: new Map([[1, term1]]), history: [],
    attendance: [{ term_id: 't1', period: 'MIDTERM', days_attended: 30, days_excused: 3 }],
  });
  assert.equal(row.values.Attendance_T1M, 93.75);
  assert.deepEqual(row.attendance_totals.T1M, { attended: 30, counted: 32 });
});

tc({
  id: 'TC-U10', requirement: 'FR-10', level: 'Unit', technique: 'White box, mapping and calculation',
  scenario: 'The next checkpoint and the school days remaining before it',
  data: 'each prediction point; Term 1 with a half-term break and a public holiday; Term 2 not configured',
  expected: 'Each point maps to its successor; school days exclude closures (27 after the Term 1 Mid-term); an unconfigured term gives null',
}, () => {
  assert.deepEqual(Object.fromEntries(Object.entries(NEXT_CHECKPOINT).map(([k, v]) => [k, v.point])),
    { T1M: 'T1F', T1F: 'T2M', T2M: 'T2F', T2F: 'T3M', T3M: 'T3F' });
  const terms = new Map([[1, term1]]);
  assert.equal(nextPeriodSchoolDays('T1M', terms), 27); // Term 1 after Mid-term, less half-term and Good Friday
  assert.equal(nextPeriodSchoolDays('T1F', terms), null); // Term 2 not set up
});

tc({
  id: 'TC-U11', requirement: 'NFR-4 / FR-10', level: 'Unit', technique: 'White box, labels',
  scenario: 'Target columns are shown with plain-language labels and wording',
  data: 'T3F_Religious_Education, Attendance_T1F, and a change of Kiswahili 42 to 55',
  expected: 'Labels read as "CRE, Term 3 End-term exam" and similar; no raw column name; target text states the required value and the current one',
}, () => {
  assert.equal(parseTargetColumn('T3F_Religious_Education').label, 'CRE, Term 3 End-term exam');
  assert.equal(parseTargetColumn('Attendance_T1F').label, 'Attendance from the start of the year to Term 1 End-term');
  const ch = changeView({ feature: 'T1F_Kiswahili', from: 42, to: 55, basis: 'peer', peer: { window: 5, peers: 370, change: 4.8 } });
  assert.deepEqual([ch.group, ch.gain, ch.peer_window, ch.peer_count], ['Kiswahili', 13, 5, 370]);
  assert.equal(targetText(ch), 'Kiswahili: at least 55 (now 42)');
  assert.equal(targetText(changeView({ feature: 'Attendance_T1F', from: 85.71, to: 91 })), 'Attendance: at least 91.0% (now 85.7%)');
});

tc({
  id: 'TC-U12', requirement: 'FR-10', level: 'Unit', technique: 'White box, state handling',
  scenario: 'Stored counterfactual targets are presented according to their status',
  data: 'a FALLBACK record with one option still at risk; a MAINTAIN record; null',
  expected: 'The view keeps the cap source and the at-risk flag of each option; the best target is returned for FALLBACK and empty for MAINTAIN; null stays null',
}, () => {
  const stored = {
    status: 'FALLBACK', method: 'peer-progression', reason: 'Even the largest permitted changes would leave the student at risk',
    target_point: 'T1F', evaluation: { kind: 'model', model_point: 'T1F', threshold: 0.5, baseline_score: 0.99, baseline_at_risk: true },
    caps: { T1F_English: { current: 36, max_increase: 21.6, max_value: 57.6, source: 'data' } },
    dice: { found: false, reason: 'Even the largest permitted changes would leave the student at risk' },
    options: [{ method: 'peer-progression', score: 0.98, at_risk: true, changes: [{ feature: 'T1F_English', from: 36, to: 45, basis: 'peer' }] }],
    stats_available: true,
  };
  const view = targetsOf(stored);
  assert.equal(view.target_label, 'Term 1 End-term');
  assert.equal(view.model_point, 'T1F');
  assert.equal(view.caps[0].source, 'data');
  assert.equal(view.options[0].at_risk, true);
  assert.equal(bestTarget(stored).length, 1);
  assert.deepEqual(bestTarget({ ...stored, status: 'MAINTAIN', options: [] }), []);
  assert.equal(targetsOf(null), null);
});
