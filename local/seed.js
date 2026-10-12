import 'dotenv/config';

import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk, gsi1, gsi2, gsi3 } from '../backend/library/keys.js';
import { ensureTable } from './create-table.js';
import * as identity from '../backend/library/identity.js';
import { pathToFileURL } from 'node:url';

const DEV_PASSWORD = process.env.SEED_PASSWORD || 'Gradebook-Dev-2026!';
const SCHOOL = 'sch_saint_innocent';
const TERM = 'term_2026_2';

const STREAMS = ['North', 'East', 'South', 'West'];

// Subjects used by the risk model. CRE remains the gradebook subject;
// the feature builder maps it to Religious_Education.
const MODEL_SUBJECTS = [
  'Mathematics',
  'English',
  'Kiswahili',
  'Chemistry',
  'Biology',
  'Physics',
  'History',
  'Geography',
  'CRE',
];

const FIRST = [
  'Riziki', 'Kwame', 'Justin', 'Raya', 'Troben',
  'Suka', 'Josie', 'Beatrice', 'Pete', 'Amina',
  'Otieno', 'Naliaka', 'Wanjiru', 'Baraka', 'Zawadi',
  'Mueni', 'Kip', 'Halima', 'Dedan', 'Nyokabi',
];

const LAST = [
  'Juma', 'Nkurumah', 'Flitch', 'Namaari', 'Morning',
  'Zuka', 'Botto', 'Snicket', 'Garraty', 'Were',
  'Achieng', 'Mwangi', 'Kimani', 'Odhiambo', 'Chebet',
  'Mutiso', 'Barasa', 'Njeri', 'Okumu', 'Wafula',
];

// Deterministic PRNG: generated classes, rosters and marks stay consistent.
let seedState = 20260913;
const rnd = () =>
  ((seedState = (seedState * 1103515245 + 12345) % 2147483648) /
    2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const items = [];
const now = new Date().toISOString();

items.push({
  PK: pk(SCHOOL),
  SK: 'SCHOOL#PROFILE',
  entity: 'School',
  school_id: SCHOOL,
  name: 'Saint Innocent High School',
  country: 'KE',
  region: 'Nairobi',
});

const BANDS = [
  { grade: 'A', min_score: 91, max_score: 100 },
  { grade: 'A-', min_score: 81, max_score: 90 },
  { grade: 'B', min_score: 71, max_score: 80 },
  { grade: 'B-', min_score: 61, max_score: 70 },
  { grade: 'C', min_score: 51, max_score: 60 },
  { grade: 'C-', min_score: 41, max_score: 50 },
  { grade: 'D', min_score: 31, max_score: 40 },
  { grade: 'D-', min_score: 21, max_score: 30 },
  { grade: 'E', min_score: 0, max_score: 20 },
];

const TERMS = [
  {
    term_id: 'term_2026_1',
    name: 'Term 1, 2026',
    academic_year: 2026,
    term_number: 1,
    start_date: '2026-01-05',
    mid_term_date: '2026-02-20',
    end_date: '2026-04-03',
    status: 'PAST',
    closures: [
      { from: '2026-02-26', to: '2026-03-01', label: 'Half-term break' },
      { from: '2026-04-03', to: '2026-04-03', label: 'Good Friday' },
    ],
  },
  {
    term_id: 'term_2026_2',
    name: 'Term 2, 2026',
    academic_year: 2026,
    term_number: 2,
    start_date: '2026-05-04',
    mid_term_date: '2026-06-19',
    end_date: '2026-08-07',
    status: 'CURRENT',
    closures: [
      { from: '2026-06-01', to: '2026-06-01', label: 'Madaraka Day' },
      { from: '2026-06-25', to: '2026-06-28', label: 'Half-term break' },
    ],
  },
  {
    term_id: 'term_2026_3',
    name: 'Term 3, 2026',
    academic_year: 2026,
    term_number: 3,
    start_date: '2026-08-31',
    mid_term_date: '2026-09-25',
    end_date: '2026-10-30',
    status: 'UPCOMING',
    closures: [
      { from: '2026-10-20', to: '2026-10-20', label: 'Mashujaa Day' },
    ],
  },
];

for (const term of TERMS) {
  items.push({
    PK: pk(SCHOOL),
    SK: sk.gradeRule(term.term_id),
    entity: 'GradeRule',
    grade_rule_id: `gr_${term.term_id}`,
    school_id: SCHOOL,
    term_id: term.term_id,
    pass_mark: 50,
    at_risk_threshold: 50,
    missing_score_policy: 'EXCLUDE',
    bands: BANDS,
    checkpoint_weights_version: 0,
    updated_at: now,
  });

  items.push({
    PK: pk(SCHOOL),
    SK: sk.term(term.term_id),
    entity: 'Term',
    school_id: SCHOOL,
    ...term,
    _version: 1,
  });
}

// Regular teaching classes.
const classes = [];

for (const form of [2, 4]) {
  for (const stream of STREAMS) {
    const classId = `cls_f${form}${stream.toLowerCase()}`;
    classes.push({ classId, form, stream });

    items.push({
      PK: pk(SCHOOL),
      SK: sk.klass(classId),
      entity: 'Class',
      class_id: classId,
      school_id: SCHOOL,
      name: `Form ${form} ${stream}`,
      grade: `Form ${form}`,
      stream,
      year: 2026,
      status: 'CURRENT',
      _version: 1,
    });
  }
}

// Dedicated five-student test class.
const TEST_CLASS = {
  classId: 'cls_test',
  name: 'Form 4 Test',
};

items.push({
  PK: pk(SCHOOL),
  SK: sk.klass(TEST_CLASS.classId),
  entity: 'Class',
  class_id: TEST_CLASS.classId,
  school_id: SCHOOL,
  name: TEST_CLASS.name,
  grade: 'Form 4',
  stream: 'Test',
  year: 2026,
  status: 'CURRENT',
  _version: 1,
});

const allClassIds = [
  ...classes.map((c) => c.classId),
  TEST_CLASS.classId,
];

// Teachers and their existing assignments.
const TEACHERS = [
  {
    key: 'jane',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: [
      'cls_f4south',
      'cls_f4east',
      'cls_f2east',
      'cls_f2west',
      TEST_CLASS.classId,
    ].map((class_id) => ({ class_id, subject: 'Kiswahili' })),
    class_teacher_of: TEST_CLASS.classId,
  },
  {
    key: 'zama',
    first_name: 'Zama',
    last_name: 'Nile',
    email: 'zama.nile@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: allClassIds.map((class_id) => ({
      class_id,
      subject: 'CRE',
    })),
    class_teacher_of: 'cls_f4south',
  },
  {
    key: 'peter',
    first_name: 'Peter',
    last_name: 'Otieno',
    email: 'peter.otieno@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: ['cls_f4south', TEST_CLASS.classId].flatMap(
      (class_id) =>
        ['English', 'Mathematics'].map((subject) => ({
          class_id,
          subject,
        }))
    ),
    class_teacher_of: null,
  },
  {
    key: 'john',
    first_name: 'John',
    last_name: 'Man',
    email: 'john.man@saintinnocent.ac.ke',
    role: 'Admin',
    assignments: [],
    class_teacher_of: null,
  },
];

const janeClasses = TEACHERS[0].assignments.map((a) => a.class_id);

// Existing named students.
const named = [
  {
    first: 'Riziki',
    last: 'Juma',
    adm: '17355',
    classId: 'cls_f4south',
  },
  {
    first: 'Kwame',
    last: 'Nkurumah',
    adm: '17921',
    classId: 'cls_f2east',
  },
  {
    first: 'Justin',
    last: 'Flitch',
    adm: '18141',
    classId: 'cls_f2north',
  },
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

const TEST_STUDENTS = [
  ['Achieng', 'Otieno'],
  ['Brian', 'Kamau'],
  ['Cynthia', 'Wanjiku'],
  ['David', 'Mutua'],
  ['Esther', 'Chebet'],
];

TEST_STUDENTS.forEach(([first_name, last_name], i) => {
  const admission_no = String(19001 + i);

  students.push({
    student_id: `stu_${admission_no}`,
    admission_no,
    first_name,
    last_name,
    class_id: TEST_CLASS.classId,
  });
});

/* Create the student and admission-number records. */
for (const student of students) {
  items.push({
    PK: pk(SCHOOL),
    SK: sk.student(student.student_id),
    entity: 'Student',
    school_id: SCHOOL,
    status: 'ACTIVE',
    _version: 1,
    ...student,
  });

  items.push({
    PK: pk(SCHOOL),
    SK: sk.admissionNo(student.admission_no),
    entity: 'AdmissionNo',
    admission_no: student.admission_no,
    student_id: student.student_id,
  });
}

/**
 * Creates one assessment for each model subject at each requested checkpoint,
 * then adds a score for every student in Form 4 Test.
 *
 * These are ordinary Assessment and Score records. No result calculation or
 * publication is performed here.
 */
function seedTestAssessmentsAndScores(enteredBy) {
  const checkpoints = [
    {
      point: 'T1O',
      term_id: 'term_2026_1',
      assessment_type: 'OPENER',
      title: 'Term 1 Opener',
    },
    {
      point: 'T1M',
      term_id: 'term_2026_1',
      assessment_type: 'MIDTERM',
      title: 'Term 1 Midterm',
    },
    {
      point: 'T1F',
      term_id: 'term_2026_1',
      assessment_type: 'ENDTERM',
      title: 'Term 1 Endterm',
    },
    {
      point: 'T2M',
      term_id: 'term_2026_2',
      assessment_type: 'MIDTERM',
      title: 'Term 2 Midterm',
    },
    {
      point: 'T2F',
      term_id: 'term_2026_2',
      assessment_type: 'ENDTERM',
      title: 'Term 2 Endterm',
    },
    {
      point: 'T3M',
      term_id: 'term_2026_3',
      assessment_type: 'MIDTERM',
      title: 'Term 3 Midterm',
    },
  ];

  let assessmentCount = 0;
  let scoreCount = 0;

  // Each student gets a consistent general performance profile, with small
  // subject/checkpoint variations. All scores are valid percentages out of 100.
  const studentBase = [43, 56, 68, 79, 91];

  checkpoints.forEach((checkpoint, checkpointIndex) => {
    MODEL_SUBJECTS.forEach((subject, subjectIndex) => {
      const assessmentId =
        `seed_${checkpoint.point}_${subject.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const assessment = {
        PK: pk(SCHOOL),
        SK: sk.assessment(assessmentId),
        GSI1PK: gsi1.pk(SCHOOL, TEST_CLASS.classId),
        GSI1SK: gsi1.assessment(checkpoint.term_id, assessmentId),
        entity: 'Assessment',
        assessment_id: assessmentId,
        school_id: SCHOOL,
        class_id: TEST_CLASS.classId,
        term_id: checkpoint.term_id,
        subject,
        title: `${subject} - ${checkpoint.title}`,
        assessment_type: checkpoint.assessment_type,
        paper_no: 1,
        weight: 100,
        max_score: 100,
        due_date: null,
        score_count: TEST_STUDENTS.length,
        created_at: now,
        updated_at: now,
        created_by: enteredBy,
        updated_by: enteredBy,
        _version: 1,
        _lastChangedAt: Date.now(),
        _deleted: false,
      };

      items.push(assessment);

      // Reserve the paper number so it remains consistent with the
      // assessment repository's uniqueness convention.
      items.push({
        PK: pk(SCHOOL),
        SK: sk.paperSlot(
          checkpoint.term_id,
          TEST_CLASS.classId,
          subject,
          checkpoint.assessment_type,
          1
        ),
        entity: 'PaperSlot',
        school_id: SCHOOL,
        class_id: TEST_CLASS.classId,
        term_id: checkpoint.term_id,
        subject,
        assessment_type: checkpoint.assessment_type,
        paper_no: 1,
        assessment_id: assessmentId,
      });

      assessmentCount++;

      TEST_STUDENTS.forEach((_, studentIndex) => {
        const studentId = `stu_${19001 + studentIndex}`;

        // The pattern varies by checkpoint and subject but stays deterministic.
        const variation =
          ((subjectIndex * 7 + checkpointIndex * 5 + studentIndex * 3) % 17) - 8;
        const rawScore = Math.max(
          0,
          Math.min(100, studentBase[studentIndex] + variation)
        );
        const normalizedScore = Math.round(rawScore * 100) / 100;
        const timestamp = Date.now();

        items.push({
          PK: pk(SCHOOL),
          SK: sk.score(assessmentId, studentId),
          GSI2PK: gsi2.pk(SCHOOL, studentId),
          GSI2SK: gsi2.score(checkpoint.term_id, assessmentId),
          GSI3PK: gsi3.pk(SCHOOL, TEST_CLASS.classId),
          GSI3SK: gsi3.sk(timestamp),
          entity: 'Score',
          score_id: `${assessmentId}#${studentId}`,
          school_id: SCHOOL,
          assessment_id: assessmentId,
          student_id: studentId,
          class_id: TEST_CLASS.classId,
          term_id: checkpoint.term_id,
          raw_score: rawScore,
          normalized_score: normalizedScore,
          mark_status: 'SCORED',
          status: 'ACTIVE',
          entered_by: enteredBy,
          entered_at: now,
          updated_at: now,
          _version: 1,
          _lastChangedAt: timestamp,
          _deleted: false,
        });

        scoreCount++;
      });
    });
  });

  return { assessmentCount, scoreCount };
}

/** Create or find a seeded teacher account. */
async function account(teacher) {
  if (!process.env.COGNITO_USER_POOL_ID) {
    throw new Error(
      'COGNITO_USER_POOL_ID is not set. Run `npm run aws:setup` first.'
    );
  }

  const acct = await identity.createAccount({
    email: teacher.email,
    name: `${teacher.first_name} ${teacher.last_name}`,
    schoolId: SCHOOL,
  });

  await identity.setRole(acct.sub, teacher.role);
  await identity.setPermanentPassword(acct.sub, DEV_PASSWORD);

  return acct.sub;
}

async function batchWriteAll(allItems) {
  for (let i = 0; i < allItems.length; i += 25) {
    let pending = allItems.slice(i, i + 25).map((Item) => ({
      PutRequest: { Item },
    }));

    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) {
        throw new Error('DynamoDB kept throttling the seed records.');
      }

      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 50 * 2 ** attempt)
        );
      }

      const result = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [TABLE]: pending },
        })
      );

      pending = result.UnprocessedItems?.[TABLE] || [];
    }
  }
}

async function run() {
  await ensureTable({ reset: process.argv.includes('--reset') });

  const subs = {};
  for (const teacher of TEACHERS) {
    subs[teacher.key] = await account(teacher);
  }

  for (const teacher of TEACHERS) {
    const { key, ...profile } = teacher;

    items.push({
      PK: pk(SCHOOL),
      SK: sk.teacher(subs[key]),
      entity: 'Teacher',
      teacher_id: subs[key],
      school_id: SCHOOL,
      status: 'ACTIVE',
      _version: 1,
      ...profile,
    });

    if (teacher.class_teacher_of) {
      const klass = items.find(
        (item) =>
          item.entity === 'Class' &&
          item.class_id === teacher.class_teacher_of
      );

      if (klass) klass.class_teacher_id = subs[key];
    }
  }

  const seeded = seedTestAssessmentsAndScores(subs.john);

  await batchWriteAll(items);

  console.log(`Seeded ${items.length} items into ${TABLE}`);
  console.log(`  school        ${SCHOOL}`);
  console.log(`  default term  ${TERM}`);
  console.log(`  classes       ${classes.length + 1}`);
  console.log(`  students      ${students.length}`);
  console.log(`  test class    ${TEST_CLASS.name} (${TEST_CLASS.classId})`);
  console.log(`  assessments   ${seeded.assessmentCount}`);
  console.log(`  score records ${seeded.scoreCount}`);
  console.log('  attendance    0 seeded');
  console.log('  publications  0 seeded');

  console.log(`\nSign-in accounts (password ${DEV_PASSWORD}):`);
  for (const teacher of TEACHERS) {
    const classTeacher = teacher.class_teacher_of
      ? `, class teacher of ${teacher.class_teacher_of}`
      : '';
    const teaches =
      [...new Set(teacher.assignments.map((a) => a.subject))].join(', ') ||
      'all classes';

    console.log(
      `  ${teacher.role.padEnd(8)} ${teacher.email.padEnd(36)} ${teaches}${classTeacher}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { SCHOOL, TERM, janeClasses, classes, students };
