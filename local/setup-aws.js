import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  CreateStateMachineCommand,
  ListStateMachinesCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import {
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito, s3, sfn } from '../backend/library/client.js';
import { ROLES } from '../backend/library/authz.js';

const region = process.env.AWS_REGION || 'eu-west-1';
const ACCOUNT = '123456789012'; // Step Functions Local's fixed account id
const MACHINE = process.env.REPORT_STATE_MACHINE_NAME || 'gradebook-report-cards';
const POOL = process.env.COGNITO_USER_POOL_NAME || 'gradebook';
const CLIENT = 'gradebook-web';

function setEnv(values) {
  const file = new URL('../.env', import.meta.url);
  if (!existsSync(file)) return [];
  let text = readFileSync(file, 'utf8');
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      if (!text.match(re)[0].endsWith(`=${value}`)) changed.push(key);
      text = text.replace(re, line);
    } else {
      text += `\n${line}`;
      changed.push(key);
    }
    process.env[key] = value;
  }
  writeFileSync(file, text);
  return changed;
}

async function ensureUserPool() {
  const { UserPools = [] } = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  let poolId = UserPools.find((p) => p.Name === POOL)?.Id;
  if (!poolId) {
    const res = await cognito.send(new CreateUserPoolCommand({
      PoolName: POOL,
      UsernameAttributes: ['email'],
      Schema: [{ Name: 'school_id', AttributeDataType: 'String', Mutable: false }],
    }));
    poolId = res.UserPool.Id;
  }
  const { UserPoolClients = [] } = await cognito.send(new ListUserPoolClientsCommand({ UserPoolId: poolId, MaxResults: 60 }));
  let clientId = UserPoolClients.find((c) => c.ClientName === CLIENT)?.ClientId;
  if (!clientId) {
    const res = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: CLIENT,
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    }));
    clientId = res.UserPoolClient.ClientId;
  }
  for (const GroupName of ROLES) {
    try {
      await cognito.send(new CreateGroupCommand({ UserPoolId: poolId, GroupName }));
    } catch (e) {
      if (e.name !== 'GroupExistsException') throw e;
    }
  }
  const changed = setEnv({ COGNITO_USER_POOL_ID: poolId, COGNITO_CLIENT_ID: clientId, VITE_COGNITO_CLIENT_ID: clientId });
  return `${poolId}, client ${clientId}, groups ${ROLES.join('/')}${changed.length ? ` (wrote ${changed.join(', ')} to .env)` : ''}`;
}

async function ensureBucket() {
  const Bucket = process.env.REPORT_BUCKET;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    return `${Bucket} exists`;
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
    return `${Bucket} created`;
  }
}

async function ensureStateMachine() {
  const definition = readFileSync(new URL('../infra/report-card-state-machine.asl.json', import.meta.url), 'utf8')
    .replaceAll('${ReportCardWorkerArn}', `arn:aws:lambda:${region}:${ACCOUNT}:function:report-card-worker`);
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/report-card-state-machine`;
  const { stateMachines } = await sfn.send(new ListStateMachinesCommand({}));
  const found = stateMachines.find((m) => m.name === MACHINE);
  let arn;
  if (found) {
    await sfn.send(new UpdateStateMachineCommand({ stateMachineArn: found.stateMachineArn, definition, roleArn }));
    arn = found.stateMachineArn;
  } else {
    arn = (await sfn.send(new CreateStateMachineCommand({ name: MACHINE, definition, roleArn }))).stateMachineArn;
  }
  const changed = setEnv({ REPORT_STATE_MACHINE_ARN: arn });
  return `${MACHINE} ${found ? 'updated' : 'created'}${changed.length ? ' (wrote REPORT_STATE_MACHINE_ARN to .env)' : ''}`;
}

let failed = 0;
for (const [label, step] of [['Cognito user pool', ensureUserPool], ['Report bucket', ensureBucket], ['State machine', ensureStateMachine]]) {
  try {
    console.log(`OK    ${label}: ${await step()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}: ${e.message}`);
  }
}
if (failed) {
  console.log('\nStart the missing stand-ins with `npm run db:infra` and run this again.');
  process.exitCode = 1;
}