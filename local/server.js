import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSchema, createYoga } from 'graphql-yoga';
import { issueToken, verifyToken } from './token.js';
import { RESOLVERS } from './resolvers.js';
import { startLambdaEndpoint } from './lambda-endpoint.js';
import { startEventBridgeEndpoint } from './eventbridge-endpoint.js';

const here = dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(join(here, '../graphql/schema/gradebook.graphql'), 'utf8');

function toAppSyncEvent(parentTypeName, fieldName, args, identity) {
  return {
    arguments: args,
    identity,
    info: { fieldName, parentTypeName, selectionSetList: [] },
    request: { headers: {} },
    source: null,
  };
}

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'appsync-local', ...o }));

const wrap = (parentTypeName, fieldName, service) => async (_root, args, ctx) => {
  const start = Date.now();
  try {
    const result = await service(toAppSyncEvent(parentTypeName, fieldName, args, ctx.identity));
    log({ field: fieldName, ms: Date.now() - start, ok: true, sub: ctx.identity?.sub });
    return result;
  } catch (e) {
    log({ field: fieldName, ms: Date.now() - start, ok: false, type: e.type, msg: e.message });
    // AppSync surfaces errorType; graphql-yoga surfaces extensions.
    const err = new Error(e.message);
    err.extensions = { errorType: e.type || 'InternalError', field: e.field };
    throw err;
  }
};

const resolvers = { Query: {}, Mutation: {} };
for (const [parent, fields] of Object.entries(RESOLVERS)) {
  for (const [field, service] of Object.entries(fields)) {
    resolvers[parent][field] = wrap(parent, field, service);
  }
}

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: '/graphql',
  cors: { origin: '*', credentials: true },
  maskedErrors: false,
  context: async ({ request }) => {
    const auth = request.headers.get('authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    return { identity: token ? await verifyToken(token) : null };
  },
});

async function devToken(req, res) {
  if (!process.env.DDB_ENDPOINT) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { email } = JSON.parse(body || '{}');
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const { ddb } = await import('../backend/library/client.js');
  const { TABLE, pk } = await import('../backend/library/keys.js');
  const schoolId = process.env.SEED_SCHOOL_ID || 'sch_saint_innocent';
  const found = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': 'TEACHER#', ':e': email },
    })
  );
  const teacher = found.Items?.[0];
  if (!teacher) {
    res
      .writeHead(401, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      .end('{"error":"unknown user"}');
    return;
  }
  const token = issueToken({
    sub: teacher.teacher_id,
    email: teacher.email,
    name: `${teacher.first_name} ${teacher.last_name}`,
    groups: teacher.groups,
    schoolId,
  });
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ token }));
}

const port = Number(process.env.PORT || 4000);
createServer(async (req, res) => {
  if (req.url === '/dev/token') {
    if (req.method === 'OPTIONS') {
      res
        .writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
        })
        .end();
      return;
    }
    return devToken(req, res);
  }
  return yoga(req, res);
}).listen(port, () => {
  console.log(`AppSync (local) on http://localhost:${port}/graphql`);
});

startLambdaEndpoint(Number(process.env.LOCAL_LAMBDA_PORT || 4011));
startEventBridgeEndpoint(Number(process.env.LOCAL_EVENTS_PORT || 4010));