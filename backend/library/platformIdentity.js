import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from './client.js';
import { temporaryPassword } from './identity.js';

/**
 * Sign-in accounts for Angaza staff, in their own pool. Kept apart from
 * identity.js (the school pool) so that no code path can create an Angaza
 * account with a school claim, or a school account in the Angaza pool.
 * Used by scripts (local/add-angaza-staff.js, the seed); the console itself
 * never creates Angaza accounts.
 */
export const PLATFORM_GROUP = 'PlatformAdmin';

const pool = () => {
  const id = process.env.PLATFORM_COGNITO_USER_POOL_ID;
  if (!id) throw new Error('PLATFORM_COGNITO_USER_POOL_ID is not set. Run `npm run aws:setup` first.');
  return id;
};
const attr = (user, name) => (user.Attributes || user.UserAttributes || []).find((a) => a.Name === name)?.Value ?? null;

/** Creates the account, or finds the one that already exists for this email. */
export async function createStaffAccount({ email, name }) {
  const password = temporaryPassword();
  let sub;
  let created = true;
  try {
    const res = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: pool(),
      Username: email,
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }));
    sub = attr(res.User, 'sub');
  } catch (e) {
    if (e.name !== 'UsernameExistsException') throw e;
    sub = attr(await cognito.send(new AdminGetUserCommand({ UserPoolId: pool(), Username: email })), 'sub');
    created = false;
  }
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: sub, GroupName: PLATFORM_GROUP }));
  return { sub, created, temporaryPassword: created ? password : null };
}

/** Local seeding only: a known, permanent password. */
export const setPermanentPassword = (username, password) =>
  cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: username, Password: password, Permanent: true }));
