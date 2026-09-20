import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Local stand-in for an Amazon Cognito user pool.
 *
 * The only thing the backend cares about is the shape of `event.identity`, so
 * that is the only thing reproduced here: `sub`, `cognito:groups`, and the
 * custom `school_id` claim that carries the tenant. Tokens are HS256 signed
 * with a development secret.
 *
 * On AWS this file is deleted. AppSync's Cognito authorizer builds the same
 * identity object from a real RS256 token, and authz.js is untouched.
 */
const SECRET = process.env.LOCAL_JWT_SECRET || 'csg-local-development-secret';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const sign = (data) => b64url(createHmac('sha256', SECRET).update(data).digest());

export function issueToken({ sub, email, name, groups, schoolId, ttlSeconds = 12 * 3600 }) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'local' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub,
      email,
      name,
      'cognito:groups': groups,
      'custom:school_id': schoolId,
      token_use: 'id',
      iss: 'http://localhost:4000/local-user-pool',
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export async function verifyToken(token) {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = sign(`${header}.${payload}`);
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }
  const claims = JSON.parse(unb64url(payload).toString('utf8'));
  if (claims.exp * 1000 < Date.now()) return null;

  // Exactly the object AppSync passes to a Lambda resolver.
  return {
    sub: claims.sub,
    username: claims.email,
    claims,
    groups: claims['cognito:groups'] || [],
    sourceIp: ['127.0.0.1'],
    defaultAuthStrategy: 'ALLOW',
  };
}