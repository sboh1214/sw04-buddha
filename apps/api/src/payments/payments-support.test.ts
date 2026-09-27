/**
 * The small pure pieces around the providers: the payments configuration built from the env,
 * what `payment_events.payload` may keep, and how a callback's form is read.
 */
import { type RawBodyRequest } from '@nestjs/common';
import { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { resultMessageOf, sanitizePayload } from './payment-events.js';
import { paymentsConfigFromEnv } from './payments-config.js';
import { field, readCallback } from './smartro/callback-form.js';

describe('paymentsConfigFromEnv', () => {
  const base = {
    PAYMENT_PROVIDER: 'mock',
    SMARTRO_MODE: 'STG',
    SMARTRO_MID: undefined,
    SMARTRO_MERCHANT_KEY: undefined,
    SMARTRO_CANCEL_PASSWORD: undefined,
    SMARTRO_APPROVAL_BASE_URL: undefined,
    BETTER_AUTH_URL: 'https://Buddha.sboh.dev/some/path',
  } as const;
  const credentials = {
    SMARTRO_MID: 'mid0000001',
    SMARTRO_MERCHANT_KEY: 'k'.repeat(40),
    SMARTRO_CANCEL_PASSWORD: 'pw',
  } as const;

  it('has no SmartroPay without its credentials, and the web origin of BETTER_AUTH_URL', () => {
    expect(paymentsConfigFromEnv(base)).toEqual({
      provider: 'mock',
      smartro: null,
      webOrigin: 'https://buddha.sboh.dev',
    });
    // One key short is still no SmartroPay (env.ts refuses that pairing under smartro).
    expect(
      paymentsConfigFromEnv({ ...base, ...credentials, SMARTRO_CANCEL_PASSWORD: undefined })
        .smartro,
    ).toBeNull();
  });

  it('keeps SmartroPay configured under the mock, for callbacks and refunds of its payments', () => {
    expect(paymentsConfigFromEnv({ ...base, ...credentials }).smartro).toEqual({
      mode: 'STG',
      mid: 'mid0000001',
      merchantKey: 'k'.repeat(40),
      cancelPassword: 'pw',
      approvalBaseUrl: 'https://tapproval.smartropay.co.kr',
      notifyIps: ['211.193.35.11'],
    });
  });

  it('picks the approval host by mode unless overridden', () => {
    const real = paymentsConfigFromEnv({
      ...base,
      ...credentials,
      PAYMENT_PROVIDER: 'smartro',
      SMARTRO_MODE: 'REAL',
    });
    expect(real.provider).toBe('smartro');
    expect(real.smartro?.approvalBaseUrl).toBe('https://approval.smartropay.co.kr');
    const local = paymentsConfigFromEnv({
      ...base,
      ...credentials,
      SMARTRO_APPROVAL_BASE_URL: 'http://127.0.0.1:4010',
    });
    expect(local.smartro?.approvalBaseUrl).toBe('http://127.0.0.1:4010');
  });

  it("takes the 재통보 from the mode's servers, from anywhere only for a local fake PG", () => {
    const stg = paymentsConfigFromEnv({ ...base, ...credentials });
    expect(stg.smartro?.notifyIps).toEqual(['211.193.35.11']);
    const real = paymentsConfigFromEnv({ ...base, ...credentials, SMARTRO_MODE: 'REAL' });
    // The two 재통보 servers, and the payment server to be safe; never STG's.
    expect(real.smartro?.notifyIps).toEqual(['211.193.35.216', '211.193.35.217', '211.193.35.20']);
    // The override is how a local fake PG is wired (config/env.ts refuses it in production); the
    // fake posts its notices from wherever it runs, so the check is off.
    for (const mode of ['STG', 'REAL'] as const) {
      const local = paymentsConfigFromEnv({
        ...base,
        ...credentials,
        SMARTRO_MODE: mode,
        SMARTRO_APPROVAL_BASE_URL: 'http://127.0.0.1:4010',
      });
      expect(local.smartro?.notifyIps).toBeNull();
    }
  });

  it('refuses to boot SmartroPay on an origin too long for its 100-character ReturnUrl', () => {
    // An origin of 34 + /api/v1/payments/smartro/return?m= (34) + 32 Moid digits = 100: fits.
    const fits = `https://${'a'.repeat(22)}.dev`;
    expect(
      paymentsConfigFromEnv({ ...base, ...credentials, BETTER_AUTH_URL: fits }).webOrigin,
    ).toBe(fits);
    const tooLong = `https://${'a'.repeat(23)}.dev`;
    expect(() =>
      paymentsConfigFromEnv({ ...base, ...credentials, BETTER_AUTH_URL: tooLong }),
    ).toThrow(/return URL would be 101 characters/);
    // Without SmartroPay no URL is ever built, so the origin is not its concern.
    expect(paymentsConfigFromEnv({ ...base, BETTER_AUTH_URL: tooLong }).smartro).toBeNull();
  });
});

describe('sanitizePayload', () => {
  it('drops secrets and personal fields, keeps the rest', () => {
    expect(
      sanitizePayload({
        Tid: 't',
        TrAuthKey: 'kept on purpose: the one-hour inquiry needs it',
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
      TrAuthKey: 'kept on purpose: the one-hour inquiry needs it',
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

  it('turns an empty PG message into null', () => {
    expect(resultMessageOf(undefined)).toBeNull();
    expect(resultMessageOf('  ')).toBeNull();
    expect(resultMessageOf(' 한도 초과\u0000 ')).toBe('한도 초과');
  });
});

describe('readCallback', () => {
  const request = (init: {
    body?: string;
    contentType?: string;
    query?: Record<string, unknown>;
  }): RawBodyRequest<FastifyRequest> =>
    ({
      headers: init.contentType === undefined ? {} : { 'content-type': init.contentType },
      rawBody: init.body === undefined ? undefined : Buffer.from(init.body, 'utf8'),
      query: init.query ?? {},
    }) as unknown as RawBodyRequest<FastifyRequest>;

  it('decodes a UTF-8 form body and takes m from the query', () => {
    const { moid, fields } = readCallback(
      request({
        body: 'Tid=T1&TrAuthKey=a%2Bb%3D&ResultMsg=%EC%A0%95%EC%83%81&Tid=T2&__proto__=x',
        contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        query: { m: 'abc' },
      }),
    );
    expect(moid).toBe('abc');
    expect(fields.get('Tid')).toBe('T1'); // the first value wins
    expect(fields.get('TrAuthKey')).toBe('a+b=');
    expect(fields.get('ResultMsg')).toBe('정상');
    expect(fields.get('__proto__')).toBe('x'); // a Map: no prototype to pollute
  });

  it('ignores a body that is not a form, and reads the query of a GET stop', () => {
    const json = readCallback(request({ body: '{"Tid":"T1"}', contentType: 'application/json' }));
    expect([...json.fields]).toEqual([]);
    const link = readCallback(request({ query: { m: ['first', 'second'], ResultMsg: '중단' } }));
    expect(link.moid).toBe('first');
    expect(field(link.fields, 'ResultMsg')).toBe('중단');
    expect(field(link.fields, 'Missing', 'ResultMsg')).toBe('중단');
    expect(field(link.fields, 'Missing')).toBeUndefined();
  });
});
