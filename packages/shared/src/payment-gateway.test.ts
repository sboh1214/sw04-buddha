import { describe, expect, it } from 'vitest';
import {
  PAYMENT_REFUND_WINDOW_DAYS,
  REFUND_REASON_MAX_LENGTH,
  paymentProviderInfoSchema,
  refundPaymentBodySchema,
} from './payment-gateway.js';

describe('paymentProviderInfoSchema', () => {
  it('names a known provider only', () => {
    expect(paymentProviderInfoSchema.parse({ provider: 'mock' })).toEqual({ provider: 'mock' });
    for (const body of [{}, { provider: 'smartro' }, { provider: 'toss' }]) {
      expect(paymentProviderInfoSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('pins the owner policy numbers', () => {
    expect(PAYMENT_REFUND_WINDOW_DAYS).toBe(7);
  });
});

/** The admin on screen, which the refund names (ADR-0092, Q-PG-8 ①). */
const account = { expectedAccountId: 'admin-1' } as const;

describe('refundPaymentBodySchema', () => {
  it('requires a trimmed, non-empty reason within the limit', () => {
    expect(refundPaymentBodySchema.parse({ reason: '  단순 변심  ', ...account })).toEqual({
      reason: '단순 변심',
      ...account,
    });
    expect(
      refundPaymentBodySchema.safeParse({
        reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH),
        ...account,
      }).success,
    ).toBe(true);
    for (const body of [
      { ...account },
      { reason: '', ...account },
      { reason: '   ', ...account },
      { reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH + 1), ...account },
    ]) {
      expect(refundPaymentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('requires the admin on screen (Q-PG-8 ①, ADR-0092)', () => {
    // A tab whose cookie turned to another admin must not refund as that admin.
    for (const expectedAccountId of [undefined, '', 'x'.repeat(256), 7]) {
      const body = { reason: '단순 변심', expectedAccountId };
      expect(refundPaymentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
