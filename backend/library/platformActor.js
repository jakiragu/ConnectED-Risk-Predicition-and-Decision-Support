import { unauthorized } from './errors.js';
import { isPlatformIdentity } from './platformAuth.js';
import * as store from './platformStore.js';

/**
 * The Angaza staff member making the request, or a refusal. The counterpart of
 * actor.js for the Angaza console: the token proves who signed in, the STAFF
 * record decides whether they may use the console today.
 */
export async function resolvePlatformActor(event) {
  const id = event?.identity;
  if (!id?.sub) throw unauthorized('No authenticated identity on request');
  if (!isPlatformIdentity(event)) {
    throw unauthorized('The Angaza console needs an Angaza account. School accounts sign in to their school instead.');
  }
  const staff = await store.staff(id.sub);
  if (!staff) throw unauthorized('This Angaza account is not registered for the console');
  if (staff.status !== 'ACTIVE') throw unauthorized('This Angaza account has been deactivated');
  const claims = id.claims || {};
  return {
    sub: id.sub,
    email: claims.email || staff.email,
    name: [staff.first_name, staff.last_name].filter(Boolean).join(' ') || claims.name || claims.email,
  };
}
