import assert from 'node:assert/strict';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '../../backend/library/client.js';
import {
  ADD_SCHOOL_ADMIN, CREATE_SCHOOL, GET_SCHOOL, LIST_SCHOOLS, RESET_SCHOOL_ADMIN_PASSWORD,
} from '../../src/api/platformOperations.js';
import { ME } from '../../src/api/operations.js';
import { API, as, PASSWORD, SCHOOL } from '../helpers/api.js';
import { refused, tc } from '../helpers/harness.js';

/**
 * The Angaza console against the running system: real sign-ins in both pools,
 * tokens checked by the local AppSync stand-in, accounts created in Cognito.
 * Needs `npm run aws:setup` (creates the Angaza pool), `npm run db:seed`
 * (creates angaza.admin@angazacenter.org) and `npm run api`.
 */
const ANGAZA_EMAIL = 'angaza.admin@angazacenter.org';
const ready = Boolean(process.env.PLATFORM_COGNITO_CLIENT_ID);

async function angazaToken() {
  const res = await cognito.send(new InitiateAuthCommand({
    ClientId: process.env.PLATFORM_COGNITO_CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: ANGAZA_EMAIL, PASSWORD },
  }));
  return res.AuthenticationResult.IdToken;
}

async function asAngaza(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await angazaToken()}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw Object.assign(new Error(body.errors[0].message), { errorType: body.errors[0].extensions?.errorType });
  return body.data;
}

tc({
  id: 'TC-ANG05', requirement: 'EXT-ANGAZA', level: 'Integration', technique: 'Black box, end to end',
  scenario: 'Angaza registers a school and gives it its first administrator, who can then sign in',
  data: 'a new Kenyan school; an administrator with a fresh email; a password reset',
  expected: 'A temporary password is returned once; the school page shows the administrator as not signed in yet; the temporary password asks for a new one at sign-in; a reset returns a different password',
}, async (ev, t) => {
  if (!ready) return t.skip('PLATFORM_COGNITO_CLIENT_ID is not set: run npm run aws:setup and npm run db:seed');
  const stamp = Date.now().toString(36);
  const { createSchool } = await asAngaza(CREATE_SCHOOL, { input: { name: `Test School ${stamp}`, country: 'KE', region: 'Kisumu', town: 'Maseno' } });
  const email = `admin.${stamp}@test-school.ac.ke`;
  const { addSchoolAdmin } = await asAngaza(ADD_SCHOOL_ADMIN, { input: { school_id: createSchool.school_id, first_name: 'Test', last_name: 'Admin', email } });
  assert.ok(addSchoolAdmin.temporary_password?.length >= 12);

  const { getSchool } = await asAngaza(GET_SCHOOL, { school_id: createSchool.school_id });
  assert.deepEqual(getSchool.admins.map((a) => [a.email, a.sign_in]), [[email, 'WAITING']]);

  const first = await cognito.send(new InitiateAuthCommand({
    ClientId: process.env.COGNITO_CLIENT_ID, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: addSchoolAdmin.temporary_password },
  }));
  assert.equal(first.ChallengeName, 'NEW_PASSWORD_REQUIRED');

  const { resetSchoolAdminPassword } = await asAngaza(RESET_SCHOOL_ADMIN_PASSWORD, { input: { school_id: createSchool.school_id, teacher_id: addSchoolAdmin.admin.teacher_id } });
  assert.notEqual(resetSchoolAdminPassword.temporary_password, addSchoolAdmin.temporary_password);
  ev(`${createSchool.school_id}: administrator ${email} created, WAITING, temporary password accepted, reset issued a new one`);
});

tc({
  id: 'TC-ANG06', requirement: 'EXT-ANGAZA, NFR-1', level: 'Integration', technique: 'Black box, authorisation',
  scenario: 'Real tokens from each pool are refused by the other side of the API',
  data: 'the seeded school administrator (john.man) calls listSchools; the Angaza account calls me for the seeded school',
  expected: 'Both are refused as Unauthorized',
}, async (ev, t) => {
  if (!ready) return t.skip('PLATFORM_COGNITO_CLIENT_ID is not set: run npm run aws:setup and npm run db:seed');
  const a = await refused(() => as('john', LIST_SCHOOLS), 'Unauthorized');
  const b = await refused(() => asAngaza(ME, { school_id: SCHOOL }), 'Unauthorized');
  ev(`school admin: ${a.message} | Angaza: ${b.message}`);
});
