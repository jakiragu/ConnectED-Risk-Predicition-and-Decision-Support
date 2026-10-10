import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { sfn } from './client.js';

export async function startReportCards(name, input) {
  try {
    const res = await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.REPORT_STATE_MACHINE_ARN,
      name,
      input: JSON.stringify(input),
    }));
    return { executionArn: res.executionArn, alreadyStarted: false };
  } catch (e) {
    if (e.name !== 'ExecutionAlreadyExists') throw e;
    return { executionArn: null, alreadyStarted: true };
  }
}

export const executionName = (...parts) => parts.join('-').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);