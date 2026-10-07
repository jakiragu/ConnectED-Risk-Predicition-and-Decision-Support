export const RESOLUTION = {
  RETRY: 'RETRY',     // apply the sender's mark against the current version
  DISCARD: 'DISCARD', // nothing to do; the server already reflects the sender's intent
  REVIEW: 'REVIEW',   // keep the saved mark, record the sender's beside it for a decision
  HOLD: 'HOLD',       // the mark is already awaiting a decision; do not change it
};

export const CONFLICT_REVIEW = 'CONFLICT_REVIEW';

const AUTHORITATIVE = ['Admin', 'Head Teacher'];
export const isAuthoritative = (actor) => AUTHORITATIVE.some((r) => actor.groups?.includes(r));

/**
 * @param {{raw_score: number|null}} local  the sender's intended mark (null = clear)
 * @param {object|null} server              the stored mark row, or null if there is none
 * @param {{sub:string, groups:string[]}} actor
 */
export function resolveScoreConflict(local, server, actor) {
  if (server?.status === CONFLICT_REVIEW) {
    return isAuthoritative(actor)
      ? { resolution: RESOLUTION.RETRY, reason: 'Decided by a head teacher or administrator' }
      : { resolution: RESOLUTION.HOLD, reason: 'This mark is waiting for a decision between two entries' };
  }
  if (!server) {
    return local.raw_score === null
      ? { resolution: RESOLUTION.DISCARD, reason: 'This mark was already cleared' }
      : { resolution: RESOLUTION.RETRY, reason: 'The mark had been cleared; yours was saved' };
  }
  if (local.raw_score === server.raw_score) {
    return { resolution: RESOLUTION.DISCARD, reason: 'This mark was already saved' };
  }
  if (server.entered_by === actor.sub) {
    return { resolution: RESOLUTION.RETRY, reason: 'Your later entry replaced your earlier one' };
  }
  if (isAuthoritative(actor)) {
    return { resolution: RESOLUTION.RETRY, reason: 'Overridden by a head teacher or administrator' };
  }
  return { resolution: RESOLUTION.REVIEW, reason: 'Another teacher recorded a different mark for this student' };
}