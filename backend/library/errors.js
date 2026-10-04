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
export const conflict = (m) => new ServiceError('Conflict', m);