import { SUBJECT_TO_MODEL } from './features.js';

/**
 * Turning SHAP values into explanations people can read. Pure, shared by the
 * risk service and the screens.
 *
 * A SHAP value is one input's push on the model's output for one student, in
 * log-odds: positive raises the estimated risk, negative lowers it; the base
 * value plus every push is exactly the model's output for that student. The
 * same subject's results at different checkpoints are strongly related, so the
 * model can spread or even split their effect between them; explanations are
 * therefore given per subject (its columns added together) and for attendance,
 * with the individual columns underneath.
 */

const MODEL_TO_SUBJECT = Object.fromEntries(Object.entries(SUBJECT_TO_MODEL).map(([s, m]) => [m, s]));
const POINT_LABEL = {
  T1M: 'Term 1 Mid-term', T1F: 'Term 1 End-term', T2M: 'Term 2 Mid-term', T2F: 'Term 2 End-term', T3M: 'Term 3 Mid-term',
};

export const ATTENDANCE = 'Attendance';
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const round = (x, dp = 6) => Math.round(x * 10 ** dp) / 10 ** dp;

/** T2M_Religious_Education -> {point: 'T2M', group: 'CRE', kind: 'score'}; Attendance_T1F -> {point: 'T1F', group: 'Attendance'}. */
export function parseColumn(column) {
  if (column.startsWith('Attendance_')) return { point: column.slice('Attendance_'.length), group: ATTENDANCE, kind: 'attendance' };
  const [point, ...rest] = column.split('_');
  const model = rest.join('_');
  return { point, group: MODEL_TO_SUBJECT[model] ?? model, kind: 'score' };
}

export const groupOf = (column) => parseColumn(column).group;

/** A group name from a model manifest (model subject names) as the gradebook names it. */
export const displayGroup = (name) => (name === ATTENDANCE ? ATTENDANCE : MODEL_TO_SUBJECT[name] ?? name);

export function columnLabel(column) {
  const c = parseColumn(column);
  const when = POINT_LABEL[c.point] ?? c.point;
  return c.kind === 'attendance' ? `Attendance from the start of the year to ${when}` : `${c.group}, ${when} exam`;
}

/** Plain words for the direction of an effect. */
export const directionOf = (effect) => (effect > 0 ? 'RAISES' : effect < 0 ? 'LOWERS' : 'NONE');

/**
 * @param {object} p   a stored prediction: { shap_base_value, shap_values: {column: number}, features: {column: number|null} }
 * @returns {null | {base_value, base_probability, output, probability, factors, columns}}
 *   factors: per subject / attendance, largest effect first, each with its columns.
 */
export function explain(p) {
  if (!p?.shap_values) return null;
  const columns = Object.entries(p.shap_values).map(([name, effect]) => {
    const value = p.features?.[name] ?? null;
    return {
      name,
      label: columnLabel(name),
      group: groupOf(name),
      value,
      missing: value === null,
      effect: round(effect),
      direction: directionOf(effect),
    };
  });
  const total = columns.reduce((s, c) => s + Math.abs(c.effect), 0) || 1;
  const byGroup = new Map();
  for (const c of columns) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push(c);
  }
  const factors = [...byGroup.entries()].map(([group, cols]) => {
    const effect = round(cols.reduce((s, c) => s + c.effect, 0));
    const missing = cols.filter((c) => c.missing).length;
    return {
      group,
      label: group === ATTENDANCE ? 'Attendance' : `${group} results`,
      effect,
      direction: directionOf(effect),
      share: round(cols.reduce((s, c) => s + Math.abs(c.effect), 0) / total, 4),
      missing_columns: missing,
      all_missing: missing === cols.length,
      columns: cols.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)),
    };
  }).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  const output = p.shap_base_value + columns.reduce((s, c) => s + c.effect, 0);
  return {
    base_value: round(p.shap_base_value),
    base_probability: round(sigmoid(p.shap_base_value), 4),
    output: round(output),
    probability: round(sigmoid(output), 4),
    factors,
    columns: [...columns].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)),
  };
}

/** The few factors that pushed the most, for lists. */
export function topFactors(p, n = 3) {
  const e = explain(p);
  if (!e) return [];
  return e.factors.slice(0, n).map((f) => ({
    group: f.group, label: f.label, effect: f.effect, direction: f.direction, share: f.share, all_missing: f.all_missing,
  }));
}

/** One sentence for a factor, e.g. "Kiswahili results raised the estimated risk (34% of the overall effect)." */
export function sentence(f) {
  const verb = f.direction === 'RAISES' ? 'raised' : f.direction === 'LOWERS' ? 'lowered' : 'did not change';
  const what = f.all_missing ? `Missing ${f.group === ATTENDANCE ? 'attendance' : `${f.group} results`}` : f.label;
  return `${what} ${verb} the estimated risk (${Math.round(f.share * 100)}% of the overall effect).`;
}

/**
 * Mean absolute SHAP per subject / attendance over many predictions: what drove
 * the model's outputs for this group of students.
 */
export function importanceOver(predictions) {
  const sums = new Map();
  let n = 0;
  for (const p of predictions) {
    if (!p?.shap_values) continue;
    n += 1;
    const perGroup = new Map();
    for (const [name, effect] of Object.entries(p.shap_values)) {
      const g = groupOf(name);
      perGroup.set(g, (perGroup.get(g) || 0) + effect);
    }
    for (const [g, effect] of perGroup) sums.set(g, (sums.get(g) || 0) + Math.abs(effect));
  }
  return {
    students: n,
    groups: [...sums.entries()]
      .map(([group, s]) => ({ name: group, label: group === ATTENDANCE ? 'Attendance' : group, importance: round(s / (n || 1)) }))
      .sort((a, b) => b.importance - a.importance),
  };
}