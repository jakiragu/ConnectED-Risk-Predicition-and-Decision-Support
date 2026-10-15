import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../backend/library/client.js';
import { FEATURE_CONTRACT, POINT_NAMES } from '../backend/library/features.js';
import { invoke, scorerFunction } from '../backend/library/invoke.js';

/**
 * Publishes a risk model to the model bucket and makes it the one the scorer
 * uses. The same steps run locally (MinIO / s3rver) and against AWS (with AWS
 * credentials and MODEL_BUCKET set):
 *   1. check the folder: manifest, one model per prediction point, the
 *      feature contract's columns in order, XGBoost binary:logistic, checksums
 *   2. upload it to models/<model_version>/ (a version is never overwritten)
 *   3. ask the scorer to load that version and score sample rows (selftest)
 *   4. point models/current.json at it
 *
 *   node local/publish-model.js <model folder>          publish and switch to it
 *   node local/publish-model.js --use <model_version>   switch back to a version already published
 */
const Bucket = process.env.MODEL_BUCKET;
const POINTER = 'models/current.json';
const fail = (msg) => {
  console.error(`\nNot published: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function readObject(Key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function exists(Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
    return true;
  } catch {
    return false;
  }
}

function check(folder) {
  const manifestPath = join(folder, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`${manifestPath} not found`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(manifest.model_version || '')) fail('manifest.model_version must be 1-64 letters, digits, . _ or -');
  if (manifest.framework !== 'xgboost') fail('manifest.framework must be "xgboost"');
  const points = Object.keys(manifest.points || {});
  const missingPoints = POINT_NAMES.filter((p) => !points.includes(p));
  if (missingPoints.length) fail(`manifest has no model for ${missingPoints.join(', ')}`);

  const files = [];
  for (const point of POINT_NAMES) {
    const spec = manifest.points[point];
    if (!same(spec.features, FEATURE_CONTRACT[point])) {
      const extra = (spec.features || []).filter((c) => !FEATURE_CONTRACT[point].includes(c));
      const absent = FEATURE_CONTRACT[point].filter((c) => !(spec.features || []).includes(c));
      fail(`${point}: features must be exactly the feature contract's ${FEATURE_CONTRACT[point].length} columns in order` +
        `${extra.length ? `; not in the contract: ${extra.slice(0, 5).join(', ')}` : ''}${absent.length ? `; missing: ${absent.slice(0, 5).join(', ')}` : ''}`);
    }
    if (!(typeof spec.threshold === 'number' && spec.threshold > 0 && spec.threshold < 1)) fail(`${point}: threshold must be a number between 0 and 1`);
    const path = join(folder, spec.file || '');
    if (!spec.file || !existsSync(path) || !statSync(path).isFile()) fail(`${point}: model file ${spec.file} not found`);
    const raw = readFileSync(path);
    if (spec.sha256 && spec.sha256 !== sha256(raw)) fail(`${point}: ${spec.file} does not match its sha256 in the manifest`);
    spec.sha256 = sha256(raw);
    if (spec.file.endsWith('.json')) {
      const model = JSON.parse(raw.toString('utf8'));
      const objective = model?.learner?.objective?.name;
      if (objective !== 'binary:logistic') fail(`${point}: objective is ${objective}, expected binary:logistic`);
      const names = model?.learner?.feature_names;
      if (names?.length && !same(names, spec.features)) fail(`${point}: the model was trained with different feature names or order than the manifest`);
    }
    files.push({ point, file: spec.file, raw });
  }
  return { manifest, files };
}

async function selftest(version) {
  const report = await invoke(scorerFunction(), { action: 'selftest', model_version: version });
  for (const [point, r] of Object.entries(report.points)) {
    console.log(`  selftest ${point}: ${r.features} features, threshold ${r.threshold}, sample probabilities ${r.sample.join(' / ')}`);
  }
}

async function point(version) {
  const previous = await readObject(POINTER);
  const body = {
    model_version: version,
    prefix: `models/${version}/`,
    published_at: new Date().toISOString(),
    previous: previous ? JSON.parse(previous.toString('utf8')).model_version : null,
  };
  await s3.send(new PutObjectCommand({ Bucket, Key: POINTER, Body: JSON.stringify(body, null, 2), ContentType: 'application/json' }));
  console.log(`\nmodels/current.json -> ${version}${body.previous ? ` (was ${body.previous})` : ''}`);
  console.log('Warm scorers pick it up within MODEL_POINTER_TTL_SECONDS. Re-run predictions from Model inputs to apply it to published results.');
}

const args = process.argv.slice(2);
if (!Bucket) fail('MODEL_BUCKET is not set');

if (args[0] === '--use') {
  const version = args[1];
  if (!version || !(await exists(`models/${version}/manifest.json`))) fail(`models/${version}/ is not in ${Bucket}`);
  await selftest(version);
  await point(version);
} else {
  if (!args[0]) fail('Usage: node local/publish-model.js <model folder> | --use <model_version>');
  const folder = resolve(args[0]);
  const { manifest, files } = check(folder);
  const version = manifest.model_version;
  console.log(`Model ${version}: manifest and ${files.length} model files are valid for the feature contract`);

  const existing = await readObject(`models/${version}/manifest.json`);
  if (existing) {
    const theirs = JSON.parse(existing.toString('utf8'));
    const unchanged = POINT_NAMES.every((p) => theirs.points?.[p]?.sha256 === manifest.points[p].sha256);
    if (!unchanged) fail(`version ${version} is already published with different files; give the new model a new model_version`);
    console.log(`  ${version} is already uploaded with the same files`);
  } else {
    for (const f of files) {
      await s3.send(new PutObjectCommand({ Bucket, Key: `models/${version}/${f.file}`, Body: f.raw, ContentType: 'application/json' }));
      console.log(`  uploaded models/${version}/${f.file} (${(f.raw.length / 1024).toFixed(0)} KB)`);
    }
    await s3.send(new PutObjectCommand({
      Bucket, Key: `models/${version}/manifest.json`, Body: JSON.stringify(manifest, null, 2), ContentType: 'application/json',
    }));
    console.log(`  uploaded models/${version}/manifest.json`);
  }
  await selftest(version);
  await point(version);
}