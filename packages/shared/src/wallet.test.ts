import { describe, expect, it } from 'vitest';
import * as wallet from './wallet.js';
import {
  ADMIN_USER_STATUSES,
  adminPaymentSchema,
  adminUserQuerySchema,
  auditFailureSchema,
  ledgerEntrySchema,
  myLedgerQuerySchema,
  paymentSchema,
} from './wallet.js';

describe('the admin balance adjustment (#116)', () => {
  it('is gone: no body, no answer, no bound (ADR-0107 결정 2 #73 7항)', () => {
    // 관리자 잔액 조정은 증감 모두 없앤다: no schema is left for a route to take.
    for (const name of [
      'balanceAdjustBodySchema',
      'adminBalanceAdjustResultSchema',
      'ADJUST_MAX_ABS_COIN',
      'ADJUST_MEMO_MAX_LENGTH',
    ]) {
      expect(wallet).not.toHaveProperty(name);
    }
  });
});

describe('response schemas', () => {
  const createdAt = '2026-09-04T04:05:06.000Z';

  it('parses a ledger entry by its kind, with its market, order and correction links', () => {
    const entry = {
      id: '12',
      kind: 'DEPOSIT',
      amountCoin: '10000',
      balanceAfterCoin: '10000',
      refType: 'payment',
      refId: 'p1',
      memo: null,
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
      correctionEffect: null,
      createdAt,
    };
    expect(ledgerEntrySchema.parse(entry)).toEqual(entry);

    // A coupon redemption is a BONUS entry pointing at the redemption row, with its memo.
    expect(
      ledgerEntrySchema.parse({
        ...entry,
        id: '13',
        kind: 'BONUS',
        refType: 'coupon',
        refId: 'r1',
        memo: '쿠폰 WELCOME',
      }).refType,
    ).toBe('coupon');

    // A buyer's fill: its market and the caller's own order.
    const fill = {
      ...entry,
      id: '15',
      kind: 'BUY_FILL',
      amountCoin: '-60',
      balanceAfterCoin: '940',
      refType: 'fill',
      refId: '7',
      marketId: '3f1a5b6c-1111-4222-8333-444455556666',
      marketSlug: 'market-1',
      marketTitle: '시장',
      orderId: '3f1a5b6c-1111-4222-8333-444455556667',
    };
    expect(ledgerEntrySchema.parse(fill)).toEqual(fill);
    // A correction says what it did.
    for (const correctionEffect of ['ledger_only', 'ledger_amount']) {
      expect(
        ledgerEntrySchema.parse({ ...entry, kind: 'RECONCILIATION_CORRECTION', correctionEffect })
          .correctionEffect,
      ).toBe(correctionEffect);
    }
    expect(ledgerEntrySchema.safeParse({ ...entry, correctionEffect: 'other' }).success).toBe(
      false,
    );

    // No stored type is a kind (결과 4): neither the pair mint's nor the trade's, nor a treasury
    // or bot type, nor an unknown one.
    for (const kind of [
      'UNKNOWN',
      'PAIR_MINT_COLLATERAL',
      'TRADE_FILL',
      'TREASURY_MINT',
      'BOT_ALLOCATION',
      'BOT_RECALL',
      'PAIR_BURN_RETURN',
    ]) {
      expect(ledgerEntrySchema.safeParse({ ...entry, kind }).success, kind).toBe(false);
    }
    // The stored type is no field of the answer: what parses carries none.
    expect(Object.keys(ledgerEntrySchema.shape)).not.toContain('type');
    expect(ledgerEntrySchema.parse({ ...entry, type: 'TRADE_FILL' })).not.toHaveProperty('type');
    // Every field is required (nullable, never absent).
    for (const key of Object.keys(entry)) {
      const { [key]: _dropped, ...without } = entry as Record<string, unknown>;
      expect(ledgerEntrySchema.safeParse(without).success, key).toBe(false);
    }
    // Every event names its source (#116, migration 0060: ref_type and ref_id NOT NULL).
    expect(ledgerEntrySchema.safeParse({ ...entry, refType: null, refId: null }).success).toBe(
      false,
    );
  });

  it('takes a kind of the filter, a period and a market on the ledger query', () => {
    const marketId = '3f1a5b6c-1111-4222-8333-444455556666';
    expect(
      myLedgerQuerySchema.parse({ kind: 'SELL_FILL', period: '30d', marketId, limit: '5' }),
    ).toEqual({ kind: 'SELL_FILL', period: '30d', marketId, limit: 5 });
    // Omitted is every kind and the whole history: there is no `all` value.
    expect(myLedgerQuerySchema.parse({})).toEqual({ limit: 20 });
    for (const kind of ['DEPOSIT', 'BONUS', 'CLOSURE_FORFEIT', 'TRADE_FILL', 'ALL', '']) {
      expect(myLedgerQuerySchema.safeParse({ kind }).success, kind).toBe(false);
    }
    for (const period of ['all', '1d', '']) {
      expect(myLedgerQuerySchema.safeParse({ period }).success, period).toBe(false);
    }
    expect(myLedgerQuerySchema.safeParse({ marketId: 'not-a-uuid' }).success).toBe(false);
  });

  it('parses a payment with its KRW price and package, and an audit failure', () => {
    expect(
      paymentSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        amountCoin: '5000',
        priceKrw: 4900,
        packageId: '3f1a5b6c-1111-4222-8333-444455556667',
        provider: 'mock',
        providerRef: 'mock_1',
        status: 'succeeded',
        method: null,
        approvedAt: createdAt,
        refundedAt: null,
        resultMessage: null,
        cancelConfirmed: null,
        createdAt,
      }),
    ).toMatchObject({ priceKrw: 4900, status: 'succeeded', approvedAt: createdAt });

    // A payment whose package was later deleted keeps its own amounts.
    expect(
      paymentSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        amountCoin: '5000',
        priceKrw: 4900,
        packageId: null,
        provider: 'mock',
        providerRef: null,
        status: 'succeeded',
        method: null,
        approvedAt: createdAt,
        refundedAt: null,
        resultMessage: null,
        cancelConfirmed: null,
        createdAt,
      }).packageId,
    ).toBeNull();

    // A refunded card payment carries the PG's method, both instants and its message.
    const refunded = {
      id: '3f1a5b6c-1111-4222-8333-444455556666',
      amountCoin: '10000',
      priceKrw: 9700,
      packageId: null,
      provider: 'mock',
      providerRef: 'tid_0001',
      status: 'refunded',
      method: 'CARD',
      approvedAt: createdAt,
      refundedAt: '2026-09-05T01:02:03.000Z',
      resultMessage: '취소 성공',
      cancelConfirmed: null,
      createdAt,
    };
    expect(paymentSchema.parse(refunded)).toEqual(refunded);
    // The new fields are required (nullable, never absent), like every other DTO field.
    const { refundedAt: _dropped, ...withoutRefundedAt } = refunded;
    expect(paymentSchema.safeParse(withoutRefundedAt).success).toBe(false);
    const { cancelConfirmed: _unsaid, ...withoutCancelConfirmed } = refunded;
    expect(paymentSchema.safeParse(withoutCancelConfirmed).success).toBe(false);

    // A cancelled one says whether its card's cancel is confirmed: a boolean, or null.
    const cancelled = { ...refunded, status: 'cancelled', refundedAt: null };
    for (const cancelConfirmed of [true, false]) {
      expect(paymentSchema.parse({ ...cancelled, cancelConfirmed }).cancelConfirmed).toBe(
        cancelConfirmed,
      );
    }
    expect(paymentSchema.safeParse({ ...cancelled, cancelConfirmed: 'no' }).success).toBe(false);

    // The admin row adds the account.
    const adminRow = { ...refunded, status: 'refunding', userId: 'u1', nickname: '홍길동' };
    expect(adminPaymentSchema.parse(adminRow)).toMatchObject({
      status: 'refunding',
      nickname: '홍길동',
    });
    const { nickname: _nickname, ...withoutNickname } = adminRow;
    expect(adminPaymentSchema.safeParse(withoutNickname).success).toBe(false);

    expect(
      auditFailureSchema.parse({
        id: '1',
        kind: 'ledger_balance_mismatch',
        payload: { userId: 'u1' },
        createdAt,
      }).kind,
    ).toBe('ledger_balance_mismatch');
  });

  it('takes an optional search term on the admin user query', () => {
    expect(adminUserQuerySchema.parse({ q: ' 홍길동 ' })).toMatchObject({ q: '홍길동', limit: 20 });
    expect(adminUserQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('lists every account unless asked for the open or the closed ones only (#140)', () => {
    expect(ADMIN_USER_STATUSES).toEqual(['open', 'closed']);
    expect(adminUserQuerySchema.parse({}).status).toBeUndefined();
    expect(adminUserQuerySchema.parse({ q: 'a', status: 'open' })).toMatchObject({
      q: 'a',
      status: 'open',
    });
    expect(adminUserQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});
