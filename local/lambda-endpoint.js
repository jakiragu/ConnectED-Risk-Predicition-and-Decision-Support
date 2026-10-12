import { createServer } from 'node:http';
import { handler as reportCardWorker } from '../backend/lambdas/report-card-worker/handler.js';

const FUNCTIONS = { 'report-card-worker': reportCardWorker };

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'lambda-local', ...o }));

const functionName = (raw) => {
  const name = decodeURIComponent(raw);
  const at = name.indexOf(':function:');
  return (at >= 0 ? name.slice(at + ':function:'.length) : name).split(':')[0];
};

export function startLambdaEndpoint(port) {
  return createServer(async (req, res) => {
    const match = req.url.match(/^\/2015-03-31\/functions\/([^/]+)\/invocations/);
    if (req.method !== 'POST' || !match) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not found"}');
      return;
    }
    const name = functionName(match[1]);
    const fn = FUNCTIONS[name];
    if (!fn) {
      res.writeHead(404, { 'content-type': 'application/json', 'x-amzn-errortype': 'ResourceNotFoundException' })
        .end(JSON.stringify({ Type: 'User', message: `Function not found: ${name}` }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const start = Date.now();
    try {
      const out = await fn(body ? JSON.parse(body) : {});
      log({ fn: name, action: JSON.parse(body || '{}').action, ms: Date.now() - start, ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'x-amz-executed-version': '$LATEST' })
        .end(JSON.stringify(out ?? null));
    } catch (e) {
      log({ fn: name, ms: Date.now() - start, ok: false, type: e.type || e.name, msg: e.message });
      res.writeHead(200, { 'content-type': 'application/json', 'x-amz-function-error': 'Unhandled' })
        .end(JSON.stringify({ errorType: e.type || e.name || 'Error', errorMessage: e.message }));
    }
  }).listen(port, () => console.log(`Lambda (local) on http://localhost:${port}`));
}