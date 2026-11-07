/**
 * Classes are year-scoped, so after a promotion two classes can share a name
 * (Form 4 East 2026, archived, and Form 4 East 2027). Every class picker and
 * class name on screen goes through these helpers so the two are never confused.
 */

export const isCurrent = (c) => (c?.status || 'CURRENT') === 'CURRENT';

/** Current classes first, then newest year first, then by name. */
export function byClassOrder(a, b) {
  return Number(isCurrent(b)) - Number(isCurrent(a))
    || (Number(b.year) || 0) - (Number(a.year) || 0)
    || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
}

export const sortClasses = (classes) => [...(classes || [])].sort(byClassOrder);

/**
 * "Form 4 East" when the name is unambiguous and the class is current;
 * "Form 4 East 2026" when another class has the same name or the class is archived.
 */
export function classLabel(c, all = []) {
  if (!c) return '';
  const shared = all.some((o) => o.class_id !== c.class_id && String(o.name).toLowerCase() === String(c.name).toLowerCase());
  return c.year && (shared || !isCurrent(c)) ? `${c.name} ${c.year}` : c.name;
}

/** class_id → label, for tables that show a class name. */
export const classLabels = (classes) => new Map((classes || []).map((c) => [c.class_id, classLabel(c, classes)]));
