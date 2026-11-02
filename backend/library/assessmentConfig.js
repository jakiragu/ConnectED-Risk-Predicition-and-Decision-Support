export const RESULT_ROLES = ['CHECKPOINT'];
export const RISK_CHECKPOINTS = ['MIDTERM', 'ENDTERM'];

export const DEFAULT_ASSESSMENT_SCHEME = [
  {
    key: 'MIDTERM',
    name: 'Midterm',
    order: 1,
    required: true,
    result_role: 'CHECKPOINT',
    risk_checkpoint: 'MIDTERM',
  },
  {
    key: 'ENDTERM',
    name: 'Endterm',
    order: 2,
    required: true,
    result_role: 'CHECKPOINT',
    risk_checkpoint: 'ENDTERM',
  },
];

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

export function validateAssessmentScheme(scheme) {
  const errors = [];

  if (!Array.isArray(scheme) || scheme.length === 0) {
    return ['Configure at least one assessment type'];
  }

  if (scheme.length > 10) {
    return ['A school can configure at most 10 assessment types'];
  }

  const keys = new Set();
  const orders = new Set();
  const riskCheckpoints = new Set();

  for (const item of scheme) {
    if (!item || typeof item !== 'object') {
      errors.push('Each assessment type must be an object');
      continue;
    }

    if (!KEY_PATTERN.test(item.key || '')) {
      errors.push('Assessment keys must be uppercase identifiers');
    } else if (keys.has(item.key)) {
      errors.push(`Assessment key ${item.key} is duplicated`);
    } else {
      keys.add(item.key);
    }

    if (
      typeof item.name !== 'string' ||
      item.name.trim().length < 2 ||
      item.name.trim().length > 40
    ) {
      errors.push(`Assessment ${item.key || ''} needs a name between 2 and 40 characters`);
    }

    if (!Number.isInteger(item.order) || item.order < 1) {
      errors.push(`Assessment ${item.key || ''} needs a valid order`);
    } else if (orders.has(item.order)) {
      errors.push(`Assessment order ${item.order} is duplicated`);
    } else {
      orders.add(item.order);
    }

    if (typeof item.required !== 'boolean') {
      errors.push(`Assessment ${item.key || ''} must specify whether it is required`);
    }

    if (!RESULT_ROLES.includes(item.result_role)) {
      errors.push(`Assessment ${item.key || ''} has an unsupported result role`);
    }

    if (
      item.risk_checkpoint != null &&
      !RISK_CHECKPOINTS.includes(item.risk_checkpoint)
    ) {
      errors.push(`Assessment ${item.key || ''} has an unsupported risk checkpoint`);
    }

    if (item.risk_checkpoint) {
      if (riskCheckpoints.has(item.risk_checkpoint)) {
        errors.push(`${item.risk_checkpoint} is mapped more than once`);
      }
      riskCheckpoints.add(item.risk_checkpoint);
    }
  }

  return errors;
}

export function normalizeAssessmentScheme(scheme) {
  return [...scheme]
    .map((item) => ({
      key: item.key.trim(),
      name: item.name.trim(),
      order: Number(item.order),
      required: Boolean(item.required),
      result_role: item.result_role,
      risk_checkpoint: item.risk_checkpoint || null,
    }))
    .sort((a, b) => a.order - b.order);
}