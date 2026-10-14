import { InvokeCommand } from '@aws-sdk/client-lambda';
import { lambda } from './client.js';

/**
 * Calls another Lambda through the Lambda API (the local stand-in implements
 * the same API). `wait: false` queues the call (InvocationType Event) the way
 * an EventBridge rule does.
 */
export async function invoke(functionName, payload, { wait = true } = {}) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: wait ? 'RequestResponse' : 'Event',
    Payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  if (!wait) return null;
  const text = res.Payload ? new TextDecoder().decode(res.Payload) : 'null';
  const body = text ? JSON.parse(text) : null;
  if (res.FunctionError) {
    const err = new Error(body?.errorMessage || `${functionName} failed`);
    err.name = body?.errorType || 'FunctionError';
    throw err;
  }
  return body;
}

export const scorerFunction = () => process.env.RISK_SCORER_FUNCTION || 'risk-scorer';
export const predictionFunction = () => process.env.RISK_PREDICTION_FUNCTION || 'risk-prediction';