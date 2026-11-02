import 'dotenv/config';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '../../backend/library/client.js';

/**
 * The integration tests talk to the running system the way the dashboard does:
 * a real sign-in against the identity service, then GraphQL over HTTP. Nothing
 * is stubbed, so a test failure means the system failed, not the harness.
 *
 * Needs the local stand-ins and the API: npm run setup && npm run api.
 * The seeded accounts are:
 *   jane.doe      teacher, class teacher of cls_test, teaches Kiswahili there
 *   peter.otieno  teacher, teaches English and Mathematics in cls_test, no class
 *   zama.nile     teacher, class teacher of cls_f4south, teaches CRE in cls_test
 *   john.man      administrator
 */
export const SCHOOL = 'sch_saint_innocent';
export const CLASS = 'cls_test';
export const API = process.env.TEST_API || 'http://localhost:4000/graphql';
export const PASSWORD = process.env.SEED_PASSWORD || 'Gradebook-Dev-2026!';
export const ACTORS = { jane: 'jane.doe', peter: 'peter.otieno', zama: 'zama.nile', john: 'john.man' };

const tokens = new Map();

export async function signIn(who) {
  if (tokens.has(who)) return tokens.get(who);
  const res = await cognito.send(new InitiateAuthCommand({
    ClientId: process.env.COGNITO_CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: `${ACTORS[who] ?? who}@saintinnocent.ac.ke`, PASSWORD },
  }));
  const token = res.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`could not sign in as ${who}`);
  tokens.set(who, token);
  return token;
}

/** One GraphQL call as `who` ('anonymous' sends no token). Throws with errorType on a refusal. */
export async function as(who, query, variables = {}) {
  const headers = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers.authorization = `Bearer ${await signIn(who)}`;
  let res;
  try {
    res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  } catch (e) {
    throw new Error(`the API at ${API} could not be reached (${e.message}). Start it with: npm run api`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    const first = body.errors[0];
    const err = new Error(first.message);
    err.errorType = first.extensions?.errorType ?? 'Unknown';
    err.graphQLErrors = body.errors;
    throw err;
  }
  return body.data;
}

/** Milliseconds for one call, for the response-time measurements. */
export async function timed(who, query, variables = {}) {
  const started = process.hrtime.bigint();
  const data = await as(who, query, variables);
  return { data, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

export const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** The environment line recorded with the evidence. */
export async function environment() {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  return {
    node: process.version,
    project: `${pkg.name}@${pkg.version}`,
    api: API,
    table: process.env.TABLE_NAME,
    ddb_endpoint: process.env.DDB_ENDPOINT,
    run_at: new Date().toISOString(),
  };
}

/** True if a GraphQL operation's text selects a field. Used so a case only asserts on fields the interface really requests. */
export const selects = (query, name) => new RegExp(`\\b${name}\\b`).test(query);

/** First value in a response (depth first) whose key matches the pattern, or undefined. */
export function findKey(value, pattern) {
  if (value === null || typeof value !== 'object') return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (pattern.test(k) && (typeof v !== 'object' || v === null)) return { key: k, value: v };
    const inner = findKey(v, pattern);
    if (inner) return inner;
  }
  return undefined;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls fn until it returns something truthy, or the timeout passes (then null). */
export async function waitFor(fn, { timeout = 60000, every = 2000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
