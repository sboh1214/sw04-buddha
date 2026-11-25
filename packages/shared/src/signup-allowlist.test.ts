import { describe, expect, it } from 'vitest';
import {
  PHONE_VERIFICATION_REFUSALS,
  phoneVerificationNotAllowedDetailsSchema,
} from './phone-verification.js';
import {
  SIGNUP_ALLOWLIST_ADD_MAX,
  SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION,
  SIGNUP_ALLOWLIST_REFUSALS,
  parseSignupAllowlistLines,
  signupAllowlistAddBodySchema,
  signupAllowlistClearRequestBodySchema,
  signupAllowlistNotAllowedDetailsSchema,
  signupAllowlistRemoveBodySchema,
} from './signup-allowlist.js';

const account = { expectedAccountId: 'admin-1' };

describe('가입 허용 목록 (#330, ADR-0174)', () => {
  it('takes an add’s numbers in any usual spelling as digits, one reason for them all', () => {
    expect(
      signupAllowlistAddBodySchema.parse({
        ...account,
        phones: ['010-1234-5678', ' 010 1111 2222 '],
        reason: ' 폐쇄 테스트 참여자 ',
      }),
    ).toEqual({ ...account, phones: ['01012345678', '01011112222'], reason: '폐쇄 테스트 참여자' });
  });

  it('refuses the whole add for one bad number, naming its index, and an empty or oversized one', () => {
    const bad = signupAllowlistAddBodySchema.safeParse({
      ...account,
      phones: ['01012345678', '02-123-4567'],
      reason: '참여자',
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.path)).toEqual([['phones', 1]]);
    for (const phones of [
      [],
      Array.from({ length: SIGNUP_ALLOWLIST_ADD_MAX + 1 }, () => '01012345678'),
    ]) {
      expect(
        signupAllowlistAddBodySchema.safeParse({ ...account, phones, reason: 'x' }).success,
      ).toBe(false);
    }
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      expect(
        signupAllowlistAddBodySchema.safeParse({ ...account, phones: ['01012345678'], reason })
          .success,
      ).toBe(false);
    }
    // Nothing else rides along: no memo (330-10).
    expect(
      signupAllowlistAddBodySchema.safeParse({
        ...account,
        phones: ['01012345678'],
        reason: 'x',
        memo: '홍길동',
      }).success,
    ).toBe(false);
  });

  it('takes a removal’s one number and a clear’s exact confirmation', () => {
    expect(
      signupAllowlistRemoveBodySchema.parse({ ...account, phone: '010-1234-5678', reason: 'x' })
        .phone,
    ).toBe('01012345678');
    expect(
      signupAllowlistClearRequestBodySchema.parse({
        ...account,
        reason: '공개 출시',
        confirmation: ` ${SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION} `,
      }).confirmation,
    ).toBe('목록 비우기');
    for (const confirmation of ['', '비우기', '목록비우기', 'clear']) {
      expect(
        signupAllowlistClearRequestBodySchema.safeParse({ ...account, reason: 'x', confirmation })
          .success,
      ).toBe(false);
    }
  });

  it('reads pasted lines for the screen: blank lines left out, bad ones named by number (I1)', () => {
    expect(parseSignupAllowlistLines('010-1234-5678\r\n\n 01011112222 ')).toEqual({
      ok: true,
      phones: ['01012345678', '01011112222'],
    });
    expect(parseSignupAllowlistLines('01012345678\nabc\n\n02-123-4567')).toEqual({
      ok: false,
      badLines: [2, 4],
    });
    expect(parseSignupAllowlistLines('')).toEqual({ ok: true, phones: [] });
  });

  it('names its refusals, and the confirmation’s `not_listed` (330-5)', () => {
    expect(SIGNUP_ALLOWLIST_REFUSALS).toEqual(['last_entry', 'empty', 'clear_pending']);
    expect(signupAllowlistNotAllowedDetailsSchema.parse({ reason: 'last_entry' })).toEqual({
      reason: 'last_entry',
    });
    expect(PHONE_VERIFICATION_REFUSALS).toEqual(['already_verified', 'phone_in_use', 'not_listed']);
    expect(phoneVerificationNotAllowedDetailsSchema.parse({ reason: 'not_listed' })).toEqual({
      reason: 'not_listed',
    });
  });
});
