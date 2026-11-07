export class ServiceError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.type = type;
    Object.assign(this, extra);
  }
}

export const unauthorized = (m = 'Not permitted') => new ServiceError('Unauthorized', m);
export const forbidden = (m) => new ServiceError('Forbidden', m);
export const validation = (m, field) => new ServiceError('ValidationError', m, { field });
export const locked = (m) => new ServiceError('Locked', m);
export const notFound = (m) => new ServiceError('NotFound', m);
export const conflict = (m) => new ServiceError('Conflict', m);// A school Angaza has suspended. Its own type, so the web client can explain the pause
// (one clear page, not an error on every screen) and the offline queue keeps unsent work.
export const schoolSuspended = (m) => new ServiceError('SchoolSuspended', m);
