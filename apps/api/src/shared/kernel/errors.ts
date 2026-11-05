import type { ErrorCode } from '@agentbazaar/contracts';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  out_of_stock: 409,
  price_changed: 409,
  quote_invalid: 400,
  quote_expired: 410,
  quote_used: 409,
  negotiation_closed: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  budget_exceeded: 429,
  payment_failed: 402,
  amount_mismatch: 409,
  invalid_signature: 401,
  illegal_transition: 409,
  pricing_misconfigured: 422,
  unavailable: 503,
  internal: 500,
};

/** Expected, user-facing failure. Anything else is a bug and becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const notFound = (what: string): AppError => new AppError('not_found', `${what} not found`);
export const forbidden = (why = 'Not allowed'): AppError => new AppError('forbidden', why);
