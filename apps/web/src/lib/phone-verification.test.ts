import {
  PHONE_VERIFICATION_LIMITS,
  confirmPhoneVerificationBodySchema,
  requestPhoneVerificationCodeBodySchema,
  updateRealNameBodySchema,
} from '@buddha/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import {
  codeRequestFailure,
  confirmFailure,
  formatCountdown,
  formatPhone,
  formatWait,
  isVerifiedAlready,
  realNameFormSchema,
  realNameSaveFailure,
  secondsLeft,
  verificationCodeFormSchema,
  verificationDetailsSchema,
} from './phone-verification';

/** The message the details form shows for one field, or undefined when that field is accepted. */
function messageFor(field: 'realName' | 'phone', value: string): string | undefined {
  const values = { realName: '홍길동', phone: '010-1234-5678', [field]: value };
  const parsed = verificationDetailsSchema.safeParse(values);
  if (parsed.success) return undefined;
  return parsed.error.issues.find((issue) => issue.path[0] === field)?.message;
}

/** An API refusal as `unwrap` throws it. */
const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as never,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  });

/** The 403 `assertExpectedAccount` answers when the cookie is not the account the body names. */
const forAnotherAccount = () =>
  refusal(403, 'FORBIDDEN', [
    { path: ['expectedAccountId'], message: 'session belongs to another account' },
  ]);

const ACCOUNT = 'user-1';

describe('verificationDetailsSchema', () => {
  it('outputs what the API receives: a trimmed NFC name and a digits-only phone', () => {
    expect(
      verificationDetailsSchema.parse({ realName: '  홍길동 ', phone: ' 010-1234-5678 ' }),
    ).toEqual({ realName: '홍길동', phone: '01012345678' });
    expect(
      verificationDetailsSchema.parse({ realName: ' Kim Min su', phone: '016 123 4567' }),
    ).toEqual({ realName: 'Kim Min su', phone: '0161234567' });
    // Decomposed Hangul (macOS input) is sent as syllables.
    expect(
      verificationDetailsSchema.parse({ realName: '홍길동'.normalize('NFD'), phone: '01012345678' })
        .realName,
    ).toBe('홍길동');
  });

  it('says "required" for a blank field and names the rule otherwise, in Korean', () => {
    expect(messageFor('realName', '')).toBe(copy.errRealNameRequired);
    expect(messageFor('realName', '   ')).toBe(copy.errRealNameRequired);
    expect(messageFor('phone', '')).toBe(copy.errPhoneRequired);
    for (const name of ['김', '홍길동1', 'Kim_Minsu', '·홍길동', '홍길동·', 'a'.repeat(31)]) {
      expect(messageFor('realName', name), name).toBe(copy.errRealNameFormat);
    }
    for (const phone of ['02-123-4567', '010-123-456', '0101234567a', '+82 10 1234 5678']) {
      expect(messageFor('phone', phone), phone).toBe(copy.errPhoneFormat);
    }
  });

  it('accepts and refuses exactly what the code request takes (the rule is shared)', () => {
    const candidate = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom('홍길동', ' 홍 길동 ', 'Kim', '김', '홍·', '010-1234-5678', '0101234567'),
    );
    fc.assert(
      fc.property(candidate, candidate, (realName, phone) => {
        const form = verificationDetailsSchema.safeParse({ realName, phone });
        const api = requestPhoneVerificationCodeBodySchema.safeParse({
          realName,
          phone,
          expectedAccountId: ACCOUNT,
        });
        expect(form.success).toBe(api.success);
        if (form.success && api.success) {
          expect(form.data).toEqual({ realName: api.data.realName, phone: api.data.phone });
        }
      }),
    );
  });
});

describe('verificationCodeFormSchema and realNameFormSchema', () => {
  it('takes the six digits, spaces around them trimmed', () => {
    expect(verificationCodeFormSchema.parse({ code: ' 012345 ' })).toEqual({ code: '012345' });
    const message = (code: string) =>
      verificationCodeFormSchema.safeParse({ code }).error?.issues[0]?.message;
    expect(message('')).toBe(copy.errVerificationCodeRequired);
    for (const code of ['12345', '1234567', '12 3456', 'abcdef', '１２３４５６']) {
      expect(message(code), code).toBe(copy.errVerificationCodeFormat);
    }
  });

  it('accepts and refuses exactly what the confirmation and the real-name change take', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 10 }), fc.stringMatching(/^\d{6}$/)), (code) => {
        const form = verificationCodeFormSchema.safeParse({ code });
        const api = confirmPhoneVerificationBodySchema.safeParse({
          code,
          expectedAccountId: ACCOUNT,
        });
        expect(form.success).toBe(api.success);
        if (form.success && api.success) expect(form.data.code).toBe(api.data.code);
      }),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (realName) => {
        const form = realNameFormSchema.safeParse({ realName });
        const api = updateRealNameBodySchema.safeParse({ realName, expectedAccountId: ACCOUNT });
        expect(form.success).toBe(api.success);
        if (form.success && api.success) expect(form.data.realName).toBe(api.data.realName);
      }),
    );
  });
});

describe('formatPhone', () => {
  it('hyphenates 11- and 10-digit numbers the usual way and leaves anything else alone', () => {
    expect(formatPhone('01012345678')).toBe('010-1234-5678');
    expect(formatPhone('0111234567')).toBe('011-123-4567');
    expect(formatPhone('')).toBe('');
    expect(formatPhone('123')).toBe('123');
  });

  it('round-trips through the form schema to the stored digits', () => {
    for (const digits of ['01012345678', '0111234567', '01998765432']) {
      expect(
        verificationDetailsSchema.parse({ realName: '홍길동', phone: formatPhone(digits) }).phone,
      ).toBe(digits);
    }
  });
});

describe('countdowns', () => {
  it('counts whole seconds down from the server span, never below 0 or above the span', () => {
    expect(secondsLeft(180, 0)).toBe(180);
    expect(secondsLeft(180, 500)).toBe(180);
    expect(secondsLeft(180, 1_000)).toBe(179);
    expect(secondsLeft(180, 179_001)).toBe(1);
    expect(secondsLeft(180, 180_000)).toBe(0);
    expect(secondsLeft(180, 999_999)).toBe(0);
    // The clock has not ticked since the span started: nothing has elapsed.
    expect(secondsLeft(60, -5_000)).toBe(60);
  });

  it('reads as m:ss', () => {
    expect(formatCountdown(180)).toBe('3:00');
    expect(formatCountdown(179)).toBe('2:59');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('says a wait in words, rounded up', () => {
    expect(formatWait(42)).toBe(`42${copy.unitSecond}`);
    expect(formatWait(0.2)).toBe(`1${copy.unitSecond}`);
    expect(formatWait(60)).toBe(`1${copy.unitMinute}`);
    expect(formatWait(72)).toBe(`1${copy.unitMinute} 12${copy.unitSecond}`);
    expect(formatWait(3600)).toBe(`1${copy.unitHour}`);
    expect(formatWait(3601)).toBe(`1${copy.unitHour} 1${copy.unitMinute}`);
    expect(formatWait(86_340)).toBe(`23${copy.unitHour} 59${copy.unitMinute}`);
    expect(formatWait(86_399)).toBe(`24${copy.unitHour}`);
  });
});

describe('the numbers the copy states are the fixed values (ADR-0069 decision 1 #57-3)', () => {
  it('matches PHONE_VERIFICATION_LIMITS', () => {
    const {
      codeLength,
      codeTtlSeconds,
      resendIntervalSeconds,
      maxAttempts,
      accountDailySends,
      accountPhoneDailySends,
      phoneDailyAccounts,
      ipDailySends,
      serviceDailySends,
      dailyWindowSeconds,
    } = PHONE_VERIFICATION_LIMITS;
    expect(codeLength).toBe(6);
    expect(copy.verificationIntro).toContain(`${String(codeLength)}자리`);
    expect(copy.verificationCodeHint).toContain(`${String(codeLength)}자리`);
    expect(copy.errVerificationCodeFormat).toContain(`${String(codeLength)}자리`);
    expect(copy.verificationCodeSent).toContain(`${String(codeTtlSeconds / 60)}분`);
    expect(copy.errVerificationCodeExpired).toContain(`${String(codeTtlSeconds / 60)}분`);
    expect(copy.errVerificationResendWait).toContain(`${String(resendIntervalSeconds / 60)}분`);
    expect(copy.errVerificationCodeAttemptsExceeded).toContain(`${String(maxAttempts)}번`);
    for (const [message, count] of [
      [copy.errVerificationAccountDaily, `${String(accountDailySends)}번`],
      [copy.errVerificationAccountPhoneDaily, `${String(accountPhoneDailySends)}번`],
      [copy.errVerificationPhoneAccounts, `계정 ${String(phoneDailyAccounts)}개`],
      [copy.errVerificationIpDaily, `${String(ipDailySends)}번`],
      [copy.errVerificationServiceDaily, `${String(serviceDailySends)}건`],
    ] as const) {
      expect(message).toContain(count);
      expect(message).toContain(`${String(dailyWindowSeconds / 3600)}시간`);
    }
  });
});

describe('codeRequestFailure', () => {
  it('pins a field the server names under that input', () => {
    const invalid = (field: string) =>
      refusal(400, 'VALIDATION_ERROR', [{ path: [field], message: 'x' }]);
    expect(codeRequestFailure(invalid('realName'))).toEqual({
      kind: 'field',
      field: 'realName',
      message: copy.errRealNameFormat,
    });
    expect(codeRequestFailure(invalid('phone'))).toEqual({
      kind: 'field',
      field: 'phone',
      message: copy.errPhoneFormat,
    });
    // No input shows the account the body names.
    expect(codeRequestFailure(invalid('expectedAccountId'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('counts the send button down for the resend interval, and says each limit with its wait', () => {
    const limited = (reason: string, retryAfterSeconds: number) =>
      refusal(429, 'PHONE_VERIFICATION_LIMITED', { reason, retryAfterSeconds });
    const wait = `${copy.errVerificationResendWait} 42${copy.unitSecond} ${copy.verificationRetryAfter}`;
    expect(codeRequestFailure(limited('resend_interval', 42))).toEqual({
      kind: 'resend-wait',
      message: wait,
      // A code from under a minute ago is waiting: a step that shows no code input offers one.
      codeWaitingMessage: `${copy.verificationCodeWaiting} ${wait}`,
      retryAfterSeconds: 42,
    });
    expect(codeRequestFailure(limited('account_daily', 3_700))).toEqual({
      kind: 'notice',
      message: `${copy.errVerificationAccountDaily} 1${copy.unitHour} 2${copy.unitMinute} ${copy.verificationRetryAfter}`,
    });
    for (const [reason, message] of [
      ['account_phone_daily', copy.errVerificationAccountPhoneDaily],
      ['phone_accounts', copy.errVerificationPhoneAccounts],
      ['ip_daily', copy.errVerificationIpDaily],
      ['service_daily', copy.errVerificationServiceDaily],
    ] as const) {
      expect(codeRequestFailure(limited(reason, 90))).toEqual({
        kind: 'notice',
        message: `${message} 1${copy.unitMinute} 30${copy.unitSecond} ${copy.verificationRetryAfter}`,
      });
    }
    // The limits counted with other accounts answer whole minutes (owner decision 2026-10-18,
    // second round): said as minutes, never seconds.
    for (const [reason, message] of [
      ['phone_accounts', copy.errVerificationPhoneAccounts],
      ['ip_daily', copy.errVerificationIpDaily],
      ['service_daily', copy.errVerificationServiceDaily],
    ] as const) {
      expect(codeRequestFailure(limited(reason, 1_860))).toEqual({
        kind: 'notice',
        message: `${message} 31${copy.unitMinute} ${copy.verificationRetryAfter}`,
      });
      expect(codeRequestFailure(limited(reason, 60))).toEqual({
        kind: 'notice',
        message: `${message} 1${copy.unitMinute} ${copy.verificationRetryAfter}`,
      });
    }
    // Each daily limit says its own sentence.
    expect(
      new Set(
        ['account_daily', 'account_phone_daily', 'phone_accounts', 'ip_daily', 'service_daily'].map(
          (reason) => {
            const failure = codeRequestFailure(limited(reason, 90));
            return failure.kind === 'notice' ? failure.message : failure.kind;
          },
        ),
      ).size,
    ).toBe(5);
    // Details the client cannot read: a generic notice rather than a wrong wait.
    expect(codeRequestFailure(limited('later', 5)).kind).toBe('notice');
  });

  it('reads the per-account rate limit with or without its wait', () => {
    expect(codeRequestFailure(refusal(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }))).toEqual({
      kind: 'notice',
      message: `${copy.errVerificationTooManyRequests} 30${copy.unitSecond} ${copy.verificationRetryAfter}`,
    });
    expect(codeRequestFailure(refusal(429, 'RATE_LIMITED'))).toEqual({
      kind: 'notice',
      message: copy.errVerificationTooManyRequests,
    });
  });

  it('tells the provider, the session and "verified already" apart from the rest', () => {
    // Certainly not sent: said, and nothing waits.
    expect(codeRequestFailure(refusal(502, 'SMS_SEND_FAILED'))).toEqual({
      kind: 'notice',
      message: copy.errVerificationSendFailed,
    });
    // May have been sent (owner decision 2026-10-18): the step opens the code input and waits
    // out the whole resend interval before another send, under a warning (second round: 주의(노란)
    // 모양 — the theme draws every warning yellow, third round; apart from the information of a
    // sent code) read out as an alert. No palette of its own: the status decides.
    const maybeSent = {
      kind: 'maybe-sent',
      notice: {
        status: 'warning',
        message: copy.verificationMaybeSent,
        urgent: true,
      },
      resendAfterSeconds: PHONE_VERIFICATION_LIMITS.resendIntervalSeconds,
    };
    expect(codeRequestFailure(refusal(502, 'SMS_SEND_UNCONFIRMED'))).toEqual(maybeSent);
    expect(copy.verificationMaybeSent).not.toBe(copy.errVerificationSendFailed);
    const already = refusal(409, 'PHONE_VERIFICATION_NOT_ALLOWED', {
      reason: 'already_verified',
    });
    expect(codeRequestFailure(already)).toEqual({
      kind: 'verified',
      message: copy.errVerificationAlreadyDone,
    });
    expect(isVerifiedAlready(already)).toBe(true);
    expect(codeRequestFailure(forAnotherAccount())).toEqual({
      kind: 'notice',
      message: copy.sessionChanged,
    });
    // The CSRF 403 names no field: not an account switch.
    expect(codeRequestFailure(refusal(403, 'FORBIDDEN'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
    // A 500 the API answered itself (its envelope): it was reached and sent nothing.
    expect(codeRequestFailure(refusal(500, 'INTERNAL'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('says the text may have come when no answer of the API reached the browser (second round)', () => {
    const maybeSent = {
      kind: 'maybe-sent',
      notice: {
        status: 'warning',
        message: copy.verificationMaybeSent,
        urgent: true,
      },
      resendAfterSeconds: PHONE_VERIFICATION_LIMITS.resendIntervalSeconds,
    };
    // The fetch itself failed: the network dropped, or the request timed out on the way.
    expect(codeRequestFailure(new TypeError('Failed to fetch'))).toEqual(maybeSent);
    expect(codeRequestFailure(new DOMException('signal timed out', 'TimeoutError'))).toEqual(
      maybeSent,
    );
    // A gateway in front of the API answered for it, without the API's envelope: its 502/503/504,
    // or the plain-text 500 of Next's rewrite when the API is out of reach.
    for (const status of [500, 502, 503, 504]) {
      expect(codeRequestFailure(new ApiError(status, undefined)), String(status)).toEqual(
        maybeSent,
      );
    }
    // A non-5xx without the envelope is not a lost answer.
    expect(codeRequestFailure(new ApiError(404, undefined))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('says the consent comes first when the server refuses the code for want of it (#58)', () => {
    // The hook has asked `['me']` again; the stepper goes back to the consent step with it.
    expect(codeRequestFailure(refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] }))).toEqual(
      { kind: 'notice', message: copy.errOnboardingStepsFirst },
    );
  });
});

describe('confirmFailure', () => {
  const rejected = (details: unknown) => refusal(409, 'VERIFICATION_CODE_REJECTED', details);

  it('puts a wrong code under the input with the entries it has left', () => {
    expect(confirmFailure(rejected({ reason: 'mismatch', remainingAttempts: 4 }))).toEqual({
      kind: 'field',
      message: `${copy.errVerificationCodeMismatch} (${copy.verificationAttemptsLeft} 4${copy.verificationAttemptsUnit})`,
    });
    expect(
      confirmFailure(refusal(400, 'VALIDATION_ERROR', [{ path: ['code'], message: 'x' }])),
    ).toEqual({ kind: 'field', message: copy.errVerificationCodeFormat });
  });

  it('asks for the new code under the input when an older one is typed (no entry spent)', () => {
    expect(confirmFailure(rejected({ reason: 'superseded' }))).toEqual({
      kind: 'field',
      message: copy.errVerificationCodeSuperseded,
    });
    expect(
      confirmFailure(rejected({ reason: 'superseded' }), { lastSendUncertain: false }),
    ).toEqual({ kind: 'field', message: copy.errVerificationCodeSuperseded });
  });

  it('asks for the last text’s code instead after a send whose outcome is unknown (third round)', () => {
    // The new text may never have come: not "type the new code", but the owner's own sentence.
    expect(confirmFailure(rejected({ reason: 'superseded' }), { lastSendUncertain: true })).toEqual(
      { kind: 'field', message: copy.errVerificationCodeSupersededUncertain },
    );
    expect(copy.errVerificationCodeSupersededUncertain).toBe(
      '마지막에 받은 문자의 인증번호를 입력해 주세요. 새 문자가 오지 않았다면 잠시 뒤 다시 받아 주세요.',
    );
    expect(copy.errVerificationCodeSupersededUncertain).not.toBe(
      copy.errVerificationCodeSuperseded,
    );
    // Only the older code is said apart: every other refusal reads as it does after any send.
    for (const details of [
      { reason: 'mismatch', remainingAttempts: 3 },
      { reason: 'expired' },
      { reason: 'attempts_exceeded' },
      { reason: 'no_code' },
    ]) {
      expect(confirmFailure(rejected(details), { lastSendUncertain: true })).toEqual(
        confirmFailure(rejected(details)),
      );
    }
  });

  it('sends the step back for a new code once this one can verify nothing', () => {
    expect(confirmFailure(rejected({ reason: 'expired' }))).toEqual({
      kind: 'code-gone',
      message: copy.errVerificationCodeExpired,
    });
    expect(confirmFailure(rejected({ reason: 'attempts_exceeded' }))).toEqual({
      kind: 'code-gone',
      message: copy.errVerificationCodeAttemptsExceeded,
    });
    expect(confirmFailure(rejected({ reason: 'no_code' }))).toEqual({
      kind: 'code-gone',
      message: copy.errVerificationCodeNone,
    });
    expect(confirmFailure(rejected(undefined)).kind).toBe('code-gone');
  });

  it("returns to the number when it is another account's (one account per number)", () => {
    expect(
      confirmFailure(refusal(409, 'PHONE_VERIFICATION_NOT_ALLOWED', { reason: 'phone_in_use' })),
    ).toEqual({ kind: 'phone-in-use', message: copy.errPhoneInUse });
    expect(
      confirmFailure(
        refusal(409, 'PHONE_VERIFICATION_NOT_ALLOWED', { reason: 'already_verified' }),
      ),
    ).toEqual({ kind: 'verified', message: copy.errVerificationAlreadyDone });
  });

  it('says the session changed, and nothing more specific than it knows otherwise', () => {
    expect(confirmFailure(forAnotherAccount())).toEqual({
      kind: 'notice',
      message: copy.sessionChanged,
    });
    expect(confirmFailure(refusal(500, 'INTERNAL'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });
});

describe('realNameSaveFailure', () => {
  it('pins a refused name to its input and toasts the rest', () => {
    expect(
      realNameSaveFailure(refusal(400, 'VALIDATION_ERROR', [{ path: ['realName'], message: 'x' }])),
    ).toEqual({ field: 'realName', message: copy.errRealNameFormat });
    expect(realNameSaveFailure(refusal(409, 'VERIFICATION_REQUIRED'))).toEqual({
      message: copy.errRealNameUnverified,
    });
    expect(realNameSaveFailure(forAnotherAccount())).toEqual({ message: copy.sessionChanged });
    expect(realNameSaveFailure(refusal(403, 'FORBIDDEN'))).toEqual({ message: copy.errUnknown });
    expect(realNameSaveFailure(new TypeError('Failed to fetch'))).toEqual({
      message: copy.errUnknown,
    });
  });
});
