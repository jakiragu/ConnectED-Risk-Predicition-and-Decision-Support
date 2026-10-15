import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { handler as reportCardWorker } from '../backend/lambdas/report-card-worker/handler.js';
import { handler as riskPrediction } from '../backend/lambdas/risk-prediction/handler.js';

/**
 * Local stand-in for the Lambda Invoke API (POST /2015-03-31/functions/{name}/invocations),
 * used by the Lambda SDK client and by Step Functions Local. Node functions run
 * in this process; Python functions run in a warm child process each
 * (local/python-lambda.py). InvocationType Event is queued and retried twice on
 * failure, as Lambda does for asynchronous calls.
 */
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const python = (folder, entry) => ({ python: { folder: root(folder), entry } });

const FUNCTIONS = {
  'report-card-worker': reportCardWorker,
  'risk-prediction': riskPrediction,
  'risk-scorer': python('backend/lambdas/risk-scorer', 'handler.handler'),
};

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'lambda-local', ...o }));

const functionName = (raw) => {
  const name = decodeURIComponent(raw);
  const at = name.indexOf(':function:');
  return (at >= 0 ? name.slice(at + ':function:'.length) : name).split(':')[0];
};

/** One warm Python process per function, restarted if it dies. Requests are answered in order. */
class PythonWorker {
  constructor(name, { folder, entry }) {
    this.name = name;
    this.folder = folder;
    this.entry = entry;
    this.pending = new Map();
    this.next = 0;
    this.proc = null;
  }

  start() {
    const cmd = process.env.LOCAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    this.proc = spawn(cmd, [root('local/python-lambda.py'), this.folder, this.entry], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(Object.assign(new Error(msg.errorMessage), { name: msg.errorType }));
    });
    this.proc.stderr.on('data', (d) => process.stderr.write(`[${this.name}] ${d}`));
    const fail = (why) => {
      for (const w of this.pending.values()) w.reject(Object.assign(new Error(why), { name: 'Runtime.ExitError' }));
      this.pending.clear();
      this.proc = null;
    };
    this.proc.on('exit', (code) => fail(`${this.name} exited with code ${code}`));
    this.proc.on('error', (e) => fail(`Could not start ${cmd}: ${e.message}. Set LOCAL_PYTHON to your Python 3 executable.`));
  }

  invoke(event) {
    if (!this.proc) this.start();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, event })}\n`);
    });
  }
}

const workers = new Map();
function runner(name) {
  const fn = FUNCTIONS[name];
  if (!fn) return null;
  if (typeof fn === 'function') return fn;
  if (!workers.has(name)) workers.set(name, new PythonWorker(name, fn.python));
  const worker = workers.get(name);
  return (event) => worker.invoke(event);
}

async function runAsync(name, run, event) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const start = Date.now();
    try {
      await run(event);
      log({ fn: name, async: true, attempt, ms: Date.now() - start, ok: true });
      return;
    } catch (e) {
      log({ fn: name, async: true, attempt, ms: Date.now() - start, ok: false, type: e.type || e.name, msg: e.message });
    }
  }
}

export function startLambdaEndpoint(port) {
  return createServer(async (req, res) => {
    const match = req.url.match(/^\/2015-03-31\/functions\/([^/]+)\/invocations/);
    if (req.method !== 'POST' || !match) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not found"}');
      return;
    }
    const name = functionName(match[1]);
    const run = runner(name);
    if (!run) {
      res.writeHead(404, { 'content-type': 'application/json', 'x-amzn-errortype': 'ResourceNotFoundException' })
        .end(JSON.stringify({ Type: 'User', message: `Function not found: ${name}` }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const event = body ? JSON.parse(body) : {};

    if (req.headers['x-amz-invocation-type'] === 'Event') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('');
      runAsync(name, run, event);
      return;
    }
    const start = Date.now();
    try {
      const out = await run(event);
      log({ fn: name, action: event.action, ms: Date.now() - start, ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'x-amz-executed-version': '$LATEST' })
        .end(JSON.stringify(out ?? null));
    } catch (e) {
      log({ fn: name, ms: Date.now() - start, ok: false, type: e.type || e.name, msg: e.message });
      res.writeHead(200, { 'content-type': 'application/json', 'x-amz-function-error': 'Unhandled' })
        .end(JSON.stringify({ errorType: e.type || e.name || 'Error', errorMessage: e.message }));
    }
  }).listen(port, () => console.log(`Lambda (local) on http://localhost:${port}`));
}