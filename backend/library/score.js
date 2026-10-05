export const MAX_BATCH = 200;

export const normalize = (rawScore, maxScore) => Math.round((rawScore / maxScore) * 10000) / 100;

/** An empty cell means "no mark". Sending one for an existing mark clears it. */
export const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * @param {{student_id:string, raw_score:any}} entry
 * @param {{assessment:object, roster:{has:(id:string)=>boolean}}} context
 * @returns {{ok:false, reason:string} | {ok:true, clear:true} | {ok:true, value:number, normalized:number}}
 */
export function validateEntry(entry, { assessment, roster }) {
  if (!roster.has(entry.student_id)) return { ok: false, reason: 'Student is not in this class' };
  if (isBlank(entry.raw_score)) return { ok: true, clear: true };

  const n = Number(entry.raw_score);
  if (!Number.isFinite(n)) return { ok: false, reason: 'Score must be a number' };
  if (n < 0 || n > assessment.max_score) {
    return { ok: false, reason: `Score must be between 0 and ${assessment.max_score}` };
  }
  if (Math.round(n * 2) !== n * 2) return { ok: false, reason: 'Score must be a whole or half mark' };

  return { ok: true, value: n, normalized: normalize(n, assessment.max_score) };
}