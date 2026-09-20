import 'dotenv/config';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk } from '../backend/library/keys.js';
import { BASE_KEYS, INDEXES } from '../infra/table-definition.js';
import { issueToken, verifyToken } from './token.js';


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

async function run() {
  // 1. The shelf was built the way we described it.
  const { Table } = await raw.send(new DescribeTableCommand({ TableName: TABLE }));
  check('table key columns are PK and SK',
    Table.KeySchema.map((k) => k.AttributeName), [BASE_KEYS.pk, BASE_KEYS.sk]);
  check('all three lookup routes exist',
    (Table.GlobalSecondaryIndexes || []).map((i) => i.IndexName).sort(),
    INDEXES.map((i) => i.name));
  check('change recording is on', Table.StreamSpecification?.StreamEnabled, true);

  // 2. Everything is in the school's drawer.
  const all = await ddb.send(new ScanCommand({ TableName: TABLE, Select: 'COUNT' }));
  check('total items', all.Count, 349);

  // 3. "All students at this school" - one lookup by folder prefix.
  const allStudents = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'STUDENT#' },
    Select: 'COUNT',
  }));
  check('students at the school', allStudents.Count, 335);

  // 4. "Who is in Form 4 South" - the roster the app will show.
  const roster = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    FilterExpression: 'class_id = :c AND #st = :a',
    ExpressionAttributeNames: { '#st': 'status' }, // status is a reserved word
    ExpressionAttributeValues: {
      ':p': pk(SCHOOL), ':s': 'STUDENT#', ':c': 'cls_f4south', ':a': 'ACTIVE',
    },
    Select: 'COUNT',
  }));
  check('Form 4 South roster', roster.Count, 42);

  // 5. "All classes" - same drawer, different prefix.
  const klasses = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'CLASS#' },
    Select: 'COUNT',
  }));
  check('classes', klasses.Count, 8);

  // 6. One exact item, straight to it, no searching.
  const one = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.student('stu_17355') },
  }));
  check('Riziki Juma found directly',
    [one.Item?.first_name, one.Item?.last_name, one.Item?.class_id],
    ['Riziki', 'Juma', 'cls_f4south']);

  // 7. Which classes may Jane open, and what is the grading scale.
  const janeItem = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.teacher('usr_jane_doe') },
  }));
  check('Jane is assigned 4 classes', janeItem.Item?.class_ids?.length, 4);
  check('Jane is a Teacher', janeItem.Item?.groups, ['Teacher']);

  const rule = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.gradeRule(TERM) },
  }));
  check('pass mark is 50', rule.Item?.pass_mark, 50);
  check('grading scale has 9 bands', rule.Item?.bands?.length, 9);

  // 8. GSI1 is empty, and that is correct: nothing seeded carries a GSI1PK.
  //    The first assessment created in Sprint 2 will make this 1.
  const gsi1 = await ddb.send(new ScanCommand({
    TableName: TABLE, IndexName: 'GSI1', Select: 'COUNT',
  }));
  check('GSI1 empty until assessments exist', gsi1.Count, 0);

  // 9. Badges work, and a tampered badge is rejected.
  const token = issueToken({
    sub: 'usr_jane_doe', email: 'jane.doe@saintinnocent.ac.ke',
    name: 'Jane Doe', groups: ['Teacher'], schoolId: SCHOOL,
  });
  const claims = await verifyToken(token);
  check('token carries role and school',
    [claims?.groups, claims?.claims?.['custom:school_id']], [['Teacher'], SCHOOL]);

  const [h, p, s] = token.split('.');
  const forgedClaims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  forgedClaims['cognito:groups'] = ['Admin'];
  const forgedPayload = Buffer.from(JSON.stringify(forgedClaims)).toString('base64url');
  check('self-promotion to Admin is rejected',
    await verifyToken(`${h}.${forgedPayload}.${s}`), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nVerification could not run.');
  console.error('Did you seed first? Try: npm run db:seed\n');
  console.error(err.message);
  process.exit(1);
});
