import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLOSURE_CONFIRMATION,
  ACCOUNT_CLOSURE_DECISION_REASON,
  ACCOUNT_CLOSURE_REFUSALS,
  accountClosureBodySchema,
  accountClosureCheckSchema,
  accountClosureNotAllowedDetailsSchema,
  accountClosureResultSchema,
  closedAccountEmail,
} from './account-closure.js';
import { ERROR_CODES } from './api/errors.js';
import { isNoEmailAddress } from './constants.js';
import { findExcludedIdentifier } from './guards/excluded.js';

describe('탈퇴 (#140)', () => {
  it('takes exactly the typed word, blanks around it aside, and the account on screen', () => {
    // ADR-0069 decision 4 #140: «'탈퇴'를 직접 입력해 한 번 확인한다».
    expect(ACCOUNT_CLOSURE_CONFIRMATION).toBe('탈퇴');
    expect(
      accountClosureBodySchema.parse({ confirmation: ' 탈퇴 ', expectedAccountId: 'u1' }),
    ).toEqual({ confirmation: '탈퇴', expectedAccountId: 'u1' });
    for (const confirmation of ['', '탈 퇴', '탈퇴합니다', '확인', 'withdraw']) {
      expect(
        accountClosureBodySchema.safeParse({ confirmation, expectedAccountId: 'u1' }).success,
        confirmation,
      ).toBe(false);
    }
    expect(accountClosureBodySchema.safeParse({ confirmation: '탈퇴' }).success).toBe(false);
  });

  it('frees the address with a placeholder of its own per account that no mail and no sign-in reaches', () => {
    // #57-17: the same address signs up again at once; better-auth's column stays unique and set.
    const placeholder = closedAccountEmail('abc123');
    expect(placeholder).toBe(closedAccountEmail('abc123'));
    expect(placeholder).not.toBe(closedAccountEmail('abc124'));
    expect(isNoEmailAddress(placeholder)).toBe(true);
  });

  it('closes the waiting account restriction requests with the owner’s reason', () => {
    // Owner decision 2026-10-23 (ADR-0085 결과 5): «거절로 기록, 까닭 '탈퇴'».
    expect(ACCOUNT_CLOSURE_DECISION_REASON).toBe('탈퇴');
  });

  it('names its refusals in the order the closure asks them, with a code of its own', () => {
    expect(ACCOUNT_CLOSURE_REFUSALS).toEqual([
      'admin',
      'unsettled_contracts',
      'payment_in_progress',
      'pending_orders',
    ]);
    expect(ERROR_CODES).toEqual(expect.arrayContaining(['CLOSURE_NOT_ALLOWED', 'ACCOUNT_CLOSED']));
    expect(accountClosureNotAllowedDetailsSchema.parse({ reason: 'admin' })).toEqual({
      reason: 'admin',
    });
    expect(accountClosureNotAllowedDetailsSchema.safeParse({ reason: 'restricted' }).success).toBe(
      false,
    );
  });

  it('reads the check and the result as the API answers them', () => {
    expect(
      accountClosureCheckSchema.parse({
        availableCoin: '10000',
        refusals: ['unsettled_contracts'],
        restriction: { kind: 'account', endsAt: null },
        startGrantReceived: true,
        pendingProposals: true,
      }),
    ).toMatchObject({ availableCoin: '10000', startGrantReceived: true, pendingProposals: true });
    // Whether the start Coin was paid is always said (owner decision 2026-10-23 (3차) 9), and so
    // is whether a proposal is being processed (#77, owner decision 2026-10-24, ADR-0089).
    expect(
      accountClosureCheckSchema.safeParse({
        availableCoin: '0',
        refusals: [],
        restriction: null,
        pendingProposals: false,
      }).success,
    ).toBe(false);
    expect(
      accountClosureCheckSchema.safeParse({
        availableCoin: '0',
        refusals: [],
        restriction: null,
        startGrantReceived: false,
      }).success,
    ).toBe(false);
    expect(
      accountClosureResultSchema.parse({
        closedAt: '2026-10-23T03:00:00.000Z',
        forfeitedCoin: '0',
      }),
    ).toEqual({ closedAt: '2026-10-23T03:00:00.000Z', forfeitedCoin: '0' });
  });

  it('names no cash-out in its API words (#113)', () => {
    // 탈퇴 is a closure of the account, never a withdrawal of Coin: the identifiers stay clear of
    // the cash-out tokens every route path and stored name is held to. Paid purchase is looked for
    // in public answers only, and these are the account's own (`payment_in_progress` names the kept
    // paid-Coin code, D9).
    for (const name of [
      'closure',
      'closeMyAccount',
      'getMyClosureCheck',
      'CLOSURE_FORFEIT',
      'account_closure',
      ...ACCOUNT_CLOSURE_REFUSALS,
    ]) {
      const hits = findExcludedIdentifier(name, 'api', { path: true });
      expect(
        hits.filter((hit) => hit.feature !== 'paid-purchase'),
        name,
      ).toEqual([]);
    }
  });
});
