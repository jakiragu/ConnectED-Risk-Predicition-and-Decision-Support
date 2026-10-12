import { forbidden, unauthorized } from './errors.js';

export const ROLE = {
  ADMIN: 'Admin',
  HEAD_TEACHER: 'Head Teacher',
  TEACHER: 'Teacher',
};

/** @returns {{sub:string, schoolId:string, groups:string[], email:string}} */
export function identityOf(event) {
  const id = event?.identity;
  if (!id?.sub) throw unauthorized('No authenticated identity on request');
  const claims = id.claims || {};
  const schoolId = claims['custom:school_id'];
  if (!schoolId) throw unauthorized('Token carries no school scope');
  return {
    sub: id.sub,
    schoolId,
    groups: id.groups || claims['cognito:groups'] || [],
    email: claims.email,
    name: claims.name || claims.email,
  };
}

export const hasRole = (actor, ...roles) => roles.some((r) => actor.groups.includes(r));


export function assertTenant(actor, schoolId) {
  if (actor.schoolId !== schoolId) {
    throw forbidden('Request is outside your school');
  }
}

export function assertClassAccess(actor, classId, assignments) {
  if (hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER)) return;
  if (!hasRole(actor, ROLE.TEACHER)) {
    throw forbidden('Your role has no gradebook access');
  }
  if (!assignments?.includes(classId)) {
    throw forbidden('You are not assigned to this class');
  }
}

export function assertCanLock(actor) {
  if (!hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER)) {
    throw forbidden('Only a head teacher or administrator can lock an assessment');
  }
}

export function assertCanPublish(actor) {
  if (!hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER)) {
    throw forbidden('Only a head teacher or administrator can calculate or publish results');
  }
}

export const canReviewResults = (actor) => hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER);

export function assertGradebookRole(actor) {
  if (!hasRole(actor, ROLE.ADMIN, ROLE.HEAD_TEACHER, ROLE.TEACHER)) {
    throw forbidden('Your role has no gradebook access');
  }
}

export function assertAdmin(actor) {
  if (!hasRole(actor, ROLE.ADMIN)) {
    throw forbidden('Only an administrator can do this');
  }
}