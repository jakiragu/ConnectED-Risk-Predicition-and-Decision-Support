import { roundHalfUp } from './results.js';

export const MAX_DAYS = 200;

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DAYS;

/** @returns {{ok:true, days_attended:number, days_excused:number} | {ok:false, reason:string}} */
export function validateAttendance(entry, schoolDays) {
  const attended = Number(entry.days_attended);
  const excused = Number(entry.days_excused ?? 0);
  if (!isCount(attended)) return { ok: false, reason: 'Days attended must be a whole number' };
  if (!isCount(excused)) return { ok: false, reason: 'Excused days must be a whole number' };
  if (attended + excused > schoolDays) {
    return { ok: false, reason: `Attended and excused days add up to more than the ${schoolDays} school days in this period` };
  }
  return { ok: true, days_attended: attended, days_excused: excused };
}

export function periodSummary(entry, schoolDays) {
  if (!entry) return { days_attended: null, days_excused: null, days_absent: null, percentage: null };
  const counted = schoolDays - entry.days_excused;
  return {
    days_attended: entry.days_attended,
    days_excused: entry.days_excused,
    days_absent: Math.max(schoolDays - entry.days_attended - entry.days_excused, 0),
    percentage: counted > 0 ? roundHalfUp((entry.days_attended / counted) * 100) : null,
  };
}

/**
 * Attendance from the first period of the year up to and including the last
 * one given. Every period must have an entry; otherwise the value is unknown
 * (null) rather than a guess, and the missing periods are named. The totals
 * behind the percentage (days attended, days counted) come back with it.
 *
 * @param {{key:string, school_days:number}[]} periods   in calendar order
 * @param {Map<string, {days_attended:number, days_excused:number}>} entries  by period key
 */
export function cumulativeAttendance(periods, entries) {
  const missing = periods.filter((p) => !entries.has(p.key)).map((p) => p.key);
  if (!periods.length || missing.length) return { percentage: null, missing, attended: null, counted: null };
  let attended = 0;
  let counted = 0;
  for (const p of periods) {
    const e = entries.get(p.key);
    attended += e.days_attended;
    counted += p.school_days - e.days_excused;
  }
  return { percentage: counted > 0 ? roundHalfUp((attended / counted) * 100) : null, missing: [], attended, counted };
}