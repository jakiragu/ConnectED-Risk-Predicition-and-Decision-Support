import { createPublicKey, verify } from 'node:crypto';

/*
 * Stands in for AppSync's Cognito authorisation. AppSync is configured with two
 * user pools: school staff (the default mode) and Angaza staff (an additional
 * mode). It accepts a token signed by either and hands the Lambda the same
 * `identity` shape for both; the services tell them apart by `issuer`.
 * This file does exactly that and nothing more, so no service relies on
 * behaviour that exists only locally.
 */

const region = () => process.env.AWS_REGION || 'eu-west-1';
const endpoint = () => (process.env.COGNITO_ENDPOINT || `https://cognito-idp.${region()}.amazonaws.com`).replace(/\/$/, '');

/** The pools AppSync would accept, with the app client each one's tokens must be issued to. */
const pools = () => [
  { poolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID },
  { poolId: process.env.PLATFORM_COGNITO_USER_POOL_ID, clientId: process.env.PLATFORM_COGNITO_CLIENT_ID },
].filter((p) => p.poolId && p.clientId).map((p) => ({ ...p, issuer: `${endpoint()}/${p.poolId}` }));

function issuerMatches(actual, expected) {
  if (actual === expected) return true;
  if (!process.env.COGNITO_ENDPOINT) return false;
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
    return localHosts.has(actualUrl.hostname) && localHosts.has(expectedUrl.hostname) &&
      actualUrl.protocol === expectedUrl.protocol && actualUrl.port === expectedUrl.port &&
      actualUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

// Signing keys per pool, refreshed every ten minutes or when an unknown key id appears.
const keyCache = new Map();

async function signingKey(pool, kid) {
  let entry = keyCache.get(pool.poolId);
  if (!entry || !entry.keys.has(kid) || Date.now() - entry.fetchedAt > 10 * 60 * 1000) {
    const res = await fetch(`${pool.issuer}/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`Could not load the user pool's signing keys (${res.status})`);
    const { keys: jwks } = await res.json();
    entry = { keys: new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])), fetchedAt: Date.now() };
    keyCache.set(pool.poolId, entry);
  }
  return entry.keys.get(kid) || null;
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** @returns the AppSync `identity` object, or null for any token AppSync would reject. */
export async function verifyIdToken(token) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  let header;
  let claims;
  try {
    header = decode(h);
    claims = decode(p);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  // The issuer names the pool; only a configured pool's keys and client are accepted.
  const pool = pools().find((candidate) => issuerMatches(claims.iss, candidate.issuer));
  if (!pool) return null;
  const key = await signingKey(pool, header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
  if (claims.token_use !== 'id') return null;
  if (claims.aud !== pool.clientId) return null;
  if (!(claims.exp * 1000 > Date.now())) return null;

  return {
    sub: claims.sub,
    username: claims['cognito:username'],
    claims,
    groups: claims['cognito:groups'] || [],
    issuer: claims.iss,
    sourceIp: ['127.0.0.1'],
    defaultAuthStrategy: 'ALLOW',
  };
}
