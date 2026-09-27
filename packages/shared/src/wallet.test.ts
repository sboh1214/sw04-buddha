import { describe, expect, it } from 'vitest';
import {
  ADJUST_MAX_ABS_P,
  adminUserQuerySchema,
  auditFailureSchema,
  balanceAdjustBodySchema,
  ledgerEntrySchema,
  paymentSchema,
} from './wallet.js';

describe('balanceAdjustBodySchema', () => {
  it('accepts a signed amount with a reason', () => {
    expect(balanceAdjustBodySchema.parse({ amountP: '-3000', memo: '중복 충전 회수' })).toEqual({
      amountP: -3000n,
      memo: '중복 충전 회수',
    });
    expect(balanceAdjustBodySchema.parse({ amountP: '2500', memo: '  보상  ' }).memo).toBe('보상');
  });

  it('requires a non-zero amount within the cap and a non-empty reason', () => {
    for (const body of [
      { amountP: '0', memo: '영원' },
      { amountP: (ADJUST_MAX_ABS_P + 1n).toString(), memo: '과다' },
      { amountP: (-ADJUST_MAX_ABS_P - 1n).toString(), memo: '과다' },
      { amountP: '1000', memo: '   ' },
      { amountP: '1000' },
      { amountP: '1000.5', memo: '소수' },
    ]) {
      expect(balanceAdjustBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('response schemas', () => {
  const createdAt = '2026-09-04T04:05:06.000Z';

  it('parses a ledger entry, including a null reference and memo', () => {
    expect(
      ledgerEntrySchema.parse({
        id: '12',
        type: 'DEPOSIT',
        amountP: '10000',
        balanceAfterP: '10000',
        refType: 'payment',
        refId: 'p1',
        memo: null,
        createdAt,
      }),
    ).toMatchObject({ type: 'DEPOSIT', amountP: '10000' });

    // A coupon redemption is a BONUS entry pointing at the redemption row.
    expect(
      ledgerEntrySchema.parse({
        id: '13',
        type: 'BONUS',
        amountP: '5000',
        balanceAfterP: '15000',
        refType: 'coupon',
        refId: 'r1',
        memo: '쿠폰 WELCOME',
        createdAt,
      }).refType,
    ).toBe('coupon');

    expect(
      ledgerEntrySchema.safeParse({
        id: '12',
        type: 'UNKNOWN',
        amountP: '1',
        balanceAfterP: '1',
        refType: null,
        refId: null,
        memo: null,
        createdAt,
      }).success,
    ).toBe(false);
  });

  it('parses a payment with its KRW price and package, and an audit failure', () => {
    expect(
      paymentSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        amountP: '5000',
        priceKrw: 4900,
        packageId: '3f1a5b6c-1111-4222-8333-444455556667',
        provider: 'mock',
        providerRef: 'mock_1',
        status: 'succeeded',
        method: null,
        approvedAt: createdAt,
        refundedAt: null,
        resultMessage: null,
        createdAt,
      }),
    ).toMatchObject({ priceKrw: 4900, status: 'succeeded', approvedAt: createdAt });

    // A payment whose package was later deleted keeps its own amounts.
    expect(
      paymentSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        amountP: '5000',
        priceKrw: 4900,
        packageId: null,
        provider: 'mock',
        providerRef: null,
        status: 'succeeded',
        method: null,
        approvedAt: createdAt,
        refundedAt: null,
        resultMessage: null,
        createdAt,
      }).packageId,
    ).toBeNull();

    // A refunded SmartroPay card payment carries the PG's method, both instants and its message.
    const refunded = {
      id: '3f1a5b6c-1111-4222-8333-444455556666',
      amountP: '10000',
      priceKrw: 9700,
      packageId: null,
      provider: 'smartro',
      providerRef: 'tid_0001',
      status: 'refunded',
      method: 'CARD',
      approvedAt: createdAt,
      refundedAt: '2026-09-05T01:02:03.000Z',
      resultMessage: '취소 성공',
      createdAt,
    };
    expect(paymentSchema.parse(refunded)).toEqual(refunded);
    // The new fields are required (nullable, never absent), like every other DTO field.
    const { refundedAt: _dropped, ...withoutRefundedAt } = refunded;
    expect(paymentSchema.safeParse(withoutRefundedAt).success).toBe(false);

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
    expect(adminUserQuerySchema.parse({ q: ' 예측가 ' })).toMatchObject({ q: '예측가', limit: 20 });
    expect(adminUserQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });
});
