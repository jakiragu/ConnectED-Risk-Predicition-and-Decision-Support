import 'dotenv/config';
import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE } from '../backend/library/keys.js';
import { readSchoolPlace } from '../backend/library/locations.js';
import { registration, registrationItems } from '../backend/library/platformStore.js';

/**
 * One-off, for a table that held schools before the Angaza console existed:
 * registers every school profile so the console lists it. Safe to run again
 * (a school already registered is skipped). A school whose stored place does
 * not pass the console's rules is listed for someone to register by hand.
 *
 *   npm run angaza:backfill
 */
const profiles = [];
let ExclusiveStartKey;
do {
  const res = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'SK = :p',
    ExpressionAttributeValues: { ':p': 'SCHOOL#PROFILE' },
    ExclusiveStartKey,
  }));
  profiles.push(...(res.Items || []));
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

let added = 0;
for (const p of profiles) {
  if (await registration(p.school_id)) continue;
  const { value, problem } = readSchoolPlace(p);
  if (problem) {
    console.log(`SKIP  ${p.school_id} (${p.name || 'no name'}): ${problem.message}`);
    continue;
  }
  const { registration: reg, claim } = registrationItems(p.school_id, value, { byName: 'Backfill', status: p.status || 'ACTIVE' });
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: reg, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: TABLE, Item: claim, ConditionExpression: 'attribute_not_exists(PK)' } },
    ],
  }));
  added++;
  console.log(`OK    ${p.school_id} ${value.name}`);
}
console.log(`${added} school${added === 1 ? '' : 's'} registered, ${profiles.length - added} already registered or skipped.`);
