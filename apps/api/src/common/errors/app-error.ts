import { HttpStatus } from '@nestjs/common';
import { type ErrorCode } from '@buddha/shared';

/** Default HTTP status for each PLAN 7.4 code. Domain conflicts are 409, bad input 400/422. */
export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  MARKET_NOT_OPEN: HttpStatus.CONFLICT,
  INSUFFICIENT_BALANCE: HttpStatus.CONFLICT,
  PRICE_MOVED: HttpStatus.CONFLICT,
  DUPLICATE_REQUEST: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  RULES_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  VERIFICATION_REQUIRED: HttpStatus.CONFLICT,
  REFUND_NOT_ALLOWED: HttpStatus.CONFLICT,
  PAYMENT_GATEWAY_REFUSED: HttpStatus.CONFLICT,
  // The PG could not be reached or its answer is unknown: an upstream failure, sealed like
  // every other 5xx by ApiExceptionFilter.
  PAYMENT_GATEWAY_ERROR: HttpStatus.BAD_GATEWAY,
  ROLE_CHANGE_NOT_ALLOWED: HttpStatus.CONFLICT,
  APPROVAL_NOT_ALLOWED: HttpStatus.CONFLICT,
  PHONE_VERIFICATION_NOT_ALLOWED: HttpStatus.CONFLICT,
  // A limit of the code sends (ADR-0070), refused like a rate limit: the same request passes later.
  PHONE_VERIFICATION_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  VERIFICATION_CODE_REJECTED: HttpStatus.CONFLICT,
  // The SMS provider refused the text or could not be reached (SMS_SEND_FAILED), or its answer was
  // lost and the text may have gone (SMS_SEND_UNCONFIRMED, ADR-0070): upstream failures like the
  // PG's, sealed like every other 5xx by ApiExceptionFilter — which keeps the code, the one thing
  // the screen tells the two apart by.
  SMS_SEND_FAILED: HttpStatus.BAD_GATEWAY,
  SMS_SEND_UNCONFIRMED: HttpStatus.BAD_GATEWAY,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

export interface AppErrorOptions {
  /** Developer-facing text; the web maps `code` to Korean copy (PLAN Appendix A). */
  message?: string;
  /** Serialized verbatim as `error.details` (must be JSON-safe). */
  details?: unknown;
  /** Overrides HTTP_STATUS_BY_CODE for this instance. */
  status?: number;
  cause?: unknown;
}

/**
 * Typed domain error. Thrown anywhere in a request; ApiExceptionFilter turns it into the
 * PLAN 7 error envelope with the matching HTTP status. Prefer this over Nest's
 * HttpException subclasses so every failure carries one of the documented codes.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? HTTP_STATUS_BY_CODE[code];
    this.details = options.details;
  }
}
