import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Builds the Section 5.4.2 tables from the executed cases.
 *
 *   node tests/report.js            # reads docs/evidence/test-cases.jsonl
 *
 * Writes docs/evidence/test-cases.md. Nothing is edited by hand. The table shows
 * the latest run of each case; every earlier run that did not pass is listed
 * after it, because a failure that a later run fixed is still a result.
 * A requirement with no PASS is listed as not yet evidenced.
 */
const FILE = process.env.EVIDENCE_FILE || 'docs/evidence/test-cases.jsonl';
const OUT = FILE.replace(/\.jsonl$/, '.md');
const REQUIREMENTS = [...Array.from({ length: 12 }, (_, i) => `FR-${String(i + 1).padStart(2, '0')}`), 'NFR-1', 'NFR-2', 'NFR-3', 'NFR-4'];

if (!existsSync(FILE)) { console.error(`no evidence at ${FILE}; run the tests first`); process.exit(1); }
const rows = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map();
for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
const latest = [...byId.values()].map((runs) => runs[runs.length - 1]).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const out = [];
const counts = latest.reduce((c, r) => ({ ...c, [r.verdict]: (c[r.verdict] ?? 0) + 1 }), {});
out.push(`Cases: ${latest.length} (${Object.entries(counts).map(([v, n]) => `${n} ${v}`).join(', ')}). Runs recorded: ${rows.length}.`, '');
out.push('| Test ID | Traceability | Scenario, data and conditions | Expected result | Actual result, evidence and verdict |', '|---|---|---|---|---|');
for (const r of latest) {
  out.push(`| ${r.id} | ${cell(r.requirement)} (${[r.level, r.technique].filter(Boolean).map(cell).join('; ')}) | ${cell(r.scenario)}${r.data ? ` Data: ${cell(r.data)}` : ''} | ${cell(r.expected)} | ${cell(r.actual)} **${r.verdict}** |`);
}

const earlier = [...byId.values()].flatMap((runs) => runs.slice(0, -1).filter((r) => r.verdict !== 'PASS'));
if (earlier.length) {
  out.push('', 'Earlier runs that did not pass (kept deliberately):', '', '| Test ID | Run at | Verdict | Observed |', '|---|---|---|---|');
  for (const r of earlier) out.push(`| ${r.id} | ${r.run_at} | ${r.verdict} | ${cell(r.actual)} |`);
}

const passed = new Set(latest.filter((r) => r.verdict === 'PASS').flatMap((r) => String(r.requirement).match(/N?FR-\d+/g) ?? []));
const gaps = REQUIREMENTS.filter((q) => !passed.has(q));
out.push('', gaps.length ? `Requirements with no passing automated case in this evidence file: ${gaps.join(', ')}. Cover them with the manual cases or explain the gap.` : 'Every requirement has at least one passing automated case.');

mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(OUT, `${out.join('\n')}\n`);
console.log(out.join('\n'));
