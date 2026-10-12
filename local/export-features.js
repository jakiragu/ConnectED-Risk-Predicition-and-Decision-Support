import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { csvHeader, csvLine, POINT_NAMES } from '../backend/library/features.js';
import * as features from '../backend/library/featureStore.js';
import * as platform from '../backend/library/platformRepo.js';

const [point, yearArg, classId, out] = process.argv.slice(2);
const SCHOOL = process.env.SCHOOL_ID || 'sch_saint_innocent';
if (!POINT_NAMES.includes(point) || !Number(yearArg)) {
  console.error('Usage: node local/export-features.js <T1M|T1F|T2M|T2F|T3M> <academic_year> [class_id] [out.csv]');
  process.exit(2);
}
const year = Number(yearArg);
const classes = classId ? [classId] : (await platform.listClasses(SCHOOL)).map((c) => c.class_id);
const terms = await features.termsOfYear(SCHOOL, year);
const lines = [csvHeader(point)];
let complete = 0;
let students = 0;
for (const c of classes) {
  for (const s of await platform.roster(SCHOOL, c)) {
    const row = await features.buildForStudent(SCHOOL, s.student_id, point, year, terms);
    lines.push(csvLine(point, s.student_id, row.values));
    students++;
    if (!row.missing.scores.length && !row.missing.attendance.length) complete++;
  }
}
const csv = `${lines.join('\n')}\n`;
if (out) writeFileSync(out, csv);
else process.stdout.write(csv);
console.error(`${students} students, ${complete} with every input, point ${point}, school year ${year}${out ? ` -> ${out}` : ''}`);