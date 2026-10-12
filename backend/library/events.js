import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { eventBridge } from './client.js';

export async function emit(event) {
  const res = await eventBridge.send(
    new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME,
        Source: event.source,
        DetailType: event.detail_type,
        Detail: JSON.stringify(event.detail),
      }],
    })
  );
  if (res.FailedEntryCount) {
    throw new Error(`The event bus rejected ${event.detail_type}: ${res.Entries?.[0]?.ErrorMessage || 'unknown error'}`);
  }
  return res.Entries?.[0]?.EventId ?? null;
}