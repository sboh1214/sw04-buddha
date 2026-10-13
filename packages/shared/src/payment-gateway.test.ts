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

describe('refundPaymentBodySchema', () => {
  it('requires a trimmed, non-empty reason within the limit', () => {
    expect(refundPaymentBodySchema.parse({ reason: '  단순 변심  ' })).toEqual({
      reason: '단순 변심',
    });
    expect(
      refundPaymentBodySchema.safeParse({ reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH) }).success,
    ).toBe(true);
    for (const body of [
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH + 1) },
    ]) {
      expect(refundPaymentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
