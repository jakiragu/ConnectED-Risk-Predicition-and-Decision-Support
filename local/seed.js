import 'dotenv/config';
import { PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk } from '../backend/library/keys.js';
import { ensureTable } from './create-table.js';
import { issueToken } from './token.js';
import { pathToFileURL } from 'node:url';

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

// Terms 1-3 of 2026, each with its GradeRule straight off the School
// customization screen of the prototype. Checkpoint weights are left unset:
// teachers set them per term before End of term results can be published.
const BANDS = [
  { grade: 'A',  min_score: 91, max_score: 100 },
  { grade: 'A-', min_score: 81, max_score: 90 },
  { grade: 'B',  min_score: 71, max_score: 80 },
  { grade: 'B-', min_score: 61, max_score: 70 },
  { grade: 'C',  min_score: 51, max_score: 60 },
  { grade: 'C-', min_score: 41, max_score: 50 },
  { grade: 'D',  min_score: 31, max_score: 40 },
  { grade: 'D-', min_score: 21, max_score: 30 },
  { grade: 'E',  min_score: 0,  max_score: 20 },
];
const TERMS = [
  { term_id: 'term_2026_1', name: 'Term 1, 2026', start_date: '2026-01-05', end_date: '2026-04-03', status: 'PAST' },
  { term_id: 'term_2026_2', name: 'Term 2, 2026', start_date: '2026-05-04', end_date: '2026-08-07', status: 'CURRENT' },
  { term_id: 'term_2026_3', name: 'Term 3, 2026', start_date: '2026-08-31', end_date: '2026-10-30', status: 'UPCOMING' },
];
for (const t of TERMS) {
  items.push({
    PK: pk(SCHOOL), SK: sk.gradeRule(t.term_id), entity: 'GradeRule',
    grade_rule_id: `gr_${t.term_id}`, school_id: SCHOOL, term_id: t.term_id,
    pass_mark: 50, at_risk_threshold: 50,
    missing_score_policy: 'EXCLUDE',
    bands: BANDS,
    checkpoint_weights_version: 0,
    updated_at: now,
  });
  items.push({
    PK: pk(SCHOOL), SK: sk.term(t.term_id), entity: 'Term', school_id: SCHOOL, ...t,
  });
}

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

// A five-student class for checking results and report cards by hand. Kept
// out of `classes` so the generated rosters above stay identical.
const TEST_CLASS = { classId: 'cls_test', name: 'Form 4 Test' };
items.push({
  PK: pk(SCHOOL), SK: sk.klass(TEST_CLASS.classId), entity: 'Class',
  class_id: TEST_CLASS.classId, school_id: SCHOOL, name: TEST_CLASS.name,
  grade: 'Form 4', stream: 'Test', year: 2026, status: 'CURRENT',
});
const allClassIds = [...classes.map((c) => c.classId), TEST_CLASS.classId];

// Teachers. Jane Doe teaches Kiswahili to four groups; Zama Nile is the head
// teacher and John Man is an administrator.
const jane = 'usr_jane_doe';
const zama = 'usr_zama_nile';
const admin = 'usr_john_man';

const janeClasses = ['cls_f4south', 'cls_f4east', 'cls_f2east', 'cls_f2west', TEST_CLASS.classId];

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
  class_ids: allClassIds, groups: ['Head Teacher'], status: 'ACTIVE',
});
items.push({
  PK: pk(SCHOOL), SK: sk.teacher(admin), entity: 'Teacher',
  teacher_id: admin, school_id: SCHOOL, first_name: 'John', last_name: 'Man',
  email: 'john.man@saintinnocent.ac.ke', subjects: [],
  class_ids: allClassIds, groups: ['Admin'], status: 'ACTIVE',
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
// The test class: fixed names and admission numbers 19001-19005.
const TEST_STUDENTS = [
  ['Achieng', 'Otieno'], ['Brian', 'Kamau'], ['Cynthia', 'Wanjiku'], ['David', 'Mutua'], ['Esther', 'Chebet'],
];
TEST_STUDENTS.forEach(([first, last], i) => {
  const no = String(19001 + i);
  students.push({ student_id: `stu_${no}`, admission_no: no, first_name: first, last_name: last, class_id: TEST_CLASS.classId });
});

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
  console.log(`  classes ${classes.length + 1}, students ${students.length}`);
  console.log(`  test    ${TEST_CLASS.name} (${TEST_CLASS.classId}), ${TEST_STUDENTS.length} students, assigned to Jane`);
  console.log('\nSign-in passwords are not used locally. Development tokens:\n');
  for (const [role, t] of Object.entries(tokens)) console.log(`${role}:\n${t}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();

export { SCHOOL, TERM, janeClasses, classes, students };