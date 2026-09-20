import 'dotenv/config';
import { PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk } from '../backend/library/keys.js';
import { ensureTable } from './create-table.js';
import { issueToken } from './token.js';
import { pathToFileURL } from 'node:url';

/**
 * Seeds Saint Innocent High School from the prototype. Deterministic: the same
 * ids every run, so screenshots, tests and demo scripts stay valid.
 *
 * This writes through the same key helpers the services use, so the local data
 * is byte-for-byte what a real DynamoDB table would hold. Migrating it after
 * the lift is a scan-and-batch-write, not a transformation.
 */
const SCHOOL = 'sch_saint_innocent';
const TERM = 'term_2026_2';

const STREAMS = ['North', 'East', 'South', 'West'];
const SUBJECTS = ['Kiswahili', 'CRE', 'Mathematics', 'English', 'Biology'];

const FIRST = ['Riziki', 'Kwame', 'Justin', 'Raya', 'Troben', 'Suka', 'Josie', 'Beatrice', 'Pete', 'Amina', 'Otieno', 'Naliaka', 'Wanjiru', 'Baraka', 'Zawadi', 'Mueni', 'Kip', 'Halima', 'Dedan', 'Nyokabi'];
const LAST = ['Juma', 'Nkurumah', 'Flitch', 'Namaari', 'Morning', 'Zuka', 'Botto', 'Snicket', 'Garraty', 'Were', 'Achieng', 'Mwangi', 'Kimani', 'Odhiambo', 'Chebet', 'Mutiso', 'Barasa', 'Njeri', 'Okumu', 'Wafula'];

// Small deterministic PRNG so the roster is identical on every machine.
let seedState = 20260913;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const items = [];
const now = new Date().toISOString();

items.push({
  PK: pk(SCHOOL), SK: 'SCHOOL#PROFILE', entity: 'School',
  school_id: SCHOOL, name: 'Saint Innocent High School', country: 'KE', region: 'Nairobi',
});

// GradeRule, straight off the School customization screen of the prototype.
items.push({
  PK: pk(SCHOOL), SK: sk.gradeRule(TERM), entity: 'GradeRule',
  grade_rule_id: `gr_${TERM}`, school_id: SCHOOL, term_id: TERM,
  pass_mark: 50, at_risk_threshold: 50,
  missing_score_policy: 'EXCLUDE',
  bands: [
    { grade: 'A',  min_score: 91, max_score: 100 },
    { grade: 'A-', min_score: 81, max_score: 90 },
    { grade: 'B',  min_score: 71, max_score: 80 },
    { grade: 'B-', min_score: 61, max_score: 70 },
    { grade: 'C',  min_score: 51, max_score: 60 },
    { grade: 'C-', min_score: 41, max_score: 50 },
    { grade: 'D',  min_score: 31, max_score: 40 },
    { grade: 'D-', min_score: 21, max_score: 30 },
    { grade: 'E',  min_score: 0,  max_score: 20 },
  ],
  updated_at: now,
});

items.push({
  PK: pk(SCHOOL), SK: `TERM#${TERM}`, entity: 'Term',
  term_id: TERM, school_id: SCHOOL, name: 'Term 2, 2026',
  start_date: '2026-05-04', end_date: '2026-08-07', status: 'CURRENT',
});

// Classes: the prototype shows form + stream + subject, so a "class" here is a
// teaching group, which is what Assessment.class_id points at.
const classes = [];
for (const form of [2, 4]) {
  for (const stream of STREAMS) {
    const classId = `cls_f${form}${stream.toLowerCase()}`;
    classes.push({ classId, form, stream });
    items.push({
      PK: pk(SCHOOL), SK: sk.klass(classId), entity: 'Class',
      class_id: classId, school_id: SCHOOL, name: `Form ${form} ${stream}`,
      grade: `Form ${form}`, stream, year: 2026, status: 'CURRENT',
    });
  }
}

// Teachers. Jane Doe teaches Kiswahili to four groups; Zama Nile is the head
// teacher and John Man is an administrator.
const jane = 'usr_jane_doe';
const zama = 'usr_zama_nile';
const admin = 'usr_john_man';

const janeClasses = ['cls_f4south', 'cls_f4east', 'cls_f2east', 'cls_f2west'];

items.push({
  PK: pk(SCHOOL), SK: sk.teacher(jane), entity: 'Teacher',
  teacher_id: jane, school_id: SCHOOL, first_name: 'Jane', last_name: 'Doe',
  email: 'jane.doe@saintinnocent.ac.ke', subjects: ['Kiswahili'],
  class_ids: janeClasses, groups: ['Teacher'], status: 'ACTIVE',
});
items.push({
  PK: pk(SCHOOL), SK: sk.teacher(zama), entity: 'Teacher',
  teacher_id: zama, school_id: SCHOOL, first_name: 'Zama', last_name: 'Nile',
  email: 'zama.nile@saintinnocent.ac.ke', subjects: ['CRE'],
  class_ids: classes.map((c) => c.classId), groups: ['Head Teacher'], status: 'ACTIVE',
});
items.push({
  PK: pk(SCHOOL), SK: sk.teacher(admin), entity: 'Teacher',
  teacher_id: admin, school_id: SCHOOL, first_name: 'John', last_name: 'Man',
  email: 'john.man@saintinnocent.ac.ke', subjects: [],
  class_ids: classes.map((c) => c.classId), groups: ['Admin'], status: 'ACTIVE',
});

// Students. The three named in the prototype keep their admission numbers.
const named = [
  { first: 'Riziki', last: 'Juma',     adm: '17355', classId: 'cls_f4south' },
  { first: 'Kwame',  last: 'Nkurumah', adm: '17921', classId: 'cls_f2east' },
  { first: 'Justin', last: 'Flitch',   adm: '18141', classId: 'cls_f2north' },
];

let adm = 17000;
const students = [];
for (const c of classes) {
  const size = 38 + Math.floor(rnd() * 6);
  for (let i = 0; i < size; i++) {
    students.push({
      student_id: `stu_${++adm}`,
      admission_no: String(adm),
      first_name: pick(FIRST),
      last_name: pick(LAST),
      class_id: c.classId,
    });
  }
}
for (const n of named) {
  students.push({
    student_id: `stu_${n.adm}`,
    admission_no: n.adm,
    first_name: n.first,
    last_name: n.last,
    class_id: n.classId,
  });
}
for (const s of students) {
  items.push({
    PK: pk(SCHOOL), SK: sk.student(s.student_id), entity: 'Student',
    school_id: SCHOOL, status: 'ACTIVE', ...s,
  });
}

async function run() {
  await ensureTable({ reset: process.argv.includes('--reset') });
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) },
      })
    );
  }

  const tokens = {
    teacher: issueToken({ sub: jane, email: 'jane.doe@saintinnocent.ac.ke', name: 'Jane Doe', groups: ['Teacher'], schoolId: SCHOOL }),
    headTeacher: issueToken({ sub: zama, email: 'zama.nile@saintinnocent.ac.ke', name: 'Mrs. Zama Nile', groups: ['Head Teacher'], schoolId: SCHOOL }),
    admin: issueToken({ sub: admin, email: 'john.man@saintinnocent.ac.ke', name: 'Mr John Man', groups: ['Admin'], schoolId: SCHOOL }),
  };

  console.log(`Seeded ${items.length} items into ${TABLE}`);
  console.log(`  school  ${SCHOOL}`);
  console.log(`  term    ${TERM}`);
  console.log(`  classes ${classes.length}, students ${students.length}`);
  console.log('\nSign-in passwords are not used locally. Development tokens:\n');
  for (const [role, t] of Object.entries(tokens)) console.log(`${role}:\n${t}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();

export { SCHOOL, TERM, janeClasses, classes, students };