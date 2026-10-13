/**
 * The small pure pieces around the providers: the payments configuration built from the env and
 * what `payment_events.payload` may keep.
 */
import { describe, expect, it } from 'vitest';
import { sanitizePayload } from './payment-events.js';
import { paymentsConfigFromEnv } from './payments-config.js';

describe('paymentsConfigFromEnv', () => {
  it('takes the provider of new charges from PAYMENT_PROVIDER', () => {
    expect(paymentsConfigFromEnv({ PAYMENT_PROVIDER: 'mock' })).toEqual({ provider: 'mock' });
  });
});

describe('sanitizePayload', () => {
  it('drops secrets and personal fields, keeps the rest', () => {
    expect(
      sanitizePayload({
        Tid: 't',
        TrAuthKey: 'kept: a result inquiry needs it',
        ResultCode: '3001',
        Amt: 9700,
        MerchantKey: 'x',
        cancelpwd: 'x',
        HashData: 'x',
        EncData: 'x',
        EncryptData: 'x',
        BuyerName: '홍길동',
        BuyerTel: '01012345678',
        BuyerEmail: 'a@b.c',
        ReceiverTel: '010',
        DeliveryAddr1: 'x',
        ParentEmail: 'x',
      }),
    ).toEqual({
      Tid: 't',
      TrAuthKey: 'kept: a result inquiry needs it',
      ResultCode: '3001',
      Amt: 9700,
    });
  });

  it('bounds what a public callback can make us store', () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${String(i)}`, 'v']));
    expect(Object.keys(sanitizePayload(many))).toHaveLength(64);
    const payload = sanitizePayload({
      long: 'x'.repeat(10_000),
      nul: 'a\u0000b',
      nested: { a: [1, 2] },
      ['k'.repeat(65)]: 'dropped',
      skipped: undefined,
    });
    expect(payload).toEqual({ long: 'x'.repeat(500), nul: 'ab', nested: '{"a":[1,2]}' });
  });
});
