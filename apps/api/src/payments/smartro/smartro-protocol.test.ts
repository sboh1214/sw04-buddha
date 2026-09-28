/**
 * SmartroPay 일반연동's rules as fixed vectors (ADR-0042). The expected values were computed
 * OUTSIDE this code — with the openssl CLI (`openssl dgst -sha256 -binary | base64`,
 * `openssl enc -aes-256-cbc -K … -iv 0…0 -base64`) — so a formula that drifted from the manual
 * cannot agree with itself here.
 */
import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_UNKNOWN_CODES,
  cancelHashData,
  classifyCancel,
  ediDate,
  encryptCancelPayload,
  encryptData,
  goodsName,
  isAllowedNotifyAddress,
  isApprovalSuccess,
  isApprovalUnknown,
  mallUserId,
  signValue,
  smartroScriptUrls,
  truncateChars,
  verifySignValue,
} from './smartro-protocol.js';

const KEY = 'TestMerchantKey-0123456789abcdefghij-not-a-real-key';
const TID = 'buddhatest09281234567800000001';

describe('SmartroPay signatures', () => {
  it('EncryptData = base64(sha256(EdiDate + Mid + Amt + MerchantKey))', () => {
    expect(encryptData('20260928103000', 'buddhatest', '9700', KEY)).toBe(
      'aKNUcjVJKNnbE7PGXRHTTf23k4wxbgIqwj+DnOmPaBg=',
    );
  });

  it('SignValue splices ResultCode and the key into the Tid at 10 and 15', () => {
    expect(TID).toHaveLength(30);
    expect(signValue(TID, '3001', KEY)).toBe('zpM4YdeFN4E+2lvDcEETrJA1USscnsOI5d69Ufl8PqI=');
  });

  it('verifies a SignValue only for the same Tid, code and key', () => {
    const good = 'zpM4YdeFN4E+2lvDcEETrJA1USscnsOI5d69Ufl8PqI=';
    expect(verifySignValue(good, TID, '3001', KEY)).toBe(true);
    expect(verifySignValue(good, TID, '3002', KEY)).toBe(false);
    expect(verifySignValue(good, `${TID.slice(0, -1)}2`, '3001', KEY)).toBe(false);
    expect(verifySignValue(good, TID, '3001', `${KEY}x`)).toBe(false);
    // A different length must be a plain false, not timingSafeEqual's RangeError.
    expect(verifySignValue('short', TID, '3001', KEY)).toBe(false);
    expect(verifySignValue('', TID, '3001', KEY)).toBe(false);
  });

  it('HashData = base64(sha256(Tid + MerchantKey + CancelAmt + PartialCancelCode))', () => {
    expect(cancelHashData(TID, KEY, '9700', '0')).toBe(
      'oN/hRRmDFRtQnxHQ7hwQN2tD2/V9KQhpHA8lqTzwBvA=',
    );
  });
});

describe('the cancel payload (EncData)', () => {
  const json = '{"Tid":"buddhatest09281234567800000001","CancelAmt":"9700"}';

  it('is AES-256-CBC under the first 32 key characters, zero IV, PKCS#7, base64', () => {
    expect(encryptCancelPayload(json, KEY)).toBe(
      'S+3fW2+ksE42FHfExEboWQCt+7BuF64KsWdrRjr2aUOuUirnGsOXgZXthuY5S+Xkpkh7ddQCP6O2YLriDYgv0g==',
    );
  });

  it('decrypts back with the same key', () => {
    const decipher = createDecipheriv(
      'aes-256-cbc',
      Buffer.from(KEY.slice(0, 32)),
      Buffer.alloc(16, 0),
    );
    const plain = Buffer.concat([
      decipher.update(encryptCancelPayload(json, KEY), 'base64'),
      decipher.final(),
    ]).toString('utf8');
    expect(plain).toBe(json);
  });

  it('refuses a key whose first 32 characters are not 32 bytes', () => {
    expect(() => encryptCancelPayload(json, '가'.repeat(32))).toThrow(RangeError);
  });
});

describe('the clock and the other request fields', () => {
  it('EdiDate is Asia/Seoul yyyyMMddHHmmss, across the UTC date line', () => {
    // 15:30:05 UTC on the 27th is 00:30:05 on the 28th in Seoul (UTC+9, no DST).
    expect(ediDate(new Date('2026-09-27T15:30:05.999Z'))).toBe('20260928003005');
    expect(ediDate(new Date('2026-12-31T14:59:59.000Z'))).toBe('20261231235959');
    expect(ediDate(new Date('2026-12-31T15:00:00.000Z'))).toBe('20270101000000');
  });

  it('builds the SDK URLs of the mode with the Seoul date as the cache-buster', () => {
    const at = new Date('2026-09-27T15:30:05Z');
    expect(smartroScriptUrls('STG', at)).toEqual({
      pc: 'https://tpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
      mobile: 'https://tmpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
    });
    expect(smartroScriptUrls('REAL', at)).toEqual({
      pc: 'https://pay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
      mobile: 'https://mpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
    });
  });

  it('MallUserId is the first 20 hex digits of sha256(userId)', () => {
    expect(mallUserId('user-123')).toBe('fcdec6df4d44dbc637c7');
    expect(mallUserId('user-123')).toHaveLength(20);
    expect(mallUserId('user-124')).not.toBe(mallUserId('user-123'));
  });

  it('GoodsName names the P, within 40 characters and without gambling words', () => {
    expect(goodsName(10_000n)).toBe('포인트 10,000P');
    expect(goodsName(1_000_000n).length).toBeLessThanOrEqual(40);
  });

  it('truncates by characters, not UTF-16 units', () => {
    expect(truncateChars('환불 사유', 100)).toBe('환불 사유');
    expect(truncateChars('가'.repeat(150), 100)).toBe('가'.repeat(100));
    expect(truncateChars('😀'.repeat(3), 2)).toBe('😀😀');
  });
});

describe('the 재통보 sender', () => {
  const stg = ['211.193.35.11'];

  it('accepts only a listed address, however the socket reports an IPv4 peer', () => {
    expect(isAllowedNotifyAddress('211.193.35.11', stg)).toBe(true);
    expect(isAllowedNotifyAddress('::ffff:211.193.35.11', stg)).toBe(true);
    for (const ip of [
      undefined,
      '',
      '211.193.35.110',
      '211.193.35.1',
      '::ffff:211.193.35.12',
      '::1',
      '127.0.0.1',
      ' 211.193.35.11',
    ]) {
      expect({ ip, allowed: isAllowedNotifyAddress(ip, stg) }).toEqual({ ip, allowed: false });
    }
    expect(isAllowedNotifyAddress('211.193.35.11', [])).toBe(false);
  });
});

describe('result codes', () => {
  it('counts every PayMethod success code as approved, and nothing else', () => {
    for (const code of ['3001', '4000', 'A000', 'KP00', 'NP00', 'PP00', 'LP00', 'PI00', '0000']) {
      expect({ code, ok: isApprovalSuccess(code) }).toEqual({ code, ok: true });
    }
    // Virtual-account issued/paid, the card minimum, a cancel code, nothing at all.
    for (const code of ['4100', '4110', '3041', '2001', '', undefined]) {
      expect({ code, ok: isApprovalSuccess(code) }).toEqual({ code, ok: false });
    }
  });

  it("tells an approval answer that is the PG's own failure from a decline", () => {
    // The 통합코드 table's system, connection and internal errors: the card may be charged.
    for (const code of [
      '9999',
      'W999',
      'W027',
      'W028',
      'W029',
      'W030',
      'W051',
      'W038',
      'W299',
      'NP98',
      'NP99',
      'LP99',
      'PI19',
      'PI51',
      '6001',
      '1032',
      '1101',
      '9998',
    ]) {
      expect({ code, unknown: isApprovalUnknown(code) }).toEqual({ code, unknown: true });
    }
    // Declines (the card company, its VAN or the easy-pay said no — 3002 and 3095 included), the
    // inquiry's own failures, a success, nothing at all.
    for (const code of [
      '3011',
      '3002',
      '3095',
      'KP01',
      'NP01',
      'PP01',
      '6017',
      'W036',
      '3001',
      '',
      undefined,
    ]) {
      expect({ code, unknown: isApprovalUnknown(code) }).toEqual({ code, unknown: false });
    }
    // No code is both.
    expect(APPROVAL_UNKNOWN_CODES.filter((code) => isApprovalSuccess(code))).toEqual([]);
  });

  it('classifies a cancel answer by its code and the payment method', () => {
    const cases: [string | undefined, string | null | undefined, string][] = [
      // Cancelled (or already cancelled) whatever the method.
      ['2001', 'CARD', 'cancelled'],
      ['2013', 'CARD', 'cancelled'],
      ['2013', null, 'cancelled'],
      ['NP17', 'NAVER', 'cancelled'],
      ['LP17', 'LPAY', 'cancelled'],
      ['PI15', 'PINPAY', 'cancelled'],
      // 2015 is 기취소 only for SmilePay; for a card it is an ordinary 취소 실패.
      ['2015', 'SMILEPAY', 'cancelled'],
      ['2015', 'smilepay', 'cancelled'],
      ['2015', 'CARD', 'refused'],
      ['2015', null, 'refused'],
      ['3402', 'TMONEYPAY', 'cancelled'],
      ['3402', 'CARD', 'refused'],
      // The card may or may not be cancelled: never a refusal.
      ['NP19', 'NAVER', 'unknown'],
      ['NP24', 'NAVER', 'unknown'],
      ['LP19', 'LPAY', 'unknown'],
      ['LP24', 'LPAY', 'unknown'],
      ['2045', 'CARD', 'unknown'],
      ['NP98', 'NAVER', 'unknown'],
      ['NP99', 'NAVER', 'unknown'],
      ['LP99', 'LPAY', 'unknown'],
      ['9999', 'CARD', 'unknown'],
      ['1101', 'SMILEPAY', 'unknown'],
      ['9998', 'SMILEPAY', 'unknown'],
      ['1101', 'CARD', 'refused'],
      [undefined, 'CARD', 'unknown'],
      ['', 'CARD', 'unknown'],
      ['  ', 'CARD', 'unknown'],
      // A definite no.
      ['2002', 'CARD', 'refused'],
      ['2016', 'CARD', 'refused'],
      ['2024', undefined, 'refused'],
      ['3001', 'CARD', 'refused'],
    ];
    for (const [code, method, expected] of cases) {
      expect({ code, method, status: classifyCancel(code, method) }).toEqual({
        code,
        method,
        status: expected,
      });
    }
  });
});
