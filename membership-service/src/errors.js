/**
 * Standard error codes (spec v2.5 §18). Services throw MembershipError; an HTTP
 * layer maps `code` to a status. Nothing here leaks internal detail to callers.
 */
export const CODES = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PLAN_ARCHIVED: 409,
  INVALID_TRANSITION: 409,
  PAYMENT_PENDING: 402,
  ENTITLEMENT_EXHAUSTED: 403,
  INSUFFICIENT_COINS: 402,
  INVALID_INPUT: 400,
  PROVIDER_UNAVAILABLE: 503,
});

export class MembershipError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    if (!(code in CODES)) throw new Error('unknown error code ' + code);
    this.name = 'MembershipError';
    this.code = code;
    this.status = CODES[code];
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, details) => { throw new MembershipError(code, message, details); };
