/**
 * SmartroPaymentProvider.cancel on its own (ADR-0042), with the fake PG and no database: how
 * each cancel answer is read. A refund or a net cancel acts on this reading — `refused` puts P
 * back or reopens a payment, `unknown` never does — so every way an answer can come back is
 * pinned here, not only the ones the integration suites happen to script.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type CancelRequest } from '../payment-provider.js';
import { FakeSmartroClient, TEST_SMARTRO } from '../../test/smartro.js';
import { type SmartroResponse, SmartroUnreachableError } from './smartro-client.js';
import { SmartroPaymentProvider } from './smartro-payment.provider.js';

const REQUEST: CancelRequest = {
  paymentId: '3f1a5b6c-1111-4222-8333-444455556666',
  providerRef: 'buddhatest09281234567800000001',
  priceKrw: 9_700,
  reason: '고객 청약철회 요청',
};

describe('SmartroPaymentProvider.cancel', () => {
  const pg = new FakeSmartroClient();
  const provider = new SmartroPaymentProvider(TEST_SMARTRO, pg);

  beforeEach(() => pg.reset());

  const answering = (answer: SmartroResponse, request: Partial<CancelRequest> = {}) => {
    pg.onCancel = () => answer;
    return provider.cancel({ ...REQUEST, ...request });
  };

  it('reads the ResultCode, as a string or as a JSON number', async () => {
    expect(await answering({ ResultCode: '2001', ResultMsg: '취소 성공' })).toMatchObject({
      status: 'cancelled',
      resultCode: '2001',
      resultMessage: '취소 성공',
    });
    expect(await answering({ ResultCode: 2001 })).toMatchObject({
      status: 'cancelled',
      resultCode: '2001',
    });
    expect(await answering({ ResultCode: 2013 })).toMatchObject({
      status: 'cancelled',
      resultCode: '2013',
    });
    expect(await answering({ ResultCode: '2002', ResultMsg: '취소 실패' })).toMatchObject({
      status: 'refused',
      resultCode: '2002',
    });
    expect(await answering({ ResultCode: 2002 })).toMatchObject({ status: 'refused' });
  });

  it('calls an answer without a usable ResultCode unknown, never refused', async () => {
    for (const answer of [
      {},
      { ResultMsg: '시스템 오류' },
      { ResultCode: '' },
      { ResultCode: null },
      { ResultCode: true },
      { ResultCode: Number.NaN },
      { ResultCode: { code: '2002' } },
    ] as SmartroResponse[]) {
      const outcome = await answering(answer);
      expect({ answer, status: outcome.status }).toEqual({ answer, status: 'unknown' });
      expect(outcome.resultCode).toBeUndefined();
    }
    expect(await answering({ ResultMsg: '시스템 오류' })).toMatchObject({
      status: 'unknown',
      resultMessage: '시스템 오류',
    });
  });

  it("reads a method's own codes by the payment's method, else the answer's", async () => {
    // NaverPay's "already fully cancelled", and its "the previous cancel is not finished".
    expect(await answering({ ResultCode: 'NP17' }, { method: 'NAVER' })).toMatchObject({
      status: 'cancelled',
    });
    expect(await answering({ ResultCode: 'NP24' }, { method: 'NAVER' })).toMatchObject({
      status: 'unknown',
      resultCode: 'NP24',
    });
    // 2015 is 기취소 for SmilePay only; for a card it is a plain refusal.
    expect(await answering({ ResultCode: '2015' }, { method: 'CARD' })).toMatchObject({
      status: 'refused',
    });
    expect(await answering({ ResultCode: '2015' }, { method: 'SMILEPAY' })).toMatchObject({
      status: 'cancelled',
    });
    // No method on the payment: the answer's own PayMethod decides.
    expect(
      await answering({ ResultCode: '2015', PayMethod: 'SMILEPAY' }, { method: null }),
    ).toMatchObject({ status: 'cancelled' });
    // The payment's method outranks what the answer says.
    expect(
      await answering({ ResultCode: '2015', PayMethod: 'SMILEPAY' }, { method: 'CARD' }),
    ).toMatchObject({ status: 'refused' });
  });

  it('keeps secrets and personal fields out of the stored payload', async () => {
    const outcome = await answering({
      ResultCode: '2001',
      Tid: REQUEST.providerRef,
      BuyerName: '홍길동',
      EncData: 'secret',
      HashData: 'secret',
    });
    expect(outcome.payload).toEqual({ ResultCode: '2001', Tid: REQUEST.providerRef });
  });

  it('calls an unreachable PG unknown, and lets any other failure through', async () => {
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    expect(await provider.cancel(REQUEST)).toEqual({
      status: 'unknown',
      payload: { error: 'timed out' },
    });

    pg.onCancel = () => {
      throw new Error('a bug, not the network');
    };
    await expect(provider.cancel(REQUEST)).rejects.toThrow('a bug, not the network');
  });

  it('sends a full cancel of the whole amount, VAT split as at payment time', async () => {
    await answering({ ResultCode: '2001' });
    expect(pg.cancels).toEqual([
      expect.objectContaining({
        Tid: REQUEST.providerRef,
        Mid: TEST_SMARTRO.mid,
        CancelAmt: '9700',
        CancelMsg: REQUEST.reason,
        CancelSeq: '1',
        PartialCancelCode: '0',
        CancelTaxAmt: '8819',
        CancelVatAmt: '881',
        CancelTaxFreeAmt: '0',
        outerMid: TEST_SMARTRO.mid,
      }),
    ]);
  });
});
