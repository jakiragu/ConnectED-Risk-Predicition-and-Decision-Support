import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Local stand-in for EventBridge PutEvents. Every event is appended to
 * local/.data/events.jsonl and matched against the rules in
 * infra/event-rules.json (the same rules the deployment creates); a matching
 * Lambda target is invoked asynchronously through the Lambda Invoke API, with
 * the event envelope EventBridge delivers.
 */
const FILE = resolve(process.env.LOCAL_EVENTS_FILE || 'local/.data/events.jsonl');
const RULES = JSON.parse(readFileSync(new URL('../infra/event-rules.json', import.meta.url), 'utf8')).rules;
const LAMBDA = `http://localhost:${process.env.LOCAL_LAMBDA_PORT || 4011}`;

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'eventbridge-local', ...o }));

/** EventBridge pattern matching for the forms used here: lists of allowed values, nested objects. */
function matches(pattern, value) {
  return Object.entries(pattern).every(([key, expected]) => {
    const actual = value?.[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    if (expected && typeof expected === 'object') return matches(expected, actual);
    return false;
  });
}

async function deliver(envelope) {
  for (const rule of RULES) {
    if (!matches(rule.event_pattern, envelope)) continue;
    for (const target of rule.targets) {
      if (target.type !== 'lambda') continue;
      try {
        await fetch(`${LAMBDA}/2015-03-31/functions/${encodeURIComponent(target.function)}/invocations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-amz-invocation-type': 'Event' },
          body: JSON.stringify(envelope),
        });
        log({ rule: rule.name, target: target.function, id: envelope.id });
      } catch (e) {
        log({ level: 'error', rule: rule.name, target: target.function, err: e.message });
      }
    }
  }
}

export function startEventBridgeEndpoint(port) {
  return createServer(async (req, res) => {
    const target = req.headers['x-amz-target'];
    if (req.method !== 'POST' || target !== 'AWSEvents.PutEvents') {
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' })
        .end(JSON.stringify({ __type: 'UnknownOperationException', message: `Unsupported operation ${target}` }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const { Entries = [] } = JSON.parse(body || '{}');
    await mkdir(dirname(FILE), { recursive: true });
    const accepted = [];
    const envelopes = [];
    for (const e of Entries) {
      const envelope = {
        version: '0',
        id: randomUUID(),
        'detail-type': e.DetailType,
        source: e.Source,
        account: '123456789012',
        time: new Date().toISOString(),
        region: process.env.AWS_REGION || 'eu-west-1',
        resources: e.Resources || [],
        detail: JSON.parse(e.Detail || '{}'),
      };
      accepted.push({ EventId: envelope.id });
      envelopes.push(envelope);
      await appendFile(FILE, `${JSON.stringify({ ...envelope, 'event-bus': e.EventBusName })}\n`);
      log({ bus: e.EventBusName, type: e.DetailType, id: envelope.id });
    }
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
      .end(JSON.stringify({ FailedEntryCount: 0, Entries: accepted }));
    for (const envelope of envelopes) deliver(envelope);
  }).listen(port, () => console.log(`EventBridge (local) on http://localhost:${port}`));
}