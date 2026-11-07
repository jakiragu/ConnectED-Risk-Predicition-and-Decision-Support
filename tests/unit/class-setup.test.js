import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSetup, setupFromClasses, classFieldProblem } from '../../backend/library/classSetup.js';

test('class setup: lists are tidied and checked', () => {
  const { setup, problems } = normaliseSetup({ forms: [' Form 1 ', 'Form  2', ''], streams: ['East', 'east'] });
  assert.deepEqual(setup, { forms: ['Form 1', 'Form 2'], streams: ['East'] });
  assert.match(problems.join(), /listed twice/);
  assert.match(normaliseSetup({ forms: [], streams: ['East'] }).problems.join(), /at least one form/);
});

test('class setup: starting lists come from existing classes, in natural order', () => {
  assert.deepEqual(setupFromClasses([{ grade: 'Form 10', stream: 'West' }, { grade: 'Form 2', stream: 'East' }, { grade: 'Form 2', stream: 'West' }]),
    { forms: ['Form 2', 'Form 10'], streams: ['East', 'West'] });
});

test('class setup: enforced only once saved, case-insensitively', () => {
  const saved = { forms: ['Form 1'], streams: ['East'], _version: 1 };
  assert.equal(classFieldProblem({ ...saved, _version: 0 }, { grade: 'Form 9', stream: 'X' }), null);
  assert.equal(classFieldProblem(saved, { grade: 'form 1', stream: 'EAST' }), null);
  assert.equal(classFieldProblem(saved, { grade: 'Form 1', stream: 'Est' }).field, 'stream');
  assert.equal(classFieldProblem(saved, { grade: null, stream: null }), null);
});

import { canonicalClassFields } from '../../backend/library/classSetup.js';

test('class setup: stored in the school’s own spelling', () => {
  const saved = { forms: ['Form 1'], streams: ['East'], _version: 1 };
  assert.deepEqual(canonicalClassFields(saved, { grade: 'form 1', stream: ' EAST ', year: 2027 }), { grade: 'Form 1', stream: 'East', year: 2027 });
  assert.deepEqual(canonicalClassFields({ ...saved, _version: 0 }, { grade: 'form 1' }), { grade: 'form 1' });
});
