import 'dotenv/config';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ddb, cognito } from '../backend/library/client.js';
import { TABLE, pk, sk } from '../backend/library/keys.js';
import { BASE_KEYS, INDEXES } from '../infra/table-definition.js';
import { verifyIdToken } from './cognito-auth.js';
import { attendancePeriods } from '../backend/library/calendar.js';

const SCHOOL = 'sch_saint_innocent';
const TERM = 'term_2026_2';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

const raw = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
  endpoint: process.env.DDB_ENDPOINT || 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

const count = (prefix, extra = {}) => ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  ...extra,
  ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': prefix, ...(extra.ExpressionAttributeValues || {}) },
  Select: 'COUNT',
}));

async function run() {
  // 1. The table is built the way the deployment builds it.
  const { Table } = await raw.send(new DescribeTableCommand({ TableName: TABLE }));
  check('table key columns are PK and SK',
    Table.KeySchema.map((k) => k.AttributeName), [BASE_KEYS.pk, BASE_KEYS.sk]);
  check('all three lookup routes exist',
    (Table.GlobalSecondaryIndexes || []).map((i) => i.IndexName).sort(),
    INDEXES.map((i) => i.name));
  check('change recording is on', Table.StreamSpecification?.StreamEnabled, true);

  // 2. Everything the seed wrote is still there. Rows the app writes are excluded.
  const appWritten = [
    'Assessment', 'Score', 'ScoreAudit', 'TermLock', 'PaperSlot', 'ResultSet', 'TermResult', 'ReportCard',
    'ReportCardDownload', 'Attendance', 'StudentResult', 'RiskRun', 'RiskPrediction',
  ];
  const names = appWritten.map((_, i) => `:e${i}`);
  const all = await ddb.send(new ScanCommand({
    TableName: TABLE,
    Select: 'COUNT',
    FilterExpression: `NOT (#e IN (${names.join(', ')}))`,
    ExpressionAttributeNames: { '#e': 'entity' },
    ExpressionAttributeValues: Object.fromEntries(appWritten.map((v, i) => [`:e${i}`, v])),
  }));
  check('seeded items intact', all.Count, 700);

  // 3. Students, rosters and classes.
  check('students at the school', (await count('STUDENT#')).Count, 340);
  const roster = await count('STUDENT#', {
    FilterExpression: 'class_id = :c AND #st = :a',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':c': 'cls_f4south', ':a': 'ACTIVE' },
  });
  check('Form 4 South roster', roster.Count, 42);
  check('classes', (await count('CLASS#')).Count, 9);

  const one = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.student('stu_17355') } }));
  check('Riziki Juma found directly',
    [one.Item?.first_name, one.Item?.last_name, one.Item?.class_id], ['Riziki', 'Juma', 'cls_f4south']);

  // 4. Teachers, assignments and class teachers.
  const teachers = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'TEACHER#' },
  }));
  const jane = teachers.Items.find((t) => t.email === 'jane.doe@saintinnocent.ac.ke');
  check('four teachers, one administrator',
    [teachers.Count, teachers.Items.filter((t) => t.role === 'Admin').length], [4, 1]);
  check('Jane teaches Kiswahili in 5 classes',
    [jane?.assignments?.length, [...new Set(jane?.assignments?.map((a) => a.subject))]], [5, ['Kiswahili']]);
  check('Jane is a Teacher and class teacher of the test class', [jane?.role, jane?.class_teacher_of], ['Teacher', 'cls_test']);
  const testClass = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.klass('cls_test') } }));
  check('the test class points back at Jane', testClass.Item?.class_teacher_id, jane?.teacher_id);
  const claim = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.admissionNo('17355') } }));
  check('admission number 17355 is claimed by Riziki', claim.Item?.student_id, 'stu_17355');

  // 5. Terms and grading rules.
  const rule = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.gradeRule(TERM) } }));
  check('pass mark is 50', rule.Item?.pass_mark, 50);
  check('grading scale has 9 bands', rule.Item?.bands?.length, 9);
  const terms = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'TERM#' },
  }));
  check('terms 1-3 seeded, all in academic year 2026',
    [terms.Count, [...new Set(terms.Items.map((t) => t.academic_year))]], [3, [2026]]);
  check('every term has a Mid-term date and a term number',
    terms.Items.every((t) => t.mid_term_date && t.term_number), true);
  const t1 = terms.Items.find((t) => t.term_id === 'term_2026_1');
  check('Term 1 school days: 35 to Mid-term, 27 after', attendancePeriods(t1).map((p) => p.school_days), [35, 27]);

  // 6. GSI1 is the class+term index, and only assessments belong in it.
  const gsi1 = await ddb.send(new ScanCommand({
    TableName: TABLE, IndexName: 'GSI1', Select: 'COUNT',
    FilterExpression: '#e <> :a',
    ExpressionAttributeNames: { '#e': 'entity' },
    ExpressionAttributeValues: { ':a': 'Assessment' },
  }));
  check('GSI1 holds only assessments', gsi1.Count, 0);

  // 7. Signing in through the user pool gives a token the API accepts; a tampered one is rejected.
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: process.env.COGNITO_CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: 'jane.doe@saintinnocent.ac.ke', PASSWORD: process.env.SEED_PASSWORD || 'Gradebook-Dev-2026!' },
  }));
  const token = auth.AuthenticationResult?.IdToken;
  const identity = token ? await verifyIdToken(token) : null;
  check('sign-in token carries role, school and the teacher id',
    [identity?.groups, identity?.claims?.['custom:school_id'], identity?.sub], [['Teacher'], SCHOOL, jane?.teacher_id]);
  const [h, p, sig] = token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  forged['cognito:groups'] = ['Admin'];
  check('self-promotion to Admin is rejected',
    await verifyIdToken(`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nVerification could not run.');
  console.error('Did you set up and seed first? Try: npm run aws:setup && npm run db:seed\n');
  console.error(err.message);
  process.exit(1);
});