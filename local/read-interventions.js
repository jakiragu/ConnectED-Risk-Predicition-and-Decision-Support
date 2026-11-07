import 'dotenv/config';

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE } from '../backend/library/keys.js';

const USER_ID = '8adfea8b-48c3-44d8-9605-750d1b949148';
const EXPECTED_FACTOR = 'Kiswahili';

const result = await ddb.send(
  new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression:
      'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': 'SCHOOL#sch_saint_innocent',
      ':prefix': 'INTERVENTION#',
    },
  })
);

// Filter to interventions created by Jane Doe.
const interventions = (result.Items ?? []).filter(
  (item) => item.created_by === USER_ID
);

const total = interventions.length;

const nonKiswahili = interventions.filter(
  (item) => item.factor !== EXPECTED_FACTOR
);

const kiswahiliCount = total - nonKiswahili.length;

console.log('\nJane Doe — Intervention Factor Check');
console.log('------------------------------------');
console.log(`Total interventions created: ${total}`);
console.log(`Kiswahili interventions: ${kiswahiliCount}`);
console.log(`Other/missing factors: ${nonKiswahili.length}`);

if (total === 0) {
  console.log('\nNo interventions found for this user.');
} else if (nonKiswahili.length === 0) {
  console.log('\nPASS: All interventions are for Kiswahili.');
} else {
  console.log('\nFAIL: Some interventions are not for Kiswahili.');

  console.log('\nUnexpected factors:');
  console.table(
    nonKiswahili.map((item) => ({
      factor: item.factor ?? '(missing)',
      status: item.status,
    }))
  );
}