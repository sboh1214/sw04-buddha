import {
  APPROVAL_REASON_MAX_LENGTH,
  parseSignupAllowlistLines,
  phoneSchema,
  signupAllowlistNotAllowedDetailsSchema,
  type SignupAllowlistRefusal,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  isApiError,
  isForAnotherAccount,
  type SignupAllowlistClearRequest,
  validationField,
  validationMessage,
} from './api';

/**
 * Pure helpers behind 가입 허용 목록 (`/admin/signup-allowlist`, #330, ADR-0174): reading the pasted
 * lines of an add (I1 — one bad line sends nothing, and says which), the reason and the typed
 * confirmation, what a refusal says, and who may do what with the clear that waits. The rules are
 * the server's (SignupAllowlistService); the screen states them and shows the refusal it gets.
 */

/** What the add form sends, or why it sends nothing. */
export type SignupAllowlistLines = { phones: string[] } | { error: string };

/** The textarea's lines as the add sends them: every non-blank one a number, or the bad lines. */
export function signupAllowlistLines(text: string): SignupAllowlistLines {
  const parsed = parseSignupAllowlistLines(text);
  if (!parsed.ok) {
    return { error: `${copy.adminSignupAllowlistBadLines} ${parsed.badLines.join(', ')}` };
  }
  if (parsed.phones.length === 0) return { error: copy.adminSignupAllowlistNoPhones };
  return { phones: parsed.phones };
}

/** The reason every write takes: 1–500 characters after trimming, as `approvalReasonSchema`. */
export function signupAllowlistReasonError(reason: string): string | undefined {
  const trimmed = reason.trim();
  return trimmed.length === 0 || trimmed.length > APPROVAL_REASON_MAX_LENGTH
    ? copy.errSignupAllowlistReason
    : undefined;
}

/** The number a removal names, as `phoneSchema` takes it. */
export function signupAllowlistPhoneError(phone: string): string | undefined {
  return phoneSchema.safeParse(phone).success ? undefined : copy.errSignupAllowlistPhone;
}

const REFUSAL_MESSAGE: Readonly<Record<SignupAllowlistRefusal, string>> = {
  last_entry: copy.errSignupAllowlistLastEntry,
  empty: copy.errSignupAllowlistEmpty,
  clear_pending: copy.errSignupAllowlistClearPending,
};

/**
 * What the screen says of a refused write: under the field the server named (`reason`, `phone`,
 * `phones`, `confirmation`), or one line above the form.
 */
export type SignupAllowlistFailure =
  { field: 'reason' | 'phone' | 'phones' | 'confirmation'; message: string } | { message: string };

/**
 * Which write was refused: an entry write (add, remove, the clear's request) or a decision on the
 * clear that waits (approve, reject, retract). NOT_FOUND means the number for a removal and the
 * request for a decision.
 */
export type SignupAllowlistWrite = 'entries' | 'decision';

/** The two-person rule's refusals (APPROVAL_NOT_ALLOWED), as the other approval screens say them. */
const APPROVAL_MESSAGE: Readonly<Record<string, string>> = {
  no_decider: copy.errSignupAllowlistNoDecider,
  requester: copy.errApprovalRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
};

export function signupAllowlistFailure(
  error: unknown,
  write: SignupAllowlistWrite,
): SignupAllowlistFailure {
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'reason') return { field, message: copy.errSignupAllowlistReason };
    if (field === 'phone') return { field, message: copy.errSignupAllowlistPhone };
    if (field === 'phones') return { field, message: copy.adminSignupAllowlistBadLines };
    if (field === 'confirmation') return { field, message: copy.errSignupAllowlistConfirmation };
    return { message: copy.errUnknown };
  }
  if (isApiError(error, 'SIGNUP_ALLOWLIST_NOT_ALLOWED')) {
    const details = signupAllowlistNotAllowedDetailsSchema.safeParse(error.details);
    return { message: details.success ? REFUSAL_MESSAGE[details.data.reason] : copy.errUnknown };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return {
      message:
        write === 'decision'
          ? copy.errSignupAllowlistClearNotFound
          : copy.errSignupAllowlistNotFound,
    };
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const reason = validationMessage(error);
    return {
      message:
        reason !== undefined && Object.hasOwn(APPROVAL_MESSAGE, reason)
          ? APPROVAL_MESSAGE[reason]!
          : copy.errUnknown,
    };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) return { message: copy.errUnauthenticated };
  if (isForAnotherAccount(error)) return { message: copy.sessionChanged };
  if (isApiError(error, 'FORBIDDEN')) return { message: copy.adminOnly };
  return { message: copy.errUnknown };
}

/**
 * What the admin on screen may do with the clear that waits (330-2): its requester may retract it
 * and decides nothing of it; any other admin approves or rejects it. Nothing while the admin on
 * screen is unknown (`GET /me` has not answered).
 */
export function clearRequestActions(
  request: Pick<SignupAllowlistClearRequest, 'requestedBy'>,
  operatorId: string | undefined,
): { own: boolean; canDecide: boolean; canRetract: boolean } {
  if (operatorId === undefined) return { own: false, canDecide: false, canRetract: false };
  const own = request.requestedBy.id === operatorId;
  return { own, canDecide: !own, canRetract: own };
}
