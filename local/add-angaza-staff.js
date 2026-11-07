import 'dotenv/config';
import * as platformIdentity from '../backend/library/platformIdentity.js';
import { putStaff, staff } from '../backend/library/platformStore.js';

/**
 * Gives an Angaza colleague access to the Angaza console. The console never
 * creates Angaza accounts itself, so this is the one way in (locally and on AWS).
 *
 *   npm run angaza:add-staff -- --email jane@angazacenter.org --first Jane --last Wanjiru
 *
 * Prints a temporary password once; they choose their own at first sign-in.
 */
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] || '').trim() : '';
};

const email = arg('email').toLowerCase();
const first = arg('first');
const last = arg('last');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !first || !last) {
  console.log('Usage: npm run angaza:add-staff -- --email <email> --first <first name> --last <last name>');
  process.exit(1);
}

const account = await platformIdentity.createStaffAccount({ email, name: `${first} ${last}` });
if (!(await staff(account.sub))) {
  await putStaff({ staff_id: account.sub, email, first_name: first, last_name: last });
}
console.log(account.created
  ? `Added ${first} ${last} (${email}). Temporary password: ${account.temporaryPassword}\nThey choose their own password the first time they sign in at /angaza.`
  : `${email} already had an Angaza account; it can use the console now.`);
