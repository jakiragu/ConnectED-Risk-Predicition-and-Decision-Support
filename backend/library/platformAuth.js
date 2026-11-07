/**
 * Two sign-in pools reach one API: school staff (teachers and school
 * administrators) and Angaza staff. A token says which pool signed it in its
 * issuer, which ends with the pool's id. AppSync (and the local stand-in) has
 * already checked the signature, so the issuer can be trusted here.
 *
 * Telling the pools apart in code, rather than by schema directives, is
 * deliberate: AppSync's @aws_cognito_user_pools admits users of every
 * configured pool and cannot say "only this one".
 */
const platformPoolId = () => process.env.PLATFORM_COGNITO_USER_POOL_ID || '';

export function isPlatformIdentity(event) {
  const poolId = platformPoolId();
  const issuer = String(event?.identity?.issuer || event?.identity?.claims?.iss || '').replace(/\/+$/, '');
  return Boolean(poolId) && issuer.endsWith(`/${poolId}`);
}
