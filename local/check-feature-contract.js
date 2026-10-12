import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURE_CONTRACT, NON_FEATURE_COLUMNS, POINT_NAMES, MODEL_SUBJECTS, SUBJECT_TO_MODEL } from '../backend/library/features.js';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node local/check-feature-contract.js <folder with the snapshot CSVs>');
  process.exit(2);
}
let failed = 0;
for (const point of POINT_NAMES) {
  const header = readFileSync(join(dir, `snapshot_${point}.csv`), 'utf8').split(/\r?\n/)[0].split(',').map((c) => c.trim());
  const features = header.filter((c) => !NON_FEATURE_COLUMNS.includes(c));
  const expected = FEATURE_CONTRACT[point];
  const same = JSON.stringify(features) === JSON.stringify(expected);
  console.log(`${same ? 'PASS' : 'FAIL'}  ${point}: ${expected.length} feature columns${same ? ', same names and order as the snapshot' : ''}`);
  if (!same) {
    failed++;
    console.log(`        only in snapshot: ${features.filter((c) => !expected.includes(c)).join(', ') || '-'}`);
    console.log(`        only in contract: ${expected.filter((c) => !features.includes(c)).join(', ') || '-'}`);
  }
}
const contract = {
  description: 'Model inputs per prediction point, in column order. Missing values are null (XGBoost treats them as missing).',
  excluded_from_snapshots: NON_FEATURE_COLUMNS,
  model_subjects: MODEL_SUBJECTS,
  gradebook_subject_to_model: SUBJECT_TO_MODEL,
  points: FEATURE_CONTRACT,
};
mkdirSync(new URL('../ml/', import.meta.url), { recursive: true });
writeFileSync(new URL('../ml/feature-contract.json', import.meta.url), `${JSON.stringify(contract, null, 2)}\n`);
console.log(`\nWrote ml/feature-contract.json${failed ? ` (${failed} point(s) do not match)` : ''}`);
process.exitCode = failed ? 1 : 0;