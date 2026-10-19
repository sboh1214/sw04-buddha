import {
  PHONE_VERIFICATION_LIMITS,
  phoneSchema,
  phoneVerificationCodeSchema,
  phoneVerificationLimitedDetailsSchema,
  phoneVerificationNotAllowedDetailsSchema,
  realNameSchema,
  verificationCodeRejectedDetailsSchema,
  type PhoneVerificationLimitReason,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { isApiError, isApiUnreachable, isForAnotherAccount, validationField } from './api';

/**
 * 본인확인 (#183, ADR-0070) as its screens read it: the forms of the verification step on
 * /onboarding and of the real-name card in MY 설정, the countdowns of a sent code, and what each
 * refusal of the three requests means for the screen that made it.
 *
 * The RULES are the API's own: `realNameSchema`, `phoneSchema` and `phoneVerificationCodeSchema`
 * from @buddha/shared are what the request bodies are parsed with, so a form can neither accept a
 * value the server refuses nor refuse one it accepts (PLAN 11.5: the policy is not re-implemented,
 * only the message is localised). The shared schemas' own messages are English and never shown.
 * What a form hands to `onSubmit` is the shared schema's OUTPUT — the trimmed, NFC-normalised
 * name, the digits-only number and the six digits — i.e. exactly what the server receives.
 *
 * Kept out of the components so vitest can run it under its node environment.
 */
function localised<T>(
  schema: z.ZodType<T, string>,
  requiredMessage: string,
  formatMessage: string,
) {
  return z.string().transform((value, ctx) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    ctx.addIssue({
      code: 'custom',
      message: value.trim() === '' ? requiredMessage : formatMessage,
    });
    return z.NEVER;
  });
}

const realNameField = localised(realNameSchema, copy.errRealNameRequired, copy.errRealNameFormat);
const phoneField = localised(phoneSchema, copy.errPhoneRequired, copy.errPhoneFormat);
const codeField = localised(
  phoneVerificationCodeSchema,
  copy.errVerificationCodeRequired,
  copy.errVerificationCodeFormat,
);

/** The step's first form: the real name and the number the code goes to, on one screen (#57-3). */
export const verificationDetailsSchema = z.object({ realName: realNameField, phone: phoneField });
/** What the inputs hold (the number as typed); `z.output` is the normalised pair sent. */
export type VerificationDetailsValues = z.input<typeof verificationDetailsSchema>;

/** The step's second form: the code the text carried. */
export const verificationCodeFormSchema = z.object({ code: codeField });
export type VerificationCodeValues = z.input<typeof verificationCodeFormSchema>;

/** MY 설정's real-name card: the one field a member may change after verifying (#57-3). */
export const realNameFormSchema = z.object({ realName: realNameField });
export type RealNameFormValues = z.input<typeof realNameFormSchema>;

/**
 * A stored number (digits only, `PHONE_PATTERN`) the way people write it: 010-1234-5678, or
 * 011-123-4567 for the 10-digit ones. Anything else is returned untouched rather than guessed at.
 */
export function formatPhone(digits: string): string {
  if (/^\d{11}$/.test(digits))
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (/^\d{10}$/.test(digits))
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

// ---- countdowns ---------------------------------------------------------------------

/**
 * Whole seconds left of a span of `seconds` that started `elapsedMs` ago, between 0 and
 * `seconds`. The spans are the server's own relative answers (`expiresInSeconds`,
 * `resendAfterSeconds`, `retryAfterSeconds`), measured from when the answer arrived with the
 * browser's monotonic clock: only the elapsed time is the browser's, so a wrong wall clock
 * cannot make a code look valid for longer than it is. The server already took off the time it
 * spent before answering (the SMS provider's included), so the span ends no later than the code;
 * only the answer's own trip over the network is not counted. Rounded up, so a span the server
 * answered reads 0 only once those seconds have passed.
 */
export function secondsLeft(seconds: number, elapsedMs: number): number {
  const left = Math.ceil(seconds - Math.max(0, elapsedMs) / 1000);
  return Math.min(seconds, Math.max(0, left));
}

/** A countdown on screen: `2:59`, `0:42`. Both of the step's are under an hour (180 s, 60 s). */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * A wait the server named, in words: `42초`, `1분 12초`, `3시간 5분`. Rounded up — never
 * shorter than the wait, so the member who comes back when it says is not refused again.
 */
export function formatWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${String(whole)}${copy.unitSecond}`;
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    const head = `${String(minutes)}${copy.unitMinute}`;
    return rest === 0 ? head : `${head} ${String(rest)}${copy.unitSecond}`;
  }
  const totalMinutes = Math.ceil(whole / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const head = `${String(hours)}${copy.unitHour}`;
  return minutes === 0 ? head : `${head} ${String(minutes)}${copy.unitMinute}`;
}

/** `message` with the wait after it: '… 1분 12초 뒤에 다시 시도해 주세요.' */
function withWait(message: string, seconds: number): string {
  return `${message} ${formatWait(seconds)} ${copy.verificationRetryAfter}`;
}

/** `retryAfterSeconds` of a RATE_LIMITED answer (`{ retryAfterSeconds }`), when it carries one. */
function rateLimitWait(details: unknown): number | undefined {
  const parsed = z.object({ retryAfterSeconds: z.number().positive() }).safeParse(details);
  return parsed.success ? parsed.data.retryAfterSeconds : undefined;
}

/** The PHONE_VERIFICATION_NOT_ALLOWED reason, when the answer is one. */
function notAllowedReason(error: unknown) {
  if (!isApiError(error, 'PHONE_VERIFICATION_NOT_ALLOWED')) return undefined;
  const details = phoneVerificationNotAllowedDetailsSchema.safeParse(error.details);
  return details.success ? details.data.reason : undefined;
}

/**
 * Whether a refusal says the account has verified already: another tab finished first. Nothing
 * is wrong — the hooks refresh `['me']`, and the screen that asked moves on with it.
 */
export function isVerifiedAlready(error: unknown): boolean {
  return notAllowedReason(error) === 'already_verified';
}

// ---- refusals -----------------------------------------------------------------------

/**
 * A notice above the step's forms. `warning` is the look of a text that may have come — the
 * provider's answer was lost (SMS_SEND_UNCONFIRMED) or the API's never reached the browser —
 * apart from the `info` of a sent code (owner decision 2026-10-18, second round: 주의(노란) 모양).
 * The status alone decides the colour: the theme draws every warning yellow (theme/system.ts,
 * third round: 앱의 주의 안내를 모두 노란색으로), so no notice names a palette. `urgent` reads it
 * out as an alert (`role=alert`) although it is no error: it comes with the cursor moving into the
 * code input, and a polite status mounted while the focus moves is often not read at all — a text
 * that may have come, a code sent under a minute ago from elsewhere.
 */
export interface VerificationNotice {
  status: 'info' | 'warning' | 'error';
  message: string;
  urgent?: boolean;
}

/**
 * The notice of a text that may have come: SMS_SEND_UNCONFIRMED, and a request whose answer never
 * reached the browser. A warning (yellow, as every warning is), read out as an alert.
 */
const MAYBE_SENT_NOTICE: VerificationNotice = {
  status: 'warning',
  message: copy.verificationMaybeSent,
  urgent: true,
};

/** What the step does with a refused code request (`POST /me/phone-verification/code`). */
export type CodeRequestFailure =
  /** A field the server named (it disagrees with the form after a deploy): shown under it. */
  | { kind: 'field'; field: 'realName' | 'phone'; message: string }
  /**
   * The account's previous code is under a minute old: the step counts the send button down to
   * the moment the server named, and says why (`message`). That code is waiting, whichever screen
   * asked for it — before a reload, in another tab, or by a send whose answer was lost — and the
   * server confirms it from any screen of the account: a step whose code input is closed opens
   * it and says so instead (`codeWaitingMessage`).
   */
  | {
      kind: 'resend-wait';
      message: string;
      codeWaitingMessage: string;
      retryAfterSeconds: number;
    }
  /**
   * The text may have come, and its code can be confirmed (owner decisions 2026-10-18,
   * ADR-0070): the provider's answer was lost (SMS_SEND_UNCONFIRMED), or the API's own answer
   * never reached the browser — the network dropped, a gateway in front of the API answered a 5xx
   * without the API's envelope, the request timed out (`isApiUnreachable`) — after which the
   * server may have sent it all the same. The step says so (`notice`, a warning), opens the code
   * input for it, keeps the name and the number it was sent with locked, and counts the send
   * button down for `resendAfterSeconds` — the whole resend interval from this answer, which the
   * server's own wait (started before the provider was asked) never outlasts. No validity
   * countdown: the server says whether the code still holds.
   */
  | { kind: 'maybe-sent'; notice: VerificationNotice; resendAfterSeconds: number }
  /** Verified already (another tab): the hook refreshed `['me']`, and the page moves on. */
  | { kind: 'verified'; message: string }
  /** Anything else, said above the form: a daily limit, the provider, the session, the rest. */
  | { kind: 'notice'; message: string };

/** What each daily limit says (the resend interval is the step's own `resend-wait`). */
const DAILY_LIMIT_MESSAGES = {
  account_daily: copy.errVerificationAccountDaily,
  account_phone_daily: copy.errVerificationAccountPhoneDaily,
  phone_accounts: copy.errVerificationPhoneAccounts,
  ip_daily: copy.errVerificationIpDaily,
  service_daily: copy.errVerificationServiceDaily,
} as const satisfies Record<Exclude<PhoneVerificationLimitReason, 'resend_interval'>, string>;

export function codeRequestFailure(error: unknown): CodeRequestFailure {
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'realName') return { kind: 'field', field, message: copy.errRealNameFormat };
    if (field === 'phone') return { kind: 'field', field, message: copy.errPhoneFormat };
  }
  if (isApiError(error, 'PHONE_VERIFICATION_LIMITED')) {
    const details = phoneVerificationLimitedDetailsSchema.safeParse(error.details);
    if (!details.success) return { kind: 'notice', message: copy.errUnknown };
    const { reason, retryAfterSeconds } = details.data;
    if (reason === 'resend_interval') {
      const message = withWait(copy.errVerificationResendWait, retryAfterSeconds);
      return {
        kind: 'resend-wait',
        message,
        codeWaitingMessage: `${copy.verificationCodeWaiting} ${message}`,
        retryAfterSeconds,
      };
    }
    return { kind: 'notice', message: withWait(DAILY_LIMIT_MESSAGES[reason], retryAfterSeconds) };
  }
  if (isApiError(error, 'RATE_LIMITED')) {
    const wait = rateLimitWait(error.details);
    return {
      kind: 'notice',
      message:
        wait === undefined
          ? copy.errVerificationTooManyRequests
          : withWait(copy.errVerificationTooManyRequests, wait),
    };
  }
  const notAllowed = notAllowedReason(error);
  if (notAllowed === 'already_verified') {
    return { kind: 'verified', message: copy.errVerificationAlreadyDone };
  }
  if (notAllowed === 'phone_in_use') return { kind: 'notice', message: copy.errPhoneInUse };
  if (isApiError(error, 'SMS_SEND_FAILED')) {
    return { kind: 'notice', message: copy.errVerificationSendFailed };
  }
  // A lost answer, the provider's or the API's own: whether a text went is not known.
  if (isApiError(error, 'SMS_SEND_UNCONFIRMED') || isApiUnreachable(error)) {
    return {
      kind: 'maybe-sent',
      notice: MAYBE_SENT_NOTICE,
      resendAfterSeconds: PHONE_VERIFICATION_LIMITS.resendIntervalSeconds,
    };
  }
  // The consent comes first (#58) and the account's no longer stands (a revision asked for it
  // again while the step was open): the hook asked `['me']` again, and the stepper goes back to it
  // — this step and its line with it; the line stays only when `['me']` did not move (its read
  // failed). Whether to say why the account went back is a question for the owner (ADR-0072 결과 4).
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    return { kind: 'notice', message: copy.errOnboardingStepsFirst };
  }
  if (isForAnotherAccount(error)) return { kind: 'notice', message: copy.sessionChanged };
  return { kind: 'notice', message: copy.errUnknown };
}

/** What the step does with a refused confirmation (`POST /me/phone-verification/confirm`). */
export type ConfirmFailure =
  /**
   * Under the input: a wrong code with entries left (counted), an older code a resend replaced
   * (not counted) — said apart after a send whose outcome is unknown (`ConfirmContext`) — or one
   * the server would not read.
   */
  | { kind: 'field'; message: string }
  /**
   * The code can no longer verify anything — none waits, its three minutes are over, or it took
   * its fifth wrong entry — so the step goes back to the send button for a new one.
   */
  | { kind: 'code-gone'; message: string }
  /**
   * The number is another account's verified number (one account per number, #57-1): back to
   * the details, the message under the number.
   */
  | { kind: 'phone-in-use'; message: string }
  /** Verified already (another tab): the hook refreshed `['me']`, and the page moves on. */
  | { kind: 'verified'; message: string }
  | { kind: 'notice'; message: string };

/** What the step knows of the code it confirms, beyond the refusal itself. */
export interface ConfirmContext {
  /**
   * The step's last send — the one that made the account's newest code, as far as the screen
   * knows — may or may not have texted its code: the provider's answer was lost
   * (SMS_SEND_UNCONFIRMED) or the API's never reached the browser (the `maybe-sent` of
   * `codeRequestFailure`). An older code typed then is likely the last text that did come, the
   * new one never having arrived, and is answered so (owner decision 2026-10-18, third round).
   * The screen's to know, whichever way its code input was opened (verification-step.tsx); after
   * a reload it is not known, and the plain sentence is said (ADR-0070 7-32).
   */
  lastSendUncertain?: boolean;
}

export function confirmFailure(error: unknown, context: ConfirmContext = {}): ConfirmFailure {
  if (isApiError(error, 'VERIFICATION_CODE_REJECTED')) {
    const details = verificationCodeRejectedDetailsSchema.safeParse(error.details);
    if (!details.success) return { kind: 'code-gone', message: copy.errVerificationCodeNone };
    switch (details.data.reason) {
      case 'mismatch':
        return {
          kind: 'field',
          message: `${copy.errVerificationCodeMismatch} (${copy.verificationAttemptsLeft} ${String(
            details.data.remainingAttempts,
          )}${copy.verificationAttemptsUnit})`,
        };
      case 'superseded':
        // After a send whose outcome is unknown the new text may never have come: the member is
        // told to type the last text's code, and to ask again later if no new one comes, rather
        // than to type a new code they may not have.
        return {
          kind: 'field',
          message:
            context.lastSendUncertain === true
              ? copy.errVerificationCodeSupersededUncertain
              : copy.errVerificationCodeSuperseded,
        };
      case 'expired':
        return { kind: 'code-gone', message: copy.errVerificationCodeExpired };
      case 'attempts_exceeded':
        return { kind: 'code-gone', message: copy.errVerificationCodeAttemptsExceeded };
      case 'no_code':
        return { kind: 'code-gone', message: copy.errVerificationCodeNone };
    }
  }
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'code') {
    return { kind: 'field', message: copy.errVerificationCodeFormat };
  }
  const notAllowed = notAllowedReason(error);
  if (notAllowed === 'phone_in_use') return { kind: 'phone-in-use', message: copy.errPhoneInUse };
  if (notAllowed === 'already_verified') {
    return { kind: 'verified', message: copy.errVerificationAlreadyDone };
  }
  if (isForAnotherAccount(error)) return { kind: 'notice', message: copy.sessionChanged };
  return { kind: 'notice', message: copy.errUnknown };
}

/**
 * The real-name card's reading of a refused save (`PUT /me/real-name`): the field the server
 * named, or a toast. VERIFICATION_REQUIRED means the record the card showed is gone (an operator
 * removed it in the database): the hook refreshes `['me']`, and the gate takes the account to
 * the verification step.
 */
export function realNameSaveFailure(
  error: unknown,
): { field: 'realName'; message: string } | { field?: undefined; message: string } {
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'realName') {
    return { field: 'realName', message: copy.errRealNameFormat };
  }
  if (isApiError(error, 'VERIFICATION_REQUIRED')) return { message: copy.errRealNameUnverified };
  if (isForAnotherAccount(error)) return { message: copy.sessionChanged };
  return { message: copy.errUnknown };
}
