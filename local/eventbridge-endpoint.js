import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = resolve(process.env.LOCAL_EVENTS_FILE || 'local/.data/events.jsonl');

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
    for (const e of Entries) {
      const id = randomUUID();
      accepted.push({ EventId: id });
      await appendFile(FILE, `${JSON.stringify({
        id, time: new Date().toISOString(), 'event-bus': e.EventBusName, source: e.Source,
        'detail-type': e.DetailType, detail: JSON.parse(e.Detail || '{}'),
      })}\n`);
      console.log(JSON.stringify({ level: 'info', svc: 'eventbridge-local', bus: e.EventBusName, type: e.DetailType, id }));
    }
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
      .end(JSON.stringify({ FailedEntryCount: 0, Entries: accepted }));
  }).listen(port, () => console.log(`EventBridge (local) on http://localhost:${port}`));
}