import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  CreateStateMachineCommand,
  ListStateMachinesCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import { s3, sfn } from '../backend/library/client.js';

const region = process.env.AWS_REGION || 'eu-west-1';
const ACCOUNT = '123456789012'; // Step Functions Local's fixed account id
const NAME = process.env.REPORT_STATE_MACHINE_NAME || 'gradebook-report-cards';

async function ensureBucket() {
  const Bucket = process.env.REPORT_BUCKET;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    return 'exists';
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
    return 'created';
  }
}

async function ensureStateMachine() {
  const definition = readFileSync(new URL('../infra/report-card-state-machine.asl.json', import.meta.url), 'utf8')
    .replaceAll('${ReportCardWorkerArn}', `arn:aws:lambda:${region}:${ACCOUNT}:function:report-card-worker`);
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/report-card-state-machine`;
  const { stateMachines } = await sfn.send(new ListStateMachinesCommand({}));
  const found = stateMachines.find((m) => m.name === NAME);
  if (found) {
    await sfn.send(new UpdateStateMachineCommand({ stateMachineArn: found.stateMachineArn, definition, roleArn }));
    return { arn: found.stateMachineArn, action: 'updated' };
  }
  const res = await sfn.send(new CreateStateMachineCommand({ name: NAME, definition, roleArn }));
  return { arn: res.stateMachineArn, action: 'created' };
}

const bucket = await ensureBucket();
console.log(`Bucket ${process.env.REPORT_BUCKET}: ${bucket}`);
const machine = await ensureStateMachine();
console.log(`State machine ${NAME}: ${machine.action}\n  ${machine.arn}`);
if (machine.arn !== process.env.REPORT_STATE_MACHINE_ARN) {
  console.log(`\nSet REPORT_STATE_MACHINE_ARN=${machine.arn} in .env`);
  process.exitCode = 1;
}