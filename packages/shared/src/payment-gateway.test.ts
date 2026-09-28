import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CARD_MIN_PRICE_KRW,
  PAYMENT_REFUND_WINDOW_DAYS,
  PAYMENT_RETURN_RESULTS,
  PAYMENT_SETTLE_OUTCOMES,
  REFUND_REASON_MAX_LENGTH,
  SETTLE_TID_MAX_LENGTH,
  SMARTRO_MODES,
  moidToPaymentId,
  paymentIdToMoid,
  paymentProviderInfoSchema,
  paymentReturnResultSchema,
  refundPaymentBodySchema,
  settlePaymentBodySchema,
  smartroModeSchema,
  smartroPrepareResultSchema,
  vatSplit,
} from './payment-gateway.js';

describe('vatSplit', () => {
  it('matches the manual formula floor(Amt - Amt / 1.1) on the seeded package prices', () => {
    // Computed by hand: 4,900 / 11 = 445.45…, 9,700 / 11 = 881.81…, 28,500 / 11 = 2,590.90…
    expect(vatSplit(4_900)).toEqual({ taxAmt: 4_455, vatAmt: 445, taxFreeAmt: 0 });
    expect(vatSplit(9_700)).toEqual({ taxAmt: 8_819, vatAmt: 881, taxFreeAmt: 0 });
    expect(vatSplit(28_500)).toEqual({ taxAmt: 25_910, vatAmt: 2_590, taxFreeAmt: 0 });
    expect(vatSplit(1_100)).toEqual({ taxAmt: 1_000, vatAmt: 100, taxFreeAmt: 0 });
    expect(vatSplit(0)).toEqual({ taxAmt: 0, vatAmt: 0, taxFreeAmt: 0 });
  });

  it('always sums back to the amount, with VAT at most a tenth of the supply value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (amt) => {
        const { taxAmt, vatAmt, taxFreeAmt } = vatSplit(amt);
        expect(taxAmt + vatAmt + taxFreeAmt).toBe(amt);
        expect(Number.isInteger(vatAmt)).toBe(true);
        // floor(amt / 11) in exact integer arithmetic, compared with BigInt division.
        expect(BigInt(vatAmt)).toBe(BigInt(amt) / 11n);
        expect(vatAmt * 10).toBeLessThanOrEqual(taxAmt);
      }),
    );
  });

  it('refuses a fractional, negative or unsafe amount', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => vatSplit(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('Moid <-> payment id', () => {
  it('drops the hyphens and lower-cases, and maps back to the same id', () => {
    const id = '3f1a5b6c-1111-4222-8333-444455556666';
    expect(paymentIdToMoid(id)).toBe('3f1a5b6c111142228333444455556666');
    expect(paymentIdToMoid(id.toUpperCase())).toBe('3f1a5b6c111142228333444455556666');
    expect(moidToPaymentId('3f1a5b6c111142228333444455556666')).toBe(id);
  });

  it('round-trips every random payment id within the 40-character Moid limit', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = randomUUID();
      const moid = paymentIdToMoid(id);
      expect(moid).toMatch(/^[0-9a-f]{32}$/);
      expect(moid.length).toBeLessThanOrEqual(40);
      expect(moidToPaymentId(moid)).toBe(id);
    }
  });

  it('refuses anything that is not a uuid on the way out', () => {
    for (const bad of ['', 'abc', '3f1a5b6c111142228333444455556666', 'not-a-uuid-at-all']) {
      expect(() => paymentIdToMoid(bad), bad).toThrow(RangeError);
    }
  });

  it('refuses every Moid we could not have issued', () => {
    for (const bad of [
      '',
      '3f1a5b6c-1111-4222-8333-444455556666', // hyphens
      '3F1A5B6C111142228333444455556666', // upper-case
      '3f1a5b6c11114222833344445555666', // 31
      '3f1a5b6c1111422283334444555566667', // 33
      '3f1a5b6c11114222833344445555666g', // not hex
      '3f1a5b6c111102228333444455556666', // version 0
      '3f1a5b6c111142220333444455556666', // variant 0
      ' 3f1a5b6c111142228333444455556666',
    ]) {
      expect(moidToPaymentId(bad), bad).toBeNull();
    }
  });
});

describe('provider info and prepare result', () => {
  const scriptUrl = {
    pc: 'https://tpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
    mobile: 'https://tmpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
  };

  it('discriminates on provider', () => {
    expect(paymentProviderInfoSchema.parse({ provider: 'mock' })).toEqual({ provider: 'mock' });
    const smartro = { provider: 'smartro', mode: 'STG', scriptUrl };
    expect(paymentProviderInfoSchema.parse(smartro)).toEqual(smartro);
    expect(paymentProviderInfoSchema.safeParse({ provider: 'smartro' }).success).toBe(false);
    expect(paymentProviderInfoSchema.safeParse({ provider: 'toss' }).success).toBe(false);
    expect(
      paymentProviderInfoSchema.safeParse({ provider: 'smartro', mode: 'DEV', scriptUrl }).success,
    ).toBe(false);
  });

  it('parses a prepared SmartroPay form with every value a string', () => {
    const form = {
      PayMethod: 'CARD',
      GoodsCnt: '1',
      GoodsName: '포인트 10,000P',
      Amt: '9700',
      Moid: '3f1a5b6c111142228333444455556666',
      Mid: 't_1234567m',
      ReturnUrl: 'http://localhost:3000/api/v1/payments/smartro/return?m=3f1a5b6c',
      StopUrl: 'http://localhost:3000/api/v1/payments/smartro/stop?m=3f1a5b6c',
      BuyerName: '홍길동',
      BuyerTel: '01012345678',
      BuyerEmail: '',
      EdiDate: '20260928093000',
      EncryptData: 'c2lnbmF0dXJl',
      TaxAmt: '8819',
      TaxFreeAmt: '0',
      VatAmt: '881',
      MallUserId: '0123456789abcdef0123',
    };
    const result = {
      paymentId: '3f1a5b6c-1111-4222-8333-444455556666',
      mode: 'STG',
      scriptUrl,
      approvalUrl: form.ReturnUrl,
      form,
    };
    expect(smartroPrepareResultSchema.parse(result)).toEqual(result);
    expect(
      smartroPrepareResultSchema.safeParse({ ...result, form: { ...form, Amt: 9700 } }).success,
    ).toBe(false);
    const { MallUserId: _dropped, ...withoutMallUserId } = form;
    expect(
      smartroPrepareResultSchema.safeParse({ ...result, form: withoutMallUserId }).success,
    ).toBe(false);
  });

  it('exposes the modes and the redirect results', () => {
    expect(smartroModeSchema.options).toEqual([...SMARTRO_MODES]);
    for (const result of PAYMENT_RETURN_RESULTS) {
      expect(paymentReturnResultSchema.parse(result)).toBe(result);
    }
    expect(paymentReturnResultSchema.safeParse('refunded').success).toBe(false);
  });

  it('pins the owner policy numbers', () => {
    expect(PAYMENT_REFUND_WINDOW_DAYS).toBe(7);
    expect(CARD_MIN_PRICE_KRW).toBe(1_000);
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

describe('settlePaymentBodySchema', () => {
  it('names the five settle outcomes', () => {
    expect(PAYMENT_SETTLE_OUTCOMES).toEqual([
      'credit',
      'cancelled',
      'failed',
      'restore',
      'refunded',
    ]);
  });

  it('requires a known outcome and a trimmed, non-empty reason within the limit', () => {
    for (const outcome of PAYMENT_SETTLE_OUTCOMES) {
      expect(
        settlePaymentBodySchema.parse({ outcome, reason: '  가맹점 관리자에서 확인  ' }),
      ).toEqual({ outcome, reason: '가맹점 관리자에서 확인' });
    }
    expect(
      settlePaymentBodySchema.safeParse({
        outcome: 'credit',
        reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH),
      }).success,
    ).toBe(true);
    for (const body of [
      {},
      { outcome: 'credit' },
      { reason: '확인' },
      { outcome: 'succeeded', reason: '확인' },
      { outcome: 'CREDIT', reason: '확인' },
      { outcome: 'credit', reason: '   ' },
      { outcome: 'credit', reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH + 1) },
    ]) {
      expect(settlePaymentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('takes an optional approval Tid: trimmed, printable, no spaces, within the limit', () => {
    const tid = 'buddhatest0928123456780000001';
    expect(
      settlePaymentBodySchema.parse({ outcome: 'credit', reason: '확인', tid: `  ${tid} ` }),
    ).toEqual({ outcome: 'credit', reason: '확인', tid });
    expect(
      settlePaymentBodySchema.safeParse({
        outcome: 'credit',
        reason: '확인',
        tid: 'x'.repeat(SETTLE_TID_MAX_LENGTH),
      }).success,
    ).toBe(true);
    for (const bad of [
      '',
      '   ',
      'two words',
      '거래번호',
      'x'.repeat(SETTLE_TID_MAX_LENGTH + 1),
      7,
    ]) {
      expect(
        settlePaymentBodySchema.safeParse({ outcome: 'credit', reason: '확인', tid: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});
