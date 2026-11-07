import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandsFromLowerBounds, normaliseGrading, gradingPreview, sameGrading, DEFAULT_GRADING,
} from '../../backend/library/grading.js';
import { bandProblems } from '../../backend/library/results.js';

test('grading: lower marks alone build a complete scale with no gaps or overlaps', () => {
  const { bands, problems } = bandsFromLowerBounds([
    { grade: 'C', min_score: 0 }, { grade: 'A', min_score: 70 }, { grade: 'B', min_score: '50' },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(bands, [
    { grade: 'A', min_score: 70, max_score: 100 },
    { grade: 'B', min_score: 50, max_score: 69 },
    { grade: 'C', min_score: 0, max_score: 49 },
  ]);
  assert.deepEqual(bandProblems(bands), []);
});

test('grading: the scale must start at 0, use whole marks and distinct grades', () => {
  assert.match(bandsFromLowerBounds([{ grade: 'A', min_score: 50 }, { grade: 'B', min_score: 10 }]).problems.join(), /start at 0/);
  assert.match(bandsFromLowerBounds([{ grade: 'A', min_score: 50.5 }, { grade: 'B', min_score: 0 }]).problems.join(), /whole number/);
  assert.match(bandsFromLowerBounds([{ grade: 'A', min_score: 50 }, { grade: 'a', min_score: 0 }]).problems.join(), /more than once/);
  assert.match(bandsFromLowerBounds([{ grade: 'A', min_score: 0 }, { grade: 'B', min_score: 0 }]).problems.join(), /same mark/);
  assert.match(bandsFromLowerBounds([{ grade: 'A', min_score: 0 }]).problems.join(), /at least two/);
});

test('grading: the built-in default is a valid scale', () => {
  const { problems } = normaliseGrading({ ...DEFAULT_GRADING, bands: DEFAULT_GRADING.bands.map(({ grade, min_score }) => ({ grade, min_score })) });
  assert.deepEqual(problems, []);
});

test('grading: pass mark and missing-mark rule are checked', () => {
  const bands = [{ grade: 'P', min_score: 50 }, { grade: 'F', min_score: 0 }];
  assert.match(normaliseGrading({ pass_mark: 120, missing_score_policy: 'EXCLUDE', bands }).problems.join(), /pass mark/);
  assert.match(normaliseGrading({ pass_mark: 50, missing_score_policy: 'IGNORE', bands }).problems.join(), /missing mark/);
});

test('grading: the preview counts the students whose grade would change', () => {
  const current = bandsFromLowerBounds([{ grade: 'A', min_score: 70 }, { grade: 'B', min_score: 0 }]).bands;
  const proposed = bandsFromLowerBounds([{ grade: 'A', min_score: 60 }, { grade: 'B', min_score: 0 }]).bands;
  const p = gradingPreview([65, 72, 40, 60], current, proposed);
  assert.equal(p.total, 4);
  assert.equal(p.changed, 2);
  assert.deepEqual(p.moves, [{ from: 'B', to: 'A', count: 2 }]);
  assert.equal(sameGrading({ pass_mark: 50, missing_score_policy: 'ZERO', bands: current },
    { pass_mark: 50, missing_score_policy: 'ZERO', bands: [...current].reverse() }), true);
});
