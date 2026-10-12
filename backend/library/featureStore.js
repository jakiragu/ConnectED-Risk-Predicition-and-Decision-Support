import { buildFeatureRow, pointOf } from './features.js';
import * as attendance from './attendanceRepo.js';
import * as history from './historyRepo.js';
import * as platform from './platformRepo.js';

export async function termsOfYear(schoolId, academicYear) {
  const terms = (await platform.listTerms(schoolId)).filter((t) => Number(t.academic_year) === Number(academicYear));
  return new Map(terms.filter((t) => t.term_number).map((t) => [Number(t.term_number), t]));
}

/** The school year a prediction point belongs to, by default: the latest year whose term for that point has started. */
export async function defaultYear(schoolId, point, today) {
  const target = pointOf(point);
  const terms = (await platform.listTerms(schoolId)).filter((t) => Number(t.term_number) === target.term_number && t.start_date <= today);
  const years = terms.map((t) => Number(t.academic_year)).filter(Number.isFinite).sort((a, b) => b - a);
  return years[0] ?? null;
}

export async function buildForStudent(schoolId, studentId, point, academicYear, termsByNumber = null) {
  const terms = termsByNumber || (await termsOfYear(schoolId, academicYear));
  const [rows, entries] = await Promise.all([
    history.listStudentHistory(schoolId, studentId),
    attendance.listStudentYear(schoolId, studentId, academicYear),
  ]);
  const yearTermIds = new Set([...terms.values()].map((t) => t.term_id));
  return buildFeatureRow({
    point,
    termsByNumber: terms,
    history: rows.filter((r) => yearTermIds.has(r.term_id)),
    attendance: entries,
  });
}