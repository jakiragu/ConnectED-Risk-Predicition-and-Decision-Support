import { identityOf } from './authz.js';
import { schoolSuspended, unauthorized } from './errors.js';
import * as platform from './platformRepo.js';

export async function resolveActor(event) {
  const id = identityOf(event);
  const [teacher, school] = await Promise.all([
    platform.teacher(id.schoolId, id.sub),
    platform.schoolForAccess(id.schoolId),
  ]);
  // Checked on every request, so a suspension takes effect at once and a reactivation as quickly.
  if (school?.status === 'SUSPENDED') {
    throw schoolSuspended('ConnectED is paused for your school by Angaza. Your records are kept. Contact Angaza to restore access.');
  }
  if (!teacher) throw unauthorized('This account is not registered at this school');
  if (teacher.status !== 'ACTIVE') throw unauthorized('This account has been deactivated');
  const role = teacher.role || teacher.groups?.[0];
  return {
    ...id,
    groups: role ? [role] : [],
    role,
    name: [teacher.first_name, teacher.last_name].filter(Boolean).join(' ') || id.email,
    access: {
      assignments: teacher.assignments || [],
      historicalClassTeacherOf: teacher.historical_class_teacher_of || [],
      classTeacherOf: teacher.class_teacher_of || null,
    },
  };
}