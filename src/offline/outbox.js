import { db } from './db.js';
import { ulid } from '@gradebook/domain/ids';

export const STATUS = { PENDING: 'PENDING', SENDING: 'SENDING', FAILED: 'FAILED', CONFLICT: 'CONFLICT' };

export function enqueue(entry) {
  return db().outbox.add({
    id: ulid(),
    status: STATUS.PENDING,
    attempts: 0,
    retry_after: null,
    reason: null,
    queued_at: new Date().toISOString(),
    ...entry,
  });
}

/** A new edit to a cell replaces any refused or held edit to the same cell. */
export async function supersede(target) {
  const old = await db().outbox.where('target').equals(target)
    .filter((e) => e.status === STATUS.FAILED || e.status === STATUS.CONFLICT).primaryKeys();
  if (old.length) await db().outbox.bulkDelete(old);
}

export async function coalesce() {
  const pending = await db().outbox.where('status').equals(STATUS.PENDING).sortBy('seq');
  const last = new Map();
  for (const e of pending) if (e.entity === 'Score') last.set(e.target, e.seq);
  const keep = new Set(last.values());
  const drop = pending.filter((e) => e.entity === 'Score' && !keep.has(e.seq)).map((e) => e.seq);
  if (drop.length) await db().outbox.bulkDelete(drop);
  return drop.length;
}

/** Oldest-first batch of entries that are due, marked SENDING. */
export async function claimBatch(limit = 200, now = Date.now()) {
  await coalesce();
  const due = (await db().outbox.where('status').equals(STATUS.PENDING).sortBy('seq'))
    .filter((e) => !e.retry_after || e.retry_after <= now)
    .slice(0, limit);
  if (due.length) {
    await db().outbox.bulkUpdate(due.map((e) => ({ key: e.seq, changes: { status: STATUS.SENDING } })));
  }
  return due;
}

export const settle = (seq, changes) => db().outbox.update(seq, changes);
export const remove = (seqs) => db().outbox.bulkDelete(seqs);

/** Anything still SENDING when the app starts was interrupted. */
export async function recoverInterrupted() {
  const stuck = await db().outbox.where('status').equals(STATUS.SENDING).primaryKeys();
  if (stuck.length) {
    await db().outbox.bulkUpdate(stuck.map((key) => ({ key, changes: { status: STATUS.PENDING } })));
  }
  return stuck.length;
}

export async function counts() {
  const all = await db().outbox.toArray();
  const n = (s) => all.filter((e) => e.status === s).length;
  return { pending: n(STATUS.PENDING) + n(STATUS.SENDING), failed: n(STATUS.FAILED), held: n(STATUS.CONFLICT) };
}

export const backoffMs = (attempts) =>
  Math.round(Math.random() * Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)));