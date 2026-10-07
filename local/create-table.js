import 'dotenv/config';
import { TABLE_DEFINITION } from '../infra/table-definition.js';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { pathToFileURL } from 'node:url';

/**
 * Creates csg_platform_data locally from infra/table-definition.js — the same
 * object the CDK data_stack builds the deployed table from, so the local and
 * AWS tables cannot drift apart.
 */
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
  endpoint: process.env.DDB_ENDPOINT || 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

export async function ensureTable({ reset = false } = {}) {
  if (reset) {
    try {
      await client.send(new DeleteTableCommand({ TableName: TABLE_DEFINITION.TableName }));
    } catch (e) {
      if (e.name !== 'ResourceNotFoundException') throw e;
    }
  }
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_DEFINITION.TableName }));
    return 'exists';
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
  await client.send(new CreateTableCommand(TABLE_DEFINITION));
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reset = process.argv.includes('--reset');
  ensureTable({ reset }).then((r) => console.log(`Table ${TABLE_DEFINITION.TableName}: ${r}`));
}