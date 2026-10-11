import { identityOf } from './authz.js';
import { unauthorized } from './errors.js';
import * as platform from './platformRepo.js';

export async function resolveActor(event) {
  const id = identityOf(event);
  const teacher = await platform.teacher(id.schoolId, id.sub);
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
      classTeacherOf: teacher.class_teacher_of || null,
    },
  };
}