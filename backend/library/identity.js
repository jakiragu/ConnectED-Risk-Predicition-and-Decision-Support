import { randomInt } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from './client.js';
import { ROLES } from './authz.js';

const pool = () => process.env.COGNITO_USER_POOL_ID;

const attr = (user, name) => (user.Attributes || user.UserAttributes || []).find((a) => a.Name === name)?.Value ?? null;

export function temporaryPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#$%&*+-=?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 12) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Creates the account, or finds the one an earlier, interrupted attempt created.
 * @returns {{sub:string, schoolId:string|null, created:boolean, temporaryPassword:string|null}}
 */
export async function createAccount({ email, name, schoolId }) {
  const password = temporaryPassword();
  try {
    const res = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: pool(),
      Username: email,
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS', // the administrator hands the temporary password over
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
        { Name: 'custom:school_id', Value: schoolId },
      ],
    }));
    return { sub: attr(res.User, 'sub'), schoolId, created: true, temporaryPassword: password };
  } catch (e) {
    if (e.name !== 'UsernameExistsException') throw e;
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: pool(), Username: email }));
    return { sub: attr(user, 'sub'), schoolId: attr(user, 'custom:school_id'), created: false, temporaryPassword: null };
  }
}

/** Puts the account in exactly the group for its role. Idempotent. */
export async function setRole(username, role) {
  const { Groups = [] } = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: pool(), Username: username }));
  for (const g of Groups) {
    if (ROLES.includes(g.GroupName) && g.GroupName !== role) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool(), Username: username, GroupName: g.GroupName }));
    }
  }
  if (!Groups.some((g) => g.GroupName === role)) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: username, GroupName: role }));
  }
}

export const setName = (username, name) =>
  cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: pool(), Username: username, UserAttributes: [{ Name: 'name', Value: name }] }));

export const disable = (username) => cognito.send(new AdminDisableUserCommand({ UserPoolId: pool(), Username: username }));
export const enable = (username) => cognito.send(new AdminEnableUserCommand({ UserPoolId: pool(), Username: username }));

/** A new temporary password; the teacher must choose their own at the next sign-in. */
export async function resetPassword(username) {
  const password = temporaryPassword();
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: username, Password: password, Permanent: false }));
  return password;
}

/** Local seeding only: a known, permanent password. */
export const setPermanentPassword = (username, password) =>
  cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: username, Password: password, Permanent: true }));