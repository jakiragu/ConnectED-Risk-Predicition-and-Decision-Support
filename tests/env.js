import { mkdirSync, writeFileSync } from 'node:fs';
import { environment } from './helpers/api.js';

/** Records the run environment beside the evidence (Section 5.4.1 asks for it). Service versions are added by hand. */
const env = { ...(await environment()), service_versions: 'ADD BY HAND: DynamoDB Local, cognito-local, MinIO, Docker, Python, xgboost, shap, dice-ml' };
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/environment.json', `${JSON.stringify(env, null, 2)}\n`);
console.log(env);
process.exit(0);
