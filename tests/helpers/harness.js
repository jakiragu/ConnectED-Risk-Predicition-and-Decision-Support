import { appendFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Turns a Node test into a recorded test case for Chapter 5.
 *
 * Every case declares, before it runs, the requirement it traces to, the
 * scenario and data, and the expected result. The harness records that
 * declaration together with what was observed and the verdict, so the report's
 * test-case table is produced from executed tests rather than written by hand.
 * A case that throws is recorded as FAIL with the assertion message; a case that
 * calls t.skip() is recorded as SKIPPED with the reason, never as PASS. No result
 * is edited or dropped afterwards.
 *
 *   tc({ id: 'TC-001', requirement: 'FR-01', level: 'Integration',
 *        scenario: '...', data: '...', expected: '...' }, async (ev) => {
 *     ...assertions...
 *     ev('what was observed');            // one line of observed evidence
 *   });
 *
 * Results are appended to docs/evidence/test-cases.jsonl (set EVIDENCE=0 to
 * skip). tests/report.js turns that file into the tables in Section 5.4.
 */
const FILE = process.env.EVIDENCE_FILE || 'docs/evidence/test-cases.jsonl';
const RECORD = process.env.EVIDENCE !== '0';
let ready = false;

function write(row) {
  if (!RECORD) return;
  if (!ready) { mkdirSync(FILE.replace(/\/[^/]+$/, ''), { recursive: true }); ready = true; }
  appendFileSync(FILE, `${JSON.stringify(row)}\n`);
}

export function tc(meta, body) {
  for (const field of ['id', 'requirement', 'scenario', 'expected']) {
    if (!meta[field]) throw new Error(`test case ${meta.id || '?'} is missing ${field}`);
  }
  test(`${meta.id} ${meta.requirement}: ${meta.scenario}`, async (t) => {
    const observed = [];
    const started = Date.now();
    const ev = (line) => observed.push(String(line));

    // node:test's t.skip() marks the case skipped but does NOT stop the body or
    // throw, so without this the case would fall through and be written as PASS.
    // Wrapping it records the skip, and the verdict below becomes SKIPPED.
    let skipped = null;
    const nativeSkip = t.skip.bind(t);
    t.skip = (reason) => { skipped = reason || 'skipped'; return nativeSkip(reason); };

    const row = (verdict, actual) => ({ ...meta, actual, verdict, ms: Date.now() - started, run_at: new Date().toISOString() });
    try {
      await body(ev, t);
      if (skipped !== null) write(row('SKIPPED', (observed.includes(String(skipped)) ? observed : [...observed, `SKIPPED: ${skipped}`]).join('; ')));
      else write(row('PASS', observed.length ? observed.join('; ') : 'all assertions held'));
    } catch (e) {
      write(row('FAIL', [...observed, `FAILED: ${e.message}`].join('; ')));
      throw e;
    }
  });
}

/**
 * Asserts that a call is refused by the service, and returns the error.
 *
 * A request the server rejects for its SHAPE (wrong field name, wrong type) was never
 * evaluated by the service, so it proves nothing about authorisation or validation.
 * That is reported as a failure of the test, not accepted as a refusal.
 */
const MALFORMED = /^Variable "\$|Cannot query field|Unknown argument|is not defined by type|of required type .* was not provided|Unknown type/;
export async function refused(fn, errorType) {
  try {
    await fn();
  } catch (e) {
    if (MALFORMED.test(e.message)) {
      throw new assert.AssertionError({ message: `the request was malformed, so the service never judged it: ${e.message.slice(0, 200)}` });
    }
    if (e instanceof assert.AssertionError) throw e;
    if (errorType) assert.equal(e.errorType, errorType, `expected ${errorType}, got ${e.errorType}: ${e.message}`);
    return e;
  }
  throw new assert.AssertionError({ message: 'the call was allowed; it should have been refused' });
}

export const pct = (p) => `${Math.round(p * 1000) / 10}%`;
