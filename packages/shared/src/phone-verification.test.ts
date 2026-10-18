import { describe, expect, it } from 'vitest';
import {
  PHONE_VERIFICATION_LIMITS,
  REAL_NAME_MAX_LENGTH,
  confirmPhoneVerificationBodySchema,
  phoneSchema,
  phoneVerificationCodeSchema,
  phoneVerificationLimitedDetailsSchema,
  phoneVerificationNotAllowedDetailsSchema,
  phoneVerificationSchema,
  realNameSchema,
  requestPhoneVerificationCodeBodySchema,
  updateRealNameBodySchema,
  verificationCodeRejectedDetailsSchema,
} from './phone-verification.js';

describe('realNameSchema', () => {
  it('accepts Hangul, Latin and other letters with spaces and ·, trimmed', () => {
    for (const [input, stored] of [
      ['홍길동', '홍길동'],
      ['  김 철수  ', '김 철수'],
      ['남궁민', '남궁민'],
      ['John Smith', 'John Smith'],
      ['José Müller', 'José Müller'],
      ['아이유·이지은', '아이유·이지은'],
      ['王小明', '王小明'],
      ['이', undefined],
    ] as const) {
      const result = realNameSchema.safeParse(input);
      if (stored === undefined) {
        expect(result.success, input).toBe(false);
      } else {
        expect(result.success, input).toBe(true);
        expect(result.data).toBe(stored);
      }
    }
  });

  it('stores decomposed Hangul (NFD) as the composed syllables and counts syllables', () => {
    const nfd = '홍길동'.normalize('NFD');
    expect(nfd.length).toBeGreaterThan(3);
    expect(realNameSchema.parse(nfd)).toBe('홍길동');
    // Thirty syllables fit even though their NFD form is ninety code units long.
    const thirty = '가'.repeat(REAL_NAME_MAX_LENGTH);
    expect(realNameSchema.parse(thirty.normalize('NFD'))).toBe(thirty);
  });

  it('refuses digits, symbols, edge separators and out-of-range lengths', () => {
    for (const bad of [
      '',
      '   ',
      '홍',
      '홍길동1',
      'hong_gildong',
      '홍길동!',
      'a@b',
      '·홍길동',
      '홍길동·',
      ' 홍길동 ·',
      '홍\t길동',
      '가'.repeat(REAL_NAME_MAX_LENGTH + 1),
    ]) {
      expect(realNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('phoneSchema', () => {
  it('normalises the usual spellings of a mobile number to digits', () => {
    for (const [input, digits] of [
      ['01012345678', '01012345678'],
      ['010-1234-5678', '01012345678'],
      [' 010 1234 5678 ', '01012345678'],
      ['011-123-4567', '0111234567'],
      ['016-1234-5678', '01612345678'],
      ['019 123 4567', '0191234567'],
    ] as const) {
      expect(phoneSchema.parse(input), input).toBe(digits);
    }
  });

  it('refuses landlines, foreign formats, letters and the wrong digit count', () => {
    for (const bad of [
      '',
      '02-123-4567',
      '012-1234-5678',
      '015-1234-5678',
      '+82-10-1234-5678',
      '(010) 1234-5678',
      '010-123-456',
      '010-12345-67890',
      '010-abcd-5678',
      '010.1234.5678',
      '0'.repeat(21),
    ]) {
      expect(phoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('PHONE_VERIFICATION_LIMITS (owner decision 2026-10-17, #57-3)', () => {
  it('holds the values the owner fixed', () => {
    expect(PHONE_VERIFICATION_LIMITS).toEqual({
      codeLength: 6,
      codeTtlSeconds: 180,
      resendIntervalSeconds: 60,
      maxAttempts: 5,
      dailySends: 10,
      dailyWindowSeconds: 86_400,
    });
  });
});

describe('phoneVerificationCodeSchema', () => {
  it('takes exactly six digits, spaces around them trimmed', () => {
    expect(phoneVerificationCodeSchema.parse('012345')).toBe('012345');
    expect(phoneVerificationCodeSchema.parse(' 987654 ')).toBe('987654');
    for (const bad of ['', '12345', '1234567', '12 345', '12a456', '１２３４５６', '123-456']) {
      expect(phoneVerificationCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('phone verification bodies and DTOs (ADR-0070)', () => {
  const account = { expectedAccountId: 'user-1' };

  it('validates and normalises the code request: real name and number on one screen', () => {
    expect(
      requestPhoneVerificationCodeBodySchema.parse({
        realName: ' 홍길동 ',
        phone: '010-1234-5678',
        ...account,
      }),
    ).toEqual({ realName: '홍길동', phone: '01012345678', expectedAccountId: 'user-1' });
    expect(
      requestPhoneVerificationCodeBodySchema.safeParse({ realName: '홍길동', ...account }).success,
    ).toBe(false);
    expect(
      requestPhoneVerificationCodeBodySchema.safeParse({ phone: '01012345678', ...account })
        .success,
    ).toBe(false);
  });

  it('requires the account the screen is showing on every write', () => {
    // A stale tab must not be able to act for whoever the cookie now belongs to.
    const bodies = [
      [requestPhoneVerificationCodeBodySchema, { realName: '홍길동', phone: '01012345678' }],
      [confirmPhoneVerificationBodySchema, { code: '123456' }],
      [updateRealNameBodySchema, { realName: '홍길동' }],
    ] as const;
    for (const [schema, fields] of bodies) {
      expect(schema.safeParse(fields).success).toBe(false);
      expect(schema.safeParse({ ...fields, expectedAccountId: '' }).success).toBe(false);
      expect(schema.safeParse({ ...fields, expectedAccountId: 'u'.repeat(256) }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...fields, ...account }).success).toBe(true);
    }
  });

  it('confirms with the code alone and changes the real name alone', () => {
    expect(confirmPhoneVerificationBodySchema.parse({ code: ' 123456 ', ...account })).toEqual({
      code: '123456',
      ...account,
    });
    expect(
      confirmPhoneVerificationBodySchema.safeParse({ code: '12345', ...account }).success,
    ).toBe(false);
    expect(updateRealNameBodySchema.parse({ realName: ' 김 철수 ', ...account })).toEqual({
      realName: '김 철수',
      ...account,
    });
    expect(updateRealNameBodySchema.safeParse({ realName: '김1', ...account }).success).toBe(false);
  });

  it('describes a verification with the digits-only number and an ISO time', () => {
    const verification = {
      realName: '홍길동',
      phone: '01012345678',
      verifiedAt: '2026-10-18T00:00:00.000Z',
    };
    expect(phoneVerificationSchema.parse(verification)).toEqual(verification);
    expect(
      phoneVerificationSchema.safeParse({ ...verification, phone: '010-1234-5678' }).success,
    ).toBe(false);
    expect(
      phoneVerificationSchema.safeParse({ ...verification, verifiedAt: 'today' }).success,
    ).toBe(false);
  });
});

describe('refusal details (ADR-0070)', () => {
  it('names why a verification is not allowed', () => {
    for (const reason of ['already_verified', 'phone_in_use']) {
      expect(phoneVerificationNotAllowedDetailsSchema.parse({ reason })).toEqual({ reason });
    }
    expect(phoneVerificationNotAllowedDetailsSchema.safeParse({ reason: 'other' }).success).toBe(
      false,
    );
  });

  it('names the limit a send hit and when the same request passes it', () => {
    for (const reason of ['resend_interval', 'account_daily', 'phone_daily']) {
      expect(
        phoneVerificationLimitedDetailsSchema.parse({ reason, retryAfterSeconds: 42 }),
      ).toEqual({ reason, retryAfterSeconds: 42 });
    }
    expect(
      phoneVerificationLimitedDetailsSchema.safeParse({
        reason: 'resend_interval',
        retryAfterSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it('names why a code verified nothing, with the entries left only on a mismatch', () => {
    for (const reason of ['no_code', 'expired', 'attempts_exceeded']) {
      expect(verificationCodeRejectedDetailsSchema.parse({ reason })).toEqual({ reason });
    }
    expect(
      verificationCodeRejectedDetailsSchema.parse({ reason: 'mismatch', remainingAttempts: 4 }),
    ).toEqual({ reason: 'mismatch', remainingAttempts: 4 });
    // A fifth wrong entry is `attempts_exceeded`, never a mismatch with nothing left.
    expect(
      verificationCodeRejectedDetailsSchema.safeParse({ reason: 'mismatch', remainingAttempts: 0 })
        .success,
    ).toBe(false);
    expect(verificationCodeRejectedDetailsSchema.safeParse({ reason: 'mismatch' }).success).toBe(
      false,
    );
  });
});
