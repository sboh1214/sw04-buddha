import {
  keptNicknameViolation,
  nicknameNotAllowedDetailsSchema,
  nicknameRuleViolation,
  nicknameSchema,
  type NicknameRuleViolation,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, validationField } from './api';

/**
 * 닉네임 규칙 (#58, ADR-0069 decision 1 #57-6) as the two forms that set a nickname read them: the
 * onboarding's nickname step and MY 설정's nickname card. The RULES are @buddha/shared's — the
 * format (`nicknameSchema`) and, for a nickname the member typed, the auto prefix and the reserved
 * words (`nicknameRuleViolation`) — the very functions the API applies, so a form neither accepts
 * a value the server refuses on those grounds nor refuses one it accepts; only the messages are
 * localised here. Whether another account has it (ignoring case) or gave it up less than 30 days
 * ago, and the 30-day interval between changes, only the server knows: those come back as
 * NICKNAME_NOT_ALLOWED and `nicknameFailure` reads them.
 *
 * Kept out of the components so vitest can run it under its node environment.
 */

/** What each rule a typed nickname breaks says, under the input. */
const RULE_MESSAGES = {
  auto_prefix: copy.errNicknameAutoPrefix,
  reserved_word: copy.errNicknameReservedWord,
} as const satisfies Record<NicknameRuleViolation, string>;

/**
 * The form of a nickname for an account whose nickname is `current`. Trimmed first (a space typed
 * at either end is not part of a name). The format holds for every value; the rules for a typed
 * one (`nicknameRuleViolation`). `current` itself, as the server reads it:
 *
 * - in the onboarding's nickname step (`onboarding`), confirming it sets the nickname, under
 *   `keptNicknameViolation` — the offered auto nickname (`user_XXXX`, #57-6) as it is, any other
 *   (one typed through MY 설정 before #58, an admin's — the seed's 관리자 —) only once it meets the
 *   rules: one that breaks them is refused here and the member types another (오너 결정 2026-10-19
 *   (2차) 2);
 * - in MY 설정, sending it changes nothing, so there is nothing to check.
 */
export function nicknameFormSchema(current: string, { onboarding = false } = {}) {
  return z.object({
    nickname: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        if (!nicknameSchema.safeParse(value).success) {
          ctx.addIssue({ code: 'custom', message: copy.errNicknameFormat });
          return;
        }
        let violation: NicknameRuleViolation | null;
        if (value !== current) violation = nicknameRuleViolation(value);
        else if (onboarding) violation = keptNicknameViolation(value);
        else violation = null;
        if (violation !== null) ctx.addIssue({ code: 'custom', message: RULE_MESSAGES[violation] });
      }),
  });
}
export type NicknameFormValues = z.input<ReturnType<typeof nicknameFormSchema>>;

/** What a form does with a refused nickname write (`POST /me/onboarding/nickname`, `PATCH /me`). */
export type NicknameFailure =
  /** Under the input: a rule, a nickname taken (or held), the interval with when it opens again. */
  | { kind: 'field'; message: string }
  /**
   * The screen is out of date — the step was done in another tab (`already_set`), a step before
   * it is not done (ONBOARDING_REQUIRED, VERIFICATION_REQUIRED) — and the hook has asked `['me']`
   * again before the refusal reached the form: the stepper and the gate follow the server from
   * there. When the new `['me']` names another screen the step (and this line with it) is gone
   * before it is read — the member lands on the screen the server named, its heading focused; the
   * line shows only where `['me']` did not move (its read failed); where it did, the stepper says
   * above the earlier step's heading why the account is there (오너 결정 2026-10-19 (2차) 6).
   */
  | { kind: 'refresh'; message: string }
  /** Anything else, as a notice: the session switched, the generic error. */
  | { kind: 'notice'; message: string };

/**
 * `formatDate` renders `nextChangeAt` in the member's time zone (the forms pass
 * `useFormatDateTime()`), so the line reads '… 2026. 11. 17. 오후 3:00부터 다시 바꿀 수 있습니다.'
 */
export function nicknameFailure(
  error: unknown,
  formatDate: (iso: string) => string,
): NicknameFailure {
  if (isApiError(error, 'NICKNAME_NOT_ALLOWED')) {
    const details = nicknameNotAllowedDetailsSchema.safeParse(error.details);
    if (!details.success) return { kind: 'field', message: copy.errNicknameTaken };
    switch (details.data.reason) {
      case 'auto_prefix':
        return { kind: 'field', message: copy.errNicknameAutoPrefix };
      case 'reserved_word':
        return { kind: 'field', message: copy.errNicknameReservedWord };
      case 'taken':
        return { kind: 'field', message: copy.errNicknameTaken };
      case 'change_interval':
        return {
          kind: 'field',
          message: `${copy.errNicknameChangeInterval} ${formatDate(details.data.nextChangeAt)}${copy.nicknameChangeAgainFrom}`,
        };
      case 'already_set':
        return { kind: 'refresh', message: copy.errNicknameAlreadySet };
    }
  }
  if (isApiError(error, 'ONBOARDING_REQUIRED') || isApiError(error, 'VERIFICATION_REQUIRED')) {
    return { kind: 'refresh', message: copy.errOnboardingStepsFirst };
  }
  if (
    isApiError(error, 'VALIDATION_ERROR') &&
    (validationField(error) ?? 'nickname') === 'nickname'
  ) {
    return { kind: 'field', message: copy.errNicknameFormat };
  }
  if (isForAnotherAccount(error)) return { kind: 'notice', message: copy.sessionChanged };
  return { kind: 'notice', message: copy.errUnknown };
}

/** Whether a refusal says `['me']` is out of date for the account (`nicknameFailure`'s `refresh`). */
export function nicknameRefusalNeedsRefresh(error: unknown): boolean {
  if (isApiError(error, 'ONBOARDING_REQUIRED') || isApiError(error, 'VERIFICATION_REQUIRED')) {
    return true;
  }
  if (!isApiError(error, 'NICKNAME_NOT_ALLOWED')) return false;
  const details = nicknameNotAllowedDetailsSchema.safeParse(error.details);
  return details.success && details.data.reason === 'already_set';
}
