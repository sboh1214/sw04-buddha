import { smartroPaymentFormSchema, type SmartroPaymentForm } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_FIELD_NAMES,
  SMARTRO_CALLBACK_GRACE_MS,
  SMARTRO_FORM_ID,
  SMARTRO_MOBILE_UA,
  SMARTRO_WRAPPER_ID,
  approvalAction,
  approvalFields,
  isSmartroMobile,
  smartroFormFields,
  smartroScriptUrl,
} from './smartro-sdk';

const UA = {
  iPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iPadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  iPod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  android:
    'Mozilla/5.0 (Linux; Android 15; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  samsungBrowser:
    'Mozilla/5.0 (Linux; Android 14; SM-A546S) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
} as const;

const SCRIPT_URL = {
  pc: 'https://tpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
  mobile: 'https://tmpay.smartropay.co.kr/asset/js/SmartroPAY-1.0.min.js?version=20260928',
};

describe('the SDK build a browser loads', () => {
  it("is the SDK's own phone regex, verbatim", () => {
    // SmartroPAY-1.0 `common.isMobile`: `/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)`.
    // Each build carries its own host/mode check and flow code, and the SDK picks the flow with
    // this regex: any drift and the page loads the build made for the flow the SDK does NOT run.
    expect(SMARTRO_MOBILE_UA.source).toBe('iPhone|iPad|iPod|Android');
    expect(SMARTRO_MOBILE_UA.flags).toBe('i');
  });

  it('gives phones and tablets the mobile build', () => {
    for (const ua of [UA.iPhone, UA.iPadLegacy, UA.iPod, UA.android, UA.samsungBrowser]) {
      expect(isSmartroMobile(ua), ua).toBe(true);
      expect(smartroScriptUrl(SCRIPT_URL, ua), ua).toBe(SCRIPT_URL.mobile);
    }
    // Case-insensitive, as the SDK's.
    expect(isSmartroMobile('some android webview')).toBe(true);
  });

  it('gives everything else the PC build — iPadOS Safari included, as the SDK decides', () => {
    // iPadOS 13+ Safari sends a Macintosh user agent; the SDK then runs the PC layer, so the
    // page must load the PC build for it too.
    for (const ua of [UA.desktopChrome, UA.macSafari, '']) {
      expect(isSmartroMobile(ua), ua).toBe(false);
      expect(smartroScriptUrl(SCRIPT_URL, ua), ua).toBe(SCRIPT_URL.pc);
    }
  });
});

describe('the page elements the SDK relies on', () => {
  it('names the form and the layer as the SDK does', () => {
    expect(SMARTRO_FORM_ID).toBe('tranMgr');
    expect(SMARTRO_WRAPPER_ID).toBe('smartropay-wrapper');
  });

  it('waits longer than the 500 ms the SDK waits before its callback', () => {
    expect(SMARTRO_CALLBACK_GRACE_MS).toBeGreaterThan(500);
  });
});

const FORM: SmartroPaymentForm = {
  PayMethod: 'CARD',
  GoodsCnt: '1',
  GoodsName: '포인트 10,000P',
  Amt: '9900',
  Moid: '0123456789abcdef0123456789abcdef',
  Mid: 'buddha0001',
  ReturnUrl:
    'https://buddha.sboh.dev/api/v1/payments/smartro/return?m=0123456789abcdef0123456789abcdef',
  StopUrl:
    'https://buddha.sboh.dev/api/v1/payments/smartro/stop?m=0123456789abcdef0123456789abcdef',
  BuyerName: '홍길동',
  BuyerTel: '01012345678',
  BuyerEmail: '',
  EdiDate: '20260928093000',
  EncryptData: 'c2lnbmF0dXJl',
  TaxAmt: '9000',
  TaxFreeAmt: '0',
  VatAmt: '900',
  MallUserId: '0123456789abcdef0123',
};

describe('smartroFormFields', () => {
  it('renders every request field of the contract, with its value, in the contract order', () => {
    const fields = smartroFormFields(FORM);
    expect(fields.map(([name]) => name)).toEqual(Object.keys(smartroPaymentFormSchema.shape));
    expect(Object.fromEntries(fields)).toEqual(FORM);
    // An empty BuyerEmail stays an (empty) input: the SDK treats a missing and an empty field
    // alike, and the signature does not cover it.
    expect(fields).toContainEqual(['BuyerEmail', '']);
  });

  it('never renders a field the contract does not name', () => {
    // The SDK posts every input of the form to SmartroPay; an answer that grew a field must
    // not grow the request with it.
    const grown = { ...FORM, Surprise: 'x' } as SmartroPaymentForm;
    expect(smartroFormFields(grown).map(([name]) => name)).not.toContain('Surprise');
  });
});

describe('approvalFields', () => {
  it("posts the callback's authentication as the ReturnUrl reads it", () => {
    expect(
      approvalFields({
        Tid: 'tid123',
        TrAuthKey: 'auth456',
        ResultCode: '0000',
        ResultMsg: '인증 성공',
        Other: 'ignored',
      }),
    ).toEqual({ Tid: 'tid123', TrAuthKey: 'auth456', ResultCode: '0000', ResultMsg: '인증 성공' });
    expect(APPROVAL_FIELD_NAMES).toEqual(['Tid', 'TrAuthKey', 'ResultCode', 'ResultMsg']);
  });

  it('posts a missing or odd field empty, which the API reads as absent', () => {
    // No TrAuthKey: the API closes the payment as failed with ResultMsg as its reason.
    expect(approvalFields({ Tid: 'tid123', ResultMsg: '사용자 취소' })).toEqual({
      Tid: 'tid123',
      TrAuthKey: '',
      ResultCode: '',
      ResultMsg: '사용자 취소',
    });
    expect(approvalFields({ Tid: 42, TrAuthKey: { nested: true }, ResultCode: null })).toEqual({
      Tid: '42',
      TrAuthKey: '',
      ResultCode: '',
      ResultMsg: '',
    });
    for (const data of [undefined, null, 'Tid=1', 7]) {
      expect(approvalFields(data)).toEqual({
        Tid: '',
        TrAuthKey: '',
        ResultCode: '',
        ResultMsg: '',
      });
    }
  });
});

describe('approvalAction', () => {
  const RETURN_URL =
    'https://buddha.sboh.dev/api/v1/payments/smartro/return?m=0123456789abcdef0123456789abcdef';

  it("posts to the ReturnUrl's path and query on the page's own origin", () => {
    const action = approvalAction(RETURN_URL);
    expect(action).toBe('/api/v1/payments/smartro/return?m=0123456789abcdef0123456789abcdef');
    // Resolved by the browser against the page, whatever origin the API spelled: a page opened
    // on 127.0.0.1 posts to 127.0.0.1, which `form-action 'self'` lets through.
    for (const page of ['https://buddha.sboh.dev/wallet', 'http://127.0.0.1:3000/wallet']) {
      const posted = new URL(action, page);
      expect(posted.origin, page).toBe(new URL(page).origin);
      expect(`${posted.pathname}${posted.search}`).toBe(action);
    }
    expect(approvalAction('http://localhost:3000/api/v1/payments/smartro/return?m=ab#x')).toBe(
      '/api/v1/payments/smartro/return?m=ab',
    );
  });

  it('keeps a relative value on this origin, and never lets it become another origin', () => {
    expect(approvalAction('/api/v1/payments/smartro/return?m=ab')).toBe(
      '/api/v1/payments/smartro/return?m=ab',
    );
    // `//host/…` and `/\host/…` read as scheme-relative in a page: folded into one slash.
    for (const value of [
      'https://buddha.sboh.dev//evil.example/return?m=ab',
      '//evil.example/return?m=ab',
      '/\\evil.example/return?m=ab',
    ]) {
      const action = approvalAction(value);
      expect(action, value).toMatch(/^\/[^/\\]/);
      expect(new URL(action, 'https://buddha.sboh.dev/wallet').origin, value).toBe(
        'https://buddha.sboh.dev',
      );
    }
  });
});
