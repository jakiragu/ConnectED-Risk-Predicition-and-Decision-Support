import { createPublicKey, verify } from 'node:crypto';

const region = () => process.env.AWS_REGION || 'eu-west-1';
const endpoint = () => (process.env.COGNITO_ENDPOINT || `https://cognito-idp.${region()}.amazonaws.com`).replace(/\/$/, '');
const issuer = () => `${endpoint()}/${process.env.COGNITO_USER_POOL_ID}`;

function issuerMatches(actual) {
  const expected = issuer();
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

let keys = null;
let fetchedAt = 0;

async function signingKey(kid) {
  if (!keys || !keys.has(kid) || Date.now() - fetchedAt > 10 * 60 * 1000) {
    const res = await fetch(`${issuer()}/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`Could not load the user pool's signing keys (${res.status})`);
    const { keys: jwks } = await res.json();
    keys = new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
    fetchedAt = Date.now();
  }
  return keys.get(kid) || null;
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
  const key = await signingKey(header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
  if (!issuerMatches(claims.iss)) return null;
  if (claims.token_use !== 'id') return null;
  if (claims.aud !== process.env.COGNITO_CLIENT_ID) return null;
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