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
  // The account's state refuses the action until it has done the onboarding (#58): a conflict
  // with that state, like VERIFICATION_REQUIRED, which the same request passes once it is done.
  ONBOARDING_REQUIRED: HttpStatus.CONFLICT,
  NICKNAME_NOT_ALLOWED: HttpStatus.CONFLICT,
  // The post's state refuses the edit (hidden by an operator, #45-5): a conflict with that state.
  POST_NOT_EDITABLE: HttpStatus.CONFLICT,
  // The upload is understood and refused for what it is (#45-3): not an allowed image, too large,
  // too many pixels or undecodable.
  IMAGE_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  // Where the comment would go refuses it (a hidden or deleted post or 댓글, #45-5), or the
  // comment's state refuses the edit (hidden by an operator): conflicts with that state.
  COMMENT_NOT_ALLOWED: HttpStatus.CONFLICT,
  COMMENT_NOT_EDITABLE: HttpStatus.CONFLICT,
  // The target's state refuses the like (a deleted post's or 댓글's placeholder, or hidden, #49):
  // a conflict with that state.
  LIKE_NOT_ALLOWED: HttpStatus.CONFLICT,
  // The pinned notices are at their limit (#45-8: at most three, none unpinned automatically): a
  // conflict with that state, which the same request passes once an admin unpins one.
  NOTICE_PIN_LIMIT_REACHED: HttpStatus.CONFLICT,
  // The notice moved on since the edit screen read it (saved since, whoever saved it — another
  // admin or the same one from another tab, owner decisions 2026-10-21 7 and (2차) 1): a conflict
  // with its version, which a save from the latest one passes.
  NOTICE_EDIT_CONFLICT: HttpStatus.CONFLICT,
  // The target's state or the reporter refuses the report (one's own, a pending one of the same
  // person, a placeholder, #50): a conflict with that state.
  REPORT_NOT_ALLOWED: HttpStatus.CONFLICT,
  // The person's fixed daily count of reports (#45-15), refused like a rate limit: the same
  // request passes later.
  REPORT_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  // The item's, the action's or the report's state refuses the operator's write (#50): a conflict.
  MODERATION_NOT_ALLOWED: HttpStatus.CONFLICT,
  // An operator's restriction keeps the account from the action until it ends (#185): a right taken
  // away for a while, as the 403 the public-item check answered before it had a code of its own
  // (ADR-0078) — the code and its details (the end) tell it from every other 403.
  RESTRICTED: HttpStatus.FORBIDDEN,
  // A write limit of #187 (ADR-0083), refused like a rate limit: the same write passes later.
  WRITE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  // The account's state refuses its closure until it changes (#140): the role revoked, the
  // contracts settled, the payment over, the orders cancelled — a conflict with that state, which
  // the same request passes once it is gone.
  CLOSURE_NOT_ALLOWED: HttpStatus.CONFLICT,
  // The account's state — closed by its member (#140) — refuses the operator's write for good.
  ACCOUNT_CLOSED: HttpStatus.CONFLICT,
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
