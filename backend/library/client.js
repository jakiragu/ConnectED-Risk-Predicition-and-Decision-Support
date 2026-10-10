import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';

const local = Boolean(process.env.DDB_ENDPOINT);

const base = {
  region: process.env.AWS_REGION || 'eu-west-1',
  ...(local
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
        },
      }
    : {}),
};

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    ...base,
    ...(process.env.DDB_ENDPOINT ? { endpoint: process.env.DDB_ENDPOINT } : {}),
  }),
  { marshallOptions: { removeUndefinedValues: true } }
);

export const s3 = new S3Client({
  ...base,
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
    : {}),
});

export const eventBridge = new EventBridgeClient({
  ...base,
  ...(process.env.EVENTS_ENDPOINT ? { endpoint: process.env.EVENTS_ENDPOINT } : {}),
});

export const sfn = new SFNClient({
  ...base,
  ...(process.env.SFN_ENDPOINT ? { endpoint: process.env.SFN_ENDPOINT } : {}),
});

export const isLocal = local;