import {
  NICKNAME_CHANGE_INTERVAL_DAYS,
  NICKNAME_HOLD_DAYS,
  NICKNAME_RESERVED_WORDS,
  type Role,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { nicknameFailure, nicknameFormSchema, nicknameRefusalNeedsRefresh } from './nickname';

/**
 * 닉네임 규칙 (#58, ADR-0069 decision 1 #57-6) as the onboarding's nickname step and MY 설정's card
 * apply them before sending, and what each refusal of the server means for them. The rules are
 * @buddha/shared's own (`nicknameSchema`, `nicknameRuleViolation`); these tests pin that the forms
 * call them, with Korean messages, and that the messages' numbers and words are the rules'.
 */

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as never,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  });

/** The error message a form shows for `value`, or undefined when it passes. */
function messageFor(current: string, value: string, onboardingRole?: Role): string | undefined {
  const parsed = nicknameFormSchema(current, onboardingRole).safeParse({ nickname: value });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

const formatDate = (iso: string) => `<${iso}>`;

describe('nicknameFormSchema', () => {
  it('takes the offered auto nickname unchanged in the nickname step: confirming it sets it (#57-6)', () => {
    expect(messageFor('user_AB2K', 'user_AB2K', 'user')).toBeUndefined();
    // An admin's too (the seed's 관리자), as the server keeps it, pending the owner.
    expect(messageFor('관리자', '관리자', 'admin')).toBeUndefined();
    // An ordinary nickname kept from before #58.
    expect(messageFor('예측가_AB2K', '예측가_AB2K', 'user')).toBeUndefined();
  });

  it('holds a nickname kept from before #58 to the rules when the nickname step confirms it', () => {
    expect(messageFor('buddha_official', 'buddha_official', 'user')).toBe(
      copy.errNicknameReservedWord,
    );
    expect(messageFor('user_kim', 'user_kim', 'user')).toBe(copy.errNicknameAutoPrefix);
    expect(messageFor('관_리_자', '관_리_자', 'user')).toBe(copy.errNicknameReservedWord);
  });

  it('checks nothing of the nickname the account has in MY 설정, where sending it changes nothing', () => {
    expect(messageFor('user_kim', 'user_kim')).toBeUndefined();
    expect(messageFor('관리자', '관리자')).toBeUndefined();
  });

  it("refuses a typed nickname that starts with 'user_' or holds a reserved word, ignoring case", () => {
    expect(messageFor('user_ab12', 'user_zz99')).toBe(copy.errNicknameAutoPrefix);
    expect(messageFor('user_ab12', 'USER_ab12')).toBe(copy.errNicknameAutoPrefix);
    for (const word of NICKNAME_RESERVED_WORDS) {
      expect(messageFor('user_ab12', `${word}1`), word).toBe(copy.errNicknameReservedWord);
      expect(messageFor('user_ab12', `x${word.toUpperCase()}`), word).toBe(
        copy.errNicknameReservedWord,
      );
    }
    expect(messageFor('user_ab12', '비공식팬')).toBe(copy.errNicknameReservedWord);
    // Spread over underscores, the charset's only separator, a reserved word is still one.
    expect(messageFor('user_ab12', '운_영_팀')).toBe(copy.errNicknameReservedWord);
    expect(messageFor('user_ab12', 'Ad_min')).toBe(copy.errNicknameReservedWord);
  });

  it('holds every value to the format, and trims what it sends', () => {
    expect(messageFor('user_ab12', 'a')).toBe(copy.errNicknameFormat);
    expect(messageFor('user_ab12', 'x'.repeat(21))).toBe(copy.errNicknameFormat);
    expect(messageFor('user_ab12', '닉네임!')).toBe(copy.errNicknameFormat);
    expect(messageFor('user_ab12', '')).toBe(copy.errNicknameFormat);
    expect(nicknameFormSchema('user_ab12').parse({ nickname: '  새닉네임 ' })).toEqual({
      nickname: '새닉네임',
    });
    expect(messageFor('user_ab12', '새_닉네임2')).toBeUndefined();
  });
});

describe('nicknameFailure', () => {
  const notAllowed = (details: unknown) => refused(409, 'NICKNAME_NOT_ALLOWED', details);

  it('puts each rule the server names under the input', () => {
    expect(nicknameFailure(notAllowed({ reason: 'auto_prefix' }), formatDate)).toEqual({
      kind: 'field',
      message: copy.errNicknameAutoPrefix,
    });
    expect(nicknameFailure(notAllowed({ reason: 'reserved_word' }), formatDate)).toEqual({
      kind: 'field',
      message: copy.errNicknameReservedWord,
    });
    // Taken and held are one answer (#37-3): the message covers both.
    expect(nicknameFailure(notAllowed({ reason: 'taken' }), formatDate)).toEqual({
      kind: 'field',
      message: copy.errNicknameTaken,
    });
  });

  it('says when the next change is allowed, in the zone the form renders times in', () => {
    const nextChangeAt = '2026-11-17T06:00:00.000Z';
    expect(
      nicknameFailure(notAllowed({ reason: 'change_interval', nextChangeAt }), formatDate),
    ).toEqual({
      kind: 'field',
      message: `${copy.errNicknameChangeInterval} <${nextChangeAt}>${copy.nicknameChangeAgainFrom}`,
    });
  });

  it('asks the stepper to follow the server when the screen is out of date', () => {
    for (const error of [
      notAllowed({ reason: 'already_set' }),
      refused(409, 'ONBOARDING_REQUIRED', { steps: ['verification'] }),
      refused(409, 'VERIFICATION_REQUIRED'),
    ]) {
      expect(nicknameFailure(error, formatDate).kind).toBe('refresh');
      expect(nicknameRefusalNeedsRefresh(error)).toBe(true);
    }
    expect(nicknameRefusalNeedsRefresh(notAllowed({ reason: 'taken' }))).toBe(false);
  });

  it('reads a format refusal, the session switch and anything else', () => {
    expect(
      nicknameFailure(
        refused(400, 'VALIDATION_ERROR', [{ path: ['nickname'], message: 'x' }]),
        formatDate,
      ),
    ).toEqual({ kind: 'field', message: copy.errNicknameFormat });
    expect(
      nicknameFailure(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
        formatDate,
      ),
    ).toEqual({ kind: 'notice', message: copy.sessionChanged });
    expect(nicknameFailure(refused(500, 'INTERNAL'), formatDate)).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });
});

describe('the nickname copy', () => {
  it('names the numbers and the words of the rules', () => {
    expect(copy.errNicknameTaken).toContain(`${String(NICKNAME_HOLD_DAYS)}일`);
    expect(copy.errNicknameChangeInterval).toContain(`${String(NICKNAME_CHANGE_INTERVAL_DAYS)}일`);
    expect(copy.nicknameChangeRule).toContain(`${String(NICKNAME_CHANGE_INTERVAL_DAYS)}일`);
    expect(copy.errNicknameReservedWord).toContain(`(${NICKNAME_RESERVED_WORDS.join('·')})`);
    expect(copy.errNicknameAutoPrefix).toContain("'user_'");
    // Shown by MY 설정 too, where no auto nickname is left to keep: the rule alone.
    expect(copy.errNicknameAutoPrefix).not.toContain('자동');
    expect(copy.nicknameRulesHint).toContain("'user_'");
  });
});
