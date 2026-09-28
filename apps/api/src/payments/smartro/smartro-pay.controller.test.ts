/**
 * SmartroPay 일반연동 end to end (ADR-0042, DESIGN §5.2-5.5) against the docker `test` profile,
 * with a fake PG in place of the HTTP client: prepare → the payment window's ReturnUrl →
 * approval → credit, and the StopUrl and 재통보 around it. Skips when TEST_* are unset (fails
 * under CI=true, see the harness).
 */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { schema } from '@buddha/db';
import {
  SIGNUP_BONUS_P,
  paymentIdToMoid,
  userChannel,
  type Payment,
  type PaymentProviderInfo,
  type PaymentStatus,
  type SmartroPrepareResult,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { type LightMyRequestResponse as InjectResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chargeBody,
  chargeHeaders,
  createTestApp,
  createTestContact,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestPackage,
  type TestUser,
} from '../../test/app.js';
import { expectLedgerChain } from '../../test/ledger.js';
import { hasTestInfra } from '../../test/setup-env.js';
import {
  FORM_HEADERS,
  FakeSmartroClient,
  TEST_NOTIFY_IP,
  TEST_SMARTRO,
  TEST_WEB_ORIGIN,
  approvalAnswer,
  formBody,
  notifyForm,
  reserveSmartroPayment,
  testSignValue,
  testTid,
} from '../../test/smartro.js';
import { sleep } from '../../test/wait.js';
import { WalletService } from '../../wallet/wallet.service.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments-config.js';
import { type SmartroResponse, SmartroUnreachableError } from './smartro-client.js';
import { SMARTRO_NOTIFY_IPS } from './smartro-protocol.js';

const sha256Base64 = (text: string) => createHash('sha256').update(text).digest('base64');

describe.skipIf(!hasTestInfra)('SmartroPay (integration)', () => {
  let t: TestApp;
  const pg = new FakeSmartroClient();
  let user: TestUser;
  /** 10,000P for 9,700원: VatAmt floor(9700 / 11) = 881, TaxAmt 8819. */
  let pack: TestPackage;

  beforeAll(async () => {
    // Several prepares per account per test; the shipped 10/min is rate-limit.controller's.
    t = await createTestApp({ smartro: { client: pg }, rateLimits: { charge: 500 } });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    pg.reset();
    user = await signUpTestUser(t);
    pack = await createTestPackage(t.db);
    await createTestContact(t.db, user.id, { realName: '홍길동', phone: '01012345678' });
  });

  const prepare = (
    idempotencyKey?: string,
    body: Record<string, unknown> = chargeBody(pack, user.id),
    as: TestUser = user,
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/prepare',
      headers: chargeHeaders(as.cookie, idempotencyKey),
      payload: body,
    });

  async function prepared(idempotencyKey?: string): Promise<SmartroPrepareResult> {
    const res = await prepare(idempotencyKey);
    expect(res.statusCode).toBe(200);
    return res.json<{ data: SmartroPrepareResult }>().data;
  }

  /** The browser posting the window's result to our ReturnUrl (PC approvalForm or mobile). */
  const postReturn = (moid: string, fields: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/smartro/return?m=${moid}`,
      headers: FORM_HEADERS,
      payload: formBody(fields),
    });

  /** SmartroPay's server posting a 재통보: from its STG address unless `remoteAddress` says. */
  const postNotify = (fields: Record<string, string>, remoteAddress: string = TEST_NOTIFY_IP) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: FORM_HEADERS,
      payload: formBody(fields),
      remoteAddress,
    });

  /** Where a callback sent the browser: always a 303 to the web wallet. */
  function redirectOf(res: InjectResponse): { payment: string | null; result: string | null } {
    expect(res.statusCode).toBe(303);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe(`${TEST_WEB_ORIGIN}/wallet`);
    return {
      payment: location.searchParams.get('payment'),
      result: location.searchParams.get('result'),
    };
  }

  async function paymentRow(id: string) {
    const [row] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, id));
    return row!;
  }

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row!;
  }

  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  async function eventsOf(paymentId: string) {
    return t.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.paymentId, paymentId))
      .orderBy(asc(schema.paymentEvents.id));
  }

  /** Scripts the fake PG to approve `paymentId` under `tid` (optionally forging a field). */
  function approveWith(
    form: SmartroPrepareResult,
    tid: string,
    options: { resultCode?: string; resultMsg?: string; overrides?: Record<string, unknown> } = {},
  ) {
    pg.onApprove = () =>
      approvalAnswer({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid, ...options });
  }

  // --- provider switch -----------------------------------------------------------------

  it('announces SmartroPay with its STG SDK URLs (GET /payments/provider)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/payments/provider' });
    expect(res.statusCode).toBe(200);
    const info = res.json<{ data: PaymentProviderInfo }>().data;
    expect(info).toMatchObject({ provider: 'smartro', mode: 'STG' });
    if (info.provider !== 'smartro') throw new Error('unreachable');
    expect(info.scriptUrl.pc).toMatch(
      /^https:\/\/tpay\.smartropay\.co\.kr\/asset\/js\/SmartroPAY-1\.0\.min\.js\?version=\d{8}$/,
    );
    expect(info.scriptUrl.mobile).toMatch(/^https:\/\/tmpay\.smartropay\.co\.kr\//);
  });

  it('closes the immediate charge while SmartroPay is the provider (404)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(user.cookie),
      payload: chargeBody(pack, user.id),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await t.db.select().from(schema.payments)).toHaveLength(0);
  });

  // --- prepare -------------------------------------------------------------------------

  it('reserves a pending payment and signs the window form for it', async () => {
    const form = await prepared();
    const moid = paymentIdToMoid(form.paymentId);
    const returnUrl = `${TEST_WEB_ORIGIN}/api/v1/payments/smartro/return?m=${moid}`;
    expect(form).toMatchObject({ mode: 'STG', approvalUrl: returnUrl });
    expect(form.form).toMatchObject({
      PayMethod: 'CARD',
      GoodsCnt: '1',
      GoodsName: '포인트 10,000P',
      Amt: '9700',
      Moid: moid,
      Mid: TEST_SMARTRO.mid,
      ReturnUrl: returnUrl,
      StopUrl: `${TEST_WEB_ORIGIN}/api/v1/payments/smartro/stop?m=${moid}`,
      BuyerName: '홍길동',
      BuyerTel: '01012345678',
      BuyerEmail: user.email,
      TaxAmt: '8819',
      VatAmt: '881',
      TaxFreeAmt: '0',
    });
    expect(form.form.ReturnUrl.length).toBeLessThanOrEqual(100);
    expect(form.form.EdiDate).toMatch(/^\d{14}$/);
    expect(form.form.EncryptData).toBe(
      sha256Base64(`${form.form.EdiDate}${TEST_SMARTRO.mid}9700${TEST_SMARTRO.merchantKey}`),
    );
    expect(form.form.MallUserId).toMatch(/^[0-9a-f]{20}$/);
    expect(form.form.MallUserId).not.toContain(user.id);

    expect(await paymentRow(form.paymentId)).toMatchObject({
      userId: user.id,
      provider: 'smartro',
      status: 'pending',
      providerRef: null,
      amountP: 10_000n,
      priceKrw: 9_700,
      packageId: pack.id,
    });
    // Nothing moves before the PG approves.
    expect(await ledgerOf(user.id)).toHaveLength(1); // the sign-up bonus
  });

  it('re-signs the same payment for a re-sent key, and spends the key once it moved on', async () => {
    const key = 'smartro-prepare-key-1';
    const first = await prepared(key);
    const again = await prepared(key);
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.form.EncryptData).toBe(
      sha256Base64(`${again.form.EdiDate}${TEST_SMARTRO.mid}9700${TEST_SMARTRO.merchantKey}`),
    );
    expect(await t.db.select().from(schema.payments)).toHaveLength(1);

    // Same key, other terms: the key is spent (no details).
    const other = await prepare(key, { ...chargeBody(pack, user.id), expectedPriceKrw: 9_600 });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ error: { code: string; details?: unknown } }>().error).toEqual(
      expect.objectContaining({ code: 'DUPLICATE_REQUEST' }),
    );
    expect(other.json<{ error: { details?: unknown } }>().error.details).toBeUndefined();

    // Once an approval claimed the payment the key opens nothing any more.
    await t.db
      .update(schema.payments)
      .set({ providerRef: testTid() })
      .where(eq(schema.payments.id, first.paymentId));
    const claimed = await prepare(key);
    expect(claimed.statusCode).toBe(409);
    expect(claimed.json()).toMatchObject({ error: { code: 'DUPLICATE_REQUEST' } });
  });

  it('requires the real name and mobile number first (CONTACT_REQUIRED)', async () => {
    await t.db.delete(schema.userContacts).where(eq(schema.userContacts.userId, user.id));
    const res = await prepare();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'CONTACT_REQUIRED' } });
    expect(await t.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses a re-priced package (PRICE_MOVED) and one below the card minimum', async () => {
    const moved = await prepare(undefined, {
      ...chargeBody(pack, user.id),
      expectedPriceKrw: 9_600,
    });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: { code: 'PRICE_MOVED' } });

    const cheap = await createTestPackage(t.db, { amountP: 1_000n, priceKrw: 900 });
    const below = await prepare(undefined, chargeBody(cheap, user.id));
    expect(below.statusCode).toBe(400);
    expect(below.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['packageId'] }] },
    });
    expect(await t.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('leaves BuyerEmail empty for an account without a real mailbox', async () => {
    await t.db
      .update(schema.user)
      .set({ email: `kakao_${String(Date.now())}@noemail.buddha.local` })
      .where(eq(schema.user.id, user.id));
    expect((await prepared()).form.BuyerEmail).toBe('');
  });

  // --- ReturnUrl -----------------------------------------------------------------------

  it('approves, verifies and credits once, storing the approval Tid (and publishes the balance)', async () => {
    const form = await prepared();
    const authTid = testTid();
    const approvedTid = testTid(); // the approval may answer with another Tid (manual STEP 4)
    approveWith(form, approvedTid);

    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(user.id));
    try {
      const res = await postReturn(form.form.Moid, { Tid: authTid, TrAuthKey: 'auth-key-1' });
      expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'succeeded' });
      expect(pg.approvals).toEqual([{ Tid: authTid, TrAuthKey: 'auth-key-1' }]);

      const ledger = await ledgerOf(user.id);
      const deposit = ledger.find((entry) => entry.type === 'DEPOSIT')!;
      expect(deposit).toMatchObject({
        amountP: 10_000n,
        refType: 'payment',
        refId: form.paymentId,
      });
      const payment = await paymentRow(form.paymentId);
      expect(payment).toMatchObject({
        status: 'succeeded',
        providerRef: approvedTid,
        method: 'CARD',
        resultMessage: '카드 결제 성공',
      });
      expect(payment.approvedAt?.getTime()).toBe(deposit.createdAt.getTime());
      expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);

      const started = Date.now();
      while (received.length < 1 && Date.now() - started < 5_000) await sleep(20);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'user:balance',
          availableP: (SIGNUP_BONUS_P + 10_000n).toString(),
          lockedP: '0',
          ledgerEntryId: deposit.id.toString(),
          ts: deposit.createdAt.toISOString(),
        },
      ]);
    } finally {
      await subscriber.quit();
    }

    // The PG history, secrets and personal data left out.
    const events = await eventsOf(form.paymentId);
    expect(events.map((event) => [event.type, event.resultCode])).toEqual([
      ['return', null],
      ['approval', '3001'],
    ]);
    expect(events[0]!.payload).toEqual({ Tid: authTid, TrAuthKey: 'auth-key-1' });
    expect(events[1]!.payload).toMatchObject({
      Tid: approvedTid,
      Amt: '9700',
      SomethingNew: 'ignored',
    });
    expect(events[1]!.payload).not.toHaveProperty('BuyerName');
    expect(events[1]!.payload).not.toHaveProperty('BuyerTel');

    // The wallet reads the outcome back (GET /me/payments/:id).
    const own = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/payments/${form.paymentId}`,
      headers: { cookie: user.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ data: Payment }>().data).toMatchObject({
      id: form.paymentId,
      provider: 'smartro',
      status: 'succeeded',
      method: 'CARD',
      providerRef: approvedTid,
      refundedAt: null,
    });

    // A second submit of the same form (the back button) answers without approving again.
    const again = await postReturn(form.form.Moid, { Tid: authTid, TrAuthKey: 'auth-key-1' });
    expect(redirectOf(again).result).toBe('succeeded');
    expect(pg.approvals).toHaveLength(1);
  });

  it("takes the mobile flow's cross-site ReturnUrl and StopUrl posts (a foreign Origin, a cookie)", async () => {
    // On a phone, SmartroPay's own page (tmpay/mpay) posts the form to our URLs: cross-site,
    // with its Origin (or `null` from a sandboxed or redirected context). The callbacks sit
    // outside SessionGuard's Origin check, and must stay there; a cookie changes nothing.
    for (const origin of ['https://tmpay.smartropay.co.kr', 'null']) {
      const approved = await prepared();
      const tid = testTid();
      approveWith(approved, tid);
      const returned = await t.app.inject({
        method: 'POST',
        url: `/api/v1/payments/smartro/return?m=${approved.form.Moid}`,
        headers: { ...FORM_HEADERS, origin, cookie: user.cookie },
        payload: formBody({ Tid: tid, TrAuthKey: 'k' }),
      });
      expect({ origin, redirect: redirectOf(returned) }).toEqual({
        origin,
        redirect: { payment: approved.paymentId, result: 'succeeded' },
      });
      expect(await paymentRow(approved.paymentId)).toMatchObject({ status: 'succeeded' });

      const stopped = await prepared();
      const stop = await t.app.inject({
        method: 'POST',
        url: `/api/v1/payments/smartro/stop?m=${stopped.form.Moid}`,
        headers: { ...FORM_HEADERS, origin, cookie: user.cookie },
        payload: formBody({ ResultCode: 'W002', ResultMsg: '사용자 결제 중단' }),
      });
      expect({ origin, redirect: redirectOf(stop) }).toEqual({
        origin,
        redirect: { payment: stopped.paymentId, result: 'stopped' },
      });
      expect(await paymentRow(stopped.paymentId)).toMatchObject({ status: 'failed' });
    }
    expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 20_000n);
  });

  it('stores only the known fields of a callback, and nothing for one that changes nothing', async () => {
    // The ReturnUrl and StopUrl are public, and payment_events is append-only: whoever knows a
    // Moid may post to them as often as the rate limit lets, with any fields they like.
    const junk = { Junk: 'x'.repeat(400), BuyerName: '홍길동', SignValue: 'not-kept' };
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid);
    const res = await postReturn(form.form.Moid, {
      Tid: tid,
      TrAuthKey: 'k',
      Moid: form.form.Moid,
      ...junk,
    });
    expect(redirectOf(res).result).toBe('succeeded');
    const settled = await eventsOf(form.paymentId);
    expect(settled.map((event) => event.type)).toEqual(['return', 'approval']);
    expect(settled[0]!.payload).toEqual({ Tid: tid, TrAuthKey: 'k', Moid: form.form.Moid });

    // Settled: re-posting the return, or stopping it, redirects and stores nothing.
    for (let i = 0; i < 3; i += 1) {
      expect(
        redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result,
      ).toBe('succeeded');
      const stop = await t.app.inject({
        method: 'GET',
        url: `/api/v1/payments/smartro/stop?m=${form.form.Moid}&k1=${'y'.repeat(400)}`,
      });
      expect(redirectOf(stop).result).toBe('succeeded');
    }
    // Claimed and still pending (another request is approving it): nothing either.
    const claimed = await prepared();
    await t.db
      .update(schema.payments)
      .set({ providerRef: testTid() })
      .where(eq(schema.payments.id, claimed.paymentId));
    expect(redirectOf(await postReturn(claimed.form.Moid, { ResultMsg: 'x' })).result).toBe(
      'pending',
    );
    expect(await eventsOf(form.paymentId)).toHaveLength(2);
    expect(await eventsOf(claimed.paymentId)).toHaveLength(0);
    expect(pg.approvals).toHaveLength(1);

    // A stop that does close a payment keeps its known fields only.
    const stopped = await prepared();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/smartro/stop?m=${stopped.form.Moid}`,
      headers: FORM_HEADERS,
      payload: formBody({ ResultCode: 'W002', ResultMsg: '사용자 결제 중단', ...junk }),
    });
    const [stopEvent] = await eventsOf(stopped.paymentId);
    expect(stopEvent).toMatchObject({ type: 'stop', resultCode: 'W002' });
    expect(stopEvent!.payload).toEqual({ ResultCode: 'W002', ResultMsg: '사용자 결제 중단' });
  });

  it('lets exactly one of two concurrent submits approve (the other answers pending)', async () => {
    const form = await prepared();
    const tid = testTid();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pg.onApprove = async () => {
      await gate;
      return approvalAnswer({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid });
    };
    const auth = { Tid: tid, TrAuthKey: 'auth-key-2' };

    // light-my-request dispatches lazily: `.then` is what sends the request.
    const first = postReturn(form.form.Moid, auth).then((res) => res);
    await vi.waitFor(() => {
      expect(pg.approvals).toHaveLength(1);
    });
    const second = await postReturn(form.form.Moid, auth);
    expect(redirectOf(second).result).toBe('pending');
    release();
    expect(redirectOf(await first).result).toBe('succeeded');

    expect(pg.approvals).toHaveLength(1);
    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it('fails a refused approval with the PG message, crediting nothing', async () => {
    const form = await prepared();
    approveWith(form, testTid(), { resultCode: '3057', resultMsg: '한도초과' });
    const res = await postReturn(form.form.Moid, { Tid: testTid(), TrAuthKey: 'k' });
    expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'failed' });
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'failed',
      resultMessage: '한도초과',
    });
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect(pg.cancels).toHaveLength(0);
  });

  it("fails an approval that answers the PG's own failure too, and says the card may be charged", async () => {
    // DESIGN §5.4 step 6 (owner decision): any non-success fails. 9999 is no decline, though —
    // the admin list flags the payment (payment-settle's suite), and this shouts.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const form = await prepared();
      const tid = testTid();
      approveWith(form, tid, { resultCode: '9999', resultMsg: '시스템에러 - 잠시 후 재거래' });
      const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
      expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'failed' });
      expect(await paymentRow(form.paymentId)).toMatchObject({
        status: 'failed',
        providerRef: tid,
        resultMessage: '시스템에러 - 잠시 후 재거래',
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("answered 9999, the PG's own failure rather than a decline"),
      );

      // A decline says nothing more.
      error.mockClear();
      const declined = await prepared();
      const declinedTid = testTid();
      approveWith(declined, declinedTid, { resultCode: '3011', resultMsg: '카드번호 오류' });
      expect(
        redirectOf(await postReturn(declined.form.Moid, { Tid: declinedTid, TrAuthKey: 'k' }))
          .result,
      ).toBe('failed');
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect(pg.cancels).toHaveLength(0);
  });

  it('confirms a net cancel of an approval for another amount on its full cancel 재통보', async () => {
    // Approved for 5,000원 on a 9,700원 payment: net-cancelled for the 5,000 it approved, with
    // no clear answer. The PG's full cancel notice then carries 5,000 — the approval's amount,
    // which the net cancel recorded — so it confirms the cancel rather than reading as partial.
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { Amt: '5000' } });
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    expect(redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result).toBe(
      'pending',
    );
    expect(pg.cancels.map((cancel) => cancel.CancelAmt)).toEqual(['5000']);
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'unknown', cancelAmt: 5000 },
    });

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const notice = await postNotify(
        notifyForm({
          paymentId: form.paymentId,
          priceKrw: pack.priceKrw,
          tid,
          amt: '5000',
          resultCode: '2001',
          stateCd: '1',
        }),
      );
      expect(notice.body).toBe('OK');
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('partial cancel'));
    } finally {
      error.mockRestore();
    }
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });

    // Of a payment net-cancelled at its price, the same amount is a partial cancel still.
    const other = await prepared();
    const otherTid = testTid();
    approveWith(other, otherTid, { overrides: { SignValue: 'forged' } });
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    await postReturn(other.form.Moid, { Tid: otherTid, TrAuthKey: 'k' });
    expect((await eventsOf(other.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'unknown', cancelAmt: pack.priceKrw },
    });
    const partial = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await postNotify(
        notifyForm({
          paymentId: other.paymentId,
          priceKrw: pack.priceKrw,
          tid: otherTid,
          amt: '5000',
          resultCode: '2001',
          stateCd: '1',
        }),
      );
      expect(partial).toHaveBeenCalledWith(expect.stringContaining('reports a partial cancel'));
    } finally {
      partial.mockRestore();
    }
    expect((await eventsOf(other.paymentId)).at(-1)).toMatchObject({ type: 'notify' });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('reads the full cancel 재통보 of an approval whose net cancel the PG refused by what it approved', async () => {
    // Approved for 5,000원 on a 9,700원 payment: net-cancelled for those 5,000, which the PG
    // refuses — the payment is `pending` again, its one approval still charged. The operator then
    // cancels it in the merchant admin: the notice's 5,000 is the whole of that approval.
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { Amt: '5000' } });
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 불가' });
    expect(redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result).toBe(
      'pending',
    );
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'pending', providerRef: tid });
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'refused', cancelAmt: 5000 },
    });

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const notice = await postNotify(
        notifyForm({
          paymentId: form.paymentId,
          priceKrw: pack.priceKrw,
          tid,
          amt: '5000',
          resultCode: '2001',
          stateCd: '1',
        }),
      );
      expect(notice.body).toBe('OK');
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('partial cancel'));
    } finally {
      error.mockRestore();
    }
    // A full cancel of its one approval: closed, and confirmed so no approval notice credits it.
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'cancelled',
      resultMessage: '결제대행사 취소 통보에 따른 취소',
    });
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it("reads a full cancel 재통보 that beats its net cancel's answer by the approval it cancels", async () => {
    // Approved for 5,000원 on a 9,700원 payment: the net cancel of those 5,000 is still waiting on
    // the PG — no amount of it recorded yet — when the PG's cancel notice (Amt 5,000) arrives.
    // The approval's own answer on record says what is being cancelled: all of it.
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { Amt: '5000' } });
    let release!: (answer: SmartroResponse) => void;
    let cancelAsked!: () => void;
    const asked = new Promise<void>((resolve) => (cancelAsked = resolve));
    pg.onCancel = () => {
      cancelAsked();
      return new Promise<SmartroResponse>((resolve) => (release = resolve));
    };
    const returning = postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    await asked;
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'cancelled',
      providerRef: tid,
    });
    expect((await eventsOf(form.paymentId)).map((event) => event.type)).toEqual([
      'return',
      'approval',
    ]);

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const notice = await postNotify(
        notifyForm({
          paymentId: form.paymentId,
          priceKrw: pack.priceKrw,
          tid,
          amt: '5000',
          resultCode: '2001',
          stateCd: '1',
        }),
      );
      expect(notice.body).toBe('OK');
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('partial cancel'));
    } finally {
      error.mockRestore();
    }
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });

    // The net cancel's own answer then comes, and says the same.
    release({ ResultCode: '2001', ResultMsg: '취소 성공' });
    expect(redirectOf(await returning).result).toBe('cancelled');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it("reads a cancelled payment's cancel 재통보 by the approval under its own Tid only", async () => {
    // Net-cancelled under T (its approval answered 5,000원), the cancel's amount not recorded yet.
    // A result inquiry recorded after it found an approval under another Tid, for 7,000: not the
    // one the net cancel is cancelling, so not what a full cancel of T carries.
    const tid = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: tid });
    await t.db
      .update(schema.payments)
      .set({ status: 'cancelled' })
      .where(eq(schema.payments.id, payment.id));
    await t.db.insert(schema.paymentEvents).values([
      {
        paymentId: payment.id,
        type: 'approval',
        resultCode: '3001',
        payload: { ResultCode: '3001', Tid: tid, Amt: '5000' },
      },
      {
        paymentId: payment.id,
        type: 'approval_inquiry',
        resultCode: '3001',
        payload: { ResultCode: '3001', Tid: testTid(), Amt: '7000' },
      },
    ]);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const notice = await postNotify(
        notifyForm({
          paymentId: payment.id,
          priceKrw: payment.priceKrw,
          tid,
          amt: '5000',
          resultCode: '2001',
          stateCd: '1',
        }),
      );
      expect(notice.body).toBe('OK');
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('partial cancel'));
    } finally {
      error.mockRestore();
    }
    // A full cancel of T: the net cancel is confirmed.
    expect((await eventsOf(payment.id)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled', providerRef: tid });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('net-cancels an approval whose SignValue, Mid or Moid does not verify', async () => {
    for (const overrides of [
      { SignValue: testSignValue('forged-tid-0000000000000000000', '3001') },
      { Mid: 'othermid01' },
      { Moid: '0'.repeat(32) },
    ]) {
      pg.reset();
      const form = await prepared();
      const tid = testTid();
      approveWith(form, tid, { overrides });
      const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
      expect({ overrides, redirect: redirectOf(res) }).toEqual({
        overrides,
        redirect: { payment: form.paymentId, result: 'cancelled' },
      });
      expect(pg.cancels).toHaveLength(1);
      expect(pg.cancels[0]).toMatchObject({ Tid: tid, CancelAmt: '9700', PartialCancelCode: '0' });
      expect(await paymentRow(form.paymentId)).toMatchObject({
        status: 'cancelled',
        providerRef: tid,
        resultMessage: '가맹점 승인 처리 실패로 인한 자동 취소',
      });
    }
    // Nothing was ever credited.
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('net-cancels an approval of the wrong amount, for the amount actually approved', async () => {
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { Amt: '97' } });
    const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    expect(redirectOf(res).result).toBe('cancelled');
    // The whole cancel request as SmartroPay decrypts it (DESIGN §1): HashData, VAT, password.
    expect(pg.cancels).toEqual([
      {
        Tid: tid,
        Mid: TEST_SMARTRO.mid,
        CancelAmt: '97',
        CancelPwd: TEST_SMARTRO.cancelPassword,
        CancelMsg: expect.any(String) as string,
        CancelSeq: '1',
        PartialCancelCode: '0',
        HashData: sha256Base64(`${tid}${TEST_SMARTRO.merchantKey}970`),
        CancelTaxAmt: '89',
        CancelTaxFreeAmt: '0',
        CancelVatAmt: '8',
        outerMid: TEST_SMARTRO.mid,
      },
    ]);
    const events = await eventsOf(form.paymentId);
    expect(events.map((event) => event.type)).toEqual(['return', 'approval', 'net_cancel']);
    expect(events[2]).toMatchObject({ resultCode: '2001' });
    expect(events[2]!.payload).not.toHaveProperty('EncData');
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('net-cancels an approval whose credit fails, and keeps it pending if the cancel fails too', async () => {
    // The credit fails: the balance row is gone (a race with a DELETE).
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid);
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, user.id));
    const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    expect(redirectOf(res).result).toBe('cancelled');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    expect(pg.cancels).toHaveLength(1);

    // A cancel the PG refuses leaves the money in doubt: `pending`, for a person to settle.
    const second = await reserveSmartroPayment(t.db, user.id);
    const tid2 = testTid();
    pg.onApprove = () =>
      approvalAnswer({ paymentId: second.id, priceKrw: second.priceKrw, tid: tid2 });
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 불가' });
    const stuck = await postReturn(paymentIdToMoid(second.id), { Tid: tid2, TrAuthKey: 'k' });
    expect(redirectOf(stuck).result).toBe('pending');
    expect(await paymentRow(second.id)).toMatchObject({ status: 'pending', providerRef: tid2 });
  });

  it('asks a 재통보 that races a net cancel to come again, and credits it once the cancel is refused', async () => {
    // The ReturnUrl's approval answer does not verify, so the payment is net-cancelled; the
    // PG's genuine 재통보 for the same approval arrives while the cancel is still in flight.
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { SignValue: 'forged' } });
    let release!: (answer: SmartroResponse) => void;
    let cancelAsked!: () => void;
    const asked = new Promise<void>((resolve) => (cancelAsked = resolve));
    pg.onCancel = () => {
      cancelAsked();
      return new Promise<SmartroResponse>((resolve) => (release = resolve));
    };
    const returning = postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    await asked;
    // Reserved before the PG was asked: a credit racing the cancel cannot slip in. The reason
    // goes with it, whatever the cancel comes to.
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'cancelled',
      resultMessage: '가맹점 승인 처리 실패로 인한 자동 취소',
    });
    const notice = notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid });
    const racing = await postNotify(notice);
    expect(racing.statusCode).toBeGreaterThanOrEqual(500);
    expect(racing.body).not.toContain('OK');

    // The PG refuses the cancel: the money may still be taken, so the payment is pending again
    // and the re-sent 재통보 credits it.
    release({ ResultCode: '2002', ResultMsg: '취소 불가' });
    expect(redirectOf(await returning).result).toBe('pending');
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'pending',
      providerRef: tid,
      resultMessage: null,
    });
    // The refusal is recorded with the revert, and says what it was.
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      resultCode: '2002',
      payload: { outcome: 'refused', ResultCode: '2002' },
    });
    const again = await postNotify(notice);
    expect(again.body).toBe('OK');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'succeeded' });
    expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 10_000n);
  });

  it('acknowledges a 재통보 for an approval whose net cancel the PG confirmed, crediting nothing', async () => {
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { Mid: 'someoneels' } });
    expect(redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result).toBe(
      'cancelled',
    );
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled' },
    });
    const res = await postNotify(
      notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid }),
    );
    expect(res.body).toBe('OK');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    expect((await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT')).toHaveLength(0);
  });

  it('leaves a net cancel with no clear answer cancelled, and never credits its approval notice', async () => {
    for (const noAnswer of [
      () => {
        throw new SmartroUnreachableError('timed out');
      },
      // NaverPay: the previous cancel is not finished — it may still go through.
      () => ({
        ResultCode: 'NP24',
        ResultMsg: '취소처리가 완료되지 않아, 반드시 취소 재시도가 필요',
      }),
    ]) {
      pg.reset();
      const form = await prepared();
      const tid = testTid();
      approveWith(form, tid, { overrides: { SignValue: 'forged' } });
      pg.onCancel = noAnswer;
      const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
      expect(redirectOf(res).result).toBe('pending');
      // The card may be cancelled: the payment stays `cancelled`, not reopened — with the reason
      // the payer and the admin list read.
      expect(await paymentRow(form.paymentId)).toMatchObject({
        status: 'cancelled',
        providerRef: tid,
        resultMessage: '가맹점 승인 처리 실패로 인한 자동 취소',
      });
      expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
        type: 'net_cancel',
        payload: { outcome: 'unknown' },
      });

      // The approval's 재통보 is acknowledged — a re-send cannot settle it — and credits nothing.
      const notice = await postNotify(
        notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid }),
      );
      expect(notice.statusCode).toBe(200);
      expect(notice.body).toBe('OK');
      expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    }
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);
  });

  it('confirms a net cancel with no clear answer only on a cancel 재통보 whose code says so', async () => {
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { SignValue: 'forged' } });
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    expect(redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result).toBe(
      'pending',
    );
    const netCancels = async () =>
      (await eventsOf(form.paymentId)).filter((event) => event.type === 'net_cancel');
    expect(await netCancels()).toHaveLength(1);

    // A cancel that failed proves nothing about the card: recorded, the net cancel still open.
    const failedCancel = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid,
        resultCode: '2002',
        resultMsg: '취소 실패',
        stateCd: '2',
      }),
    );
    expect(failedCancel.body).toBe('OK');
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'notify',
      resultCode: '2002',
    });
    expect(await netCancels()).toHaveLength(1);

    // A full cancel of another Tid is no cancel of this approval: recorded, still open.
    const stranger = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid: testTid(),
        resultCode: '2001',
        stateCd: '1',
      }),
    );
    expect(stranger.body).toBe('OK');
    expect(await netCancels()).toHaveLength(1);

    // 후취소 성공: confirmed.
    const cancelled = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid,
        resultCode: '2001',
        stateCd: '2',
      }),
    );
    expect(cancelled.body).toBe('OK');
    expect((await netCancels()).at(-1)).toMatchObject({
      resultCode: '2001',
      payload: { outcome: 'cancelled', notice: true },
    });
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });

    // SmartroPay sends it again: confirmed once is enough.
    const resent = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid,
        resultCode: '2001',
        stateCd: '2',
      }),
    );
    expect(resent.body).toBe('OK');
    expect(
      (await netCancels()).filter(
        (event) => (event.payload as { outcome?: string }).outcome === 'cancelled',
      ),
    ).toHaveLength(1);
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('keeps a net cancel its 재통보 confirmed cancelled when the PG then answers it refused', async () => {
    // Contradictory PG answers: its cancel notice arrives while the cancel call hangs, and the
    // call then answers "no". The notice is the PG's word that the card is cancelled.
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid, { overrides: { SignValue: 'forged' } });
    let release!: (answer: SmartroResponse) => void;
    let cancelAsked!: () => void;
    const asked = new Promise<void>((resolve) => (cancelAsked = resolve));
    pg.onCancel = () => {
      cancelAsked();
      return new Promise<SmartroResponse>((resolve) => (release = resolve));
    };
    const returning = postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    await asked;
    const notice = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid,
        resultCode: '2001',
        stateCd: '1',
      }),
    );
    expect(notice.body).toBe('OK');
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      release({ ResultCode: '2002', ResultMsg: '취소 불가' });
      expect(redirectOf(await returning).result).toBe('cancelled');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('the 재통보 already confirmed the card cancelled'),
      );
    } finally {
      error.mockRestore();
    }
    // Not reopened; the refusal is recorded all the same.
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    expect((await eventsOf(form.paymentId)).at(-1)).toMatchObject({
      type: 'net_cancel',
      resultCode: '2002',
      payload: { outcome: 'refused' },
    });

    // The approval 재통보 is acknowledged and credits nothing.
    const late = await postNotify(
      notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid }),
    );
    expect(late.statusCode).toBe(200);
    expect(late.body).toBe('OK');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);
  });

  it('asks a 재통보 whose credit a net cancel reserved from under it to come again', async () => {
    // The notice reads the payment `pending` (claimed); before its credit, the ReturnUrl's net
    // cancel reserves it `cancelled` and has not heard from the PG yet.
    const claim = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: claim });
    const tid = testTid();
    const notice = notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
    const wallet = t.app.get(WalletService);
    const credit = wallet.creditPayment.bind(wallet);
    const spy = vi.spyOn(wallet, 'creditPayment').mockImplementationOnce(async (input) => {
      await t.db
        .update(schema.payments)
        .set({ status: 'cancelled' })
        .where(eq(schema.payments.id, payment.id));
      return credit(input);
    });
    try {
      const res = await postNotify(notice);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('OK');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(user.id)).toHaveLength(1);

    // The cancel then confirms: the re-sent notice is acknowledged, crediting nothing.
    await t.db.insert(schema.paymentEvents).values({
      paymentId: payment.id,
      type: 'net_cancel',
      resultCode: '2001',
      payload: { outcome: 'cancelled', ResultCode: '2001' },
    });
    const again = await postNotify(notice);
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('never net-cancels an approval whose credit failed only after the payment succeeded', async () => {
    const wallet = t.app.get(WalletService);
    const credit = wallet.creditPayment.bind(wallet);
    const spy = vi.spyOn(wallet, 'creditPayment');
    try {
      // The credit commits and the error comes after it (a COMMIT whose answer was lost).
      const form = await prepared();
      const tid = testTid();
      approveWith(form, tid);
      spy.mockImplementationOnce(async (input) => {
        await credit(input);
        throw new Error('connection lost after COMMIT');
      });
      const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
      expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'succeeded' });
      expect(pg.cancels).toHaveLength(0);
      expect(await paymentRow(form.paymentId)).toMatchObject({
        status: 'succeeded',
        providerRef: tid,
      });
      expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 10_000n);
      expect((await eventsOf(form.paymentId)).map((event) => event.type)).toEqual([
        'return',
        'approval',
      ]);

      // The payment moved on underneath the failed credit (the 재통보 credited it): the same.
      const other = await prepared();
      const otherTid = testTid();
      approveWith(other, otherTid);
      spy.mockImplementationOnce(async () => {
        await t.db
          .update(schema.payments)
          .set({ status: 'succeeded', providerRef: otherTid })
          .where(eq(schema.payments.id, other.paymentId));
        throw new Error('serialization failure');
      });
      const late = await postReturn(other.form.Moid, { Tid: otherTid, TrAuthKey: 'k' });
      expect(redirectOf(late)).toEqual({ payment: other.paymentId, result: 'succeeded' });
      expect(pg.cancels).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('asks the result inquiry once when the approval gets no answer', async () => {
    const form = await prepared();
    const tid = testTid();
    pg.onApprove = () => {
      throw new SmartroUnreachableError('timed out');
    };
    pg.onInquire = () =>
      approvalAnswer({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid });
    const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    expect(redirectOf(res).result).toBe('succeeded');
    expect(pg.inquiries).toEqual([{ Tid: tid, TrAuthKey: 'k' }]);
    expect((await eventsOf(form.paymentId)).map((event) => event.type)).toEqual([
      'return',
      'approval',
      'approval_inquiry',
    ]);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it("keeps the payment pending when the approval gets no answer and the inquiry's is no success", async () => {
    // The approval is slow at the card company; the inquiry, asked meanwhile, finds nothing
    // yet (or fails on its own). Neither is the approval's word: the card may be charged.
    for (const [resultCode, resultMsg] of [
      ['6017', '승인이력 없음'],
      ['6021', '거래조회 오류'],
      ['9999', '미지정 오류'],
      // Even a refusal-looking code: only the approval's own answer may fail a payment.
      ['3011', '카드번호 오류'],
    ] as const) {
      pg.reset();
      const form = await prepared();
      const tid = testTid();
      pg.onApprove = () => {
        throw new SmartroUnreachableError('timed out');
      };
      pg.onInquire = () =>
        approvalAnswer({
          paymentId: form.paymentId,
          priceKrw: pack.priceKrw,
          tid,
          resultCode,
          resultMsg,
        });
      const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
      expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'pending' });
      expect(await paymentRow(form.paymentId)).toMatchObject({
        status: 'pending',
        providerRef: tid,
        resultMessage: null,
      });
      const events = await eventsOf(form.paymentId);
      expect(events.map((event) => [event.type, event.resultCode])).toEqual([
        ['return', null],
        ['approval', null],
        ['approval_inquiry', resultCode],
      ]);

      // The approval went through after all: its 재통보 credits it.
      const notified = await postNotify(
        notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid }),
      );
      expect(notified.body).toBe('OK');
      expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'succeeded' });
    }
    expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 40_000n);
  });

  it('keeps the payment pending when neither the approval nor the inquiry answers', async () => {
    const form = await prepared();
    const tid = testTid();
    // The fake PG answers nothing unless scripted.
    const res = await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' });
    expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'pending' });
    expect(pg.approvals).toHaveLength(1);
    expect(pg.inquiries).toHaveLength(1);
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'pending', providerRef: tid });
    expect(await ledgerOf(user.id)).toHaveLength(1);

    // The 재통보 settles it later (DESIGN §5.5).
    const notified = await postNotify(
      notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid }),
    );
    expect(notified.statusCode).toBe(200);
    expect(notified.body).toBe('OK');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'succeeded' });
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it("never net-cancels another payment's approval that a replayed Tid brings back", async () => {
    // Payment A is approved under its own Tid, which differs from its authentication's.
    const a = await prepared();
    const aAuthTid = testTid();
    const aTid = testTid();
    approveWith(a, aTid);
    expect(
      redirectOf(await postReturn(a.form.Moid, { Tid: aAuthTid, TrAuthKey: 'ka' })).result,
    ).toBe('succeeded');

    // A's Tid and TrAuthKey replayed on B: the approval gets no answer, and the inquiry answers
    // with A's approval. It does not verify for B (Moid), but it is A's — not ours to cancel.
    const b = await prepared();
    pg.onApprove = () => {
      throw new SmartroUnreachableError('timed out');
    };
    pg.onInquire = () =>
      approvalAnswer({ paymentId: a.paymentId, priceKrw: pack.priceKrw, tid: aTid });
    const res = await postReturn(b.form.Moid, { Tid: aAuthTid, TrAuthKey: 'ka' });
    expect(redirectOf(res)).toEqual({ payment: b.paymentId, result: 'failed' });
    expect(pg.cancels).toHaveLength(0);
    expect(await paymentRow(a.paymentId)).toMatchObject({ status: 'succeeded', providerRef: aTid });
    expect(await paymentRow(b.paymentId)).toMatchObject({ status: 'failed' });

    // A's approval Tid itself replayed on C: the claim collides with A's reference, so C fails
    // before anything is asked of the PG — and that close is what C's event records.
    const c = await prepared();
    const approvals = pg.approvals.length;
    const replayed = await postReturn(c.form.Moid, { Tid: aTid, TrAuthKey: 'ka' });
    expect(redirectOf(replayed)).toEqual({ payment: c.paymentId, result: 'failed' });
    expect(pg.approvals).toHaveLength(approvals);
    expect(await paymentRow(c.paymentId)).toMatchObject({ status: 'failed', providerRef: null });
    expect((await eventsOf(c.paymentId)).map((event) => event.type)).toEqual(['return']);

    expect(pg.cancels).toHaveLength(0);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it('fails a return without TrAuthKey, and sends an unknown Moid to a plain failure', async () => {
    const form = await prepared();
    const res = await postReturn(form.form.Moid, { ResultCode: 'W001', ResultMsg: '인증 실패' });
    expect(redirectOf(res)).toEqual({ payment: form.paymentId, result: 'failed' });
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'failed',
      resultMessage: '인증 실패',
    });
    expect(pg.approvals).toHaveLength(0);
    const [closed] = await eventsOf(form.paymentId);
    expect(closed).toMatchObject({
      type: 'return',
      resultCode: 'W001',
      resultMessage: '인증 실패',
    });

    const unknown = [
      'not-a-moid',
      paymentIdToMoid('3f1a5b6c-1111-4222-8333-444455556666'), // well-formed, no such payment
      form.form.Moid.toUpperCase(), // we only ever issue lower case
    ];
    for (const moid of unknown) {
      const answer = await postReturn(moid, { Tid: testTid(), TrAuthKey: 'k' });
      expect({ moid, redirect: redirectOf(answer) }).toEqual({
        moid,
        redirect: { payment: null, result: 'failed' },
      });
    }
    expect(pg.approvals).toHaveLength(0);
  });

  it('never approves a mock payment through the SmartroPay ReturnUrl', async () => {
    const mock = await reserveSmartroPayment(t.db, user.id);
    await t.db
      .update(schema.payments)
      .set({ provider: 'mock' })
      .where(eq(schema.payments.id, mock.id));
    const res = await postReturn(paymentIdToMoid(mock.id), { Tid: testTid(), TrAuthKey: 'k' });
    expect(redirectOf(res)).toEqual({ payment: null, result: 'failed' });
    expect(pg.approvals).toHaveLength(0);
  });

  // --- StopUrl -------------------------------------------------------------------------

  it('closes an abandoned payment on the StopUrl (POST or GET), but not one being approved', async () => {
    const posted = await prepared();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/smartro/stop?m=${posted.form.Moid}`,
      headers: FORM_HEADERS,
      payload: formBody({ ResultCode: 'W002', ResultMsg: '사용자 결제 중단' }),
    });
    expect(redirectOf(res)).toEqual({ payment: posted.paymentId, result: 'stopped' });
    expect(await paymentRow(posted.paymentId)).toMatchObject({
      status: 'failed',
      resultMessage: '사용자 결제 중단',
    });
    expect((await eventsOf(posted.paymentId)).map((event) => event.type)).toEqual(['stop']);

    const linked = await prepared();
    // HEAD (a prefetcher) changes nothing; GET closes it.
    const head = await t.app.inject({
      method: 'HEAD',
      url: `/api/v1/payments/smartro/stop?m=${linked.form.Moid}`,
    });
    expect(head.statusCode).toBe(303);
    expect(await paymentRow(linked.paymentId)).toMatchObject({ status: 'pending' });
    const get = await t.app.inject({
      method: 'GET',
      url: `/api/v1/payments/smartro/stop?m=${linked.form.Moid}`,
    });
    expect(redirectOf(get)).toEqual({ payment: linked.paymentId, result: 'stopped' });

    // Claimed by a ReturnUrl already: the stop cannot fail it underneath the approval.
    const claimed = await prepared();
    await t.db
      .update(schema.payments)
      .set({ providerRef: testTid() })
      .where(eq(schema.payments.id, claimed.paymentId));
    const late = await t.app.inject({
      method: 'GET',
      url: `/api/v1/payments/smartro/stop?m=${claimed.form.Moid}`,
    });
    expect(redirectOf(late)).toEqual({ payment: claimed.paymentId, result: 'pending' });
    expect(await paymentRow(claimed.paymentId)).toMatchObject({ status: 'pending' });
  });

  // --- 재통보 --------------------------------------------------------------------------

  it('refuses a 재통보 whose SignValue does not verify (400, no OK)', async () => {
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    const tid = testTid();
    const res = await postNotify(
      notifyForm({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid,
        signValue: testSignValue(tid, '3001', 'not-the-merchant-key-000000000000000'),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending' });
    expect(await eventsOf(payment.id)).toHaveLength(0);
  });

  it("takes a 재통보 only from the mode's SmartroPay servers (403 otherwise, nothing changes)", async () => {
    const claim = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: claim });
    const tid = testTid();
    const form = notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
    // Anyone else — including the REAL 재통보 servers while the mode is STG — gets a 403 before
    // the SignValue is even looked at (so a forged one is a 403 too, not a 400).
    for (const [remoteAddress, fields] of [
      ['203.0.113.7', form],
      [SMARTRO_NOTIFY_IPS.REAL[0]!, form],
      ['127.0.0.1', form],
      ['203.0.113.7', { ...form, SignValue: 'forged' }],
    ] as const) {
      const res = await postNotify(fields, remoteAddress);
      expect({ remoteAddress, status: res.statusCode }).toEqual({ remoteAddress, status: 403 });
      expect(res.body).not.toContain('OK');
    }
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', providerRef: claim });
    expect(await eventsOf(payment.id)).toHaveLength(0);
    expect(await ledgerOf(user.id)).toHaveLength(1);

    // SmartroPay's STG server, as a dual-stack socket reports it: credited.
    const res = await postNotify(form, `::ffff:${TEST_NOTIFY_IP}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded', providerRef: tid });
  });

  it('takes a 재통보 from any address while the check is off (a local fake PG)', async () => {
    // paymentsConfigFromEnv turns the check off (null) exactly when SMARTRO_APPROVAL_BASE_URL
    // points the PG calls at a local fake; the app's own config object is swapped for the test.
    const config = t.app.get<PaymentsConfig>(PAYMENTS_CONFIG);
    const smartro = config.smartro;
    config.smartro = { ...TEST_SMARTRO, notifyIps: null };
    try {
      const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
      const res = await postNotify(
        notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid: testTid() }),
        '203.0.113.7',
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('OK');
      expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded' });
    } finally {
      config.smartro = smartro;
    }
  });

  it('credits a claimed pending payment from the 재통보, once however often it comes', async () => {
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    // The approval's Tid, which may differ from the authentication's the claim recorded.
    const tid = testTid();
    const form = notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
    for (let i = 0; i < 3; i += 1) {
      const res = await postNotify(form);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('OK');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    }
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'succeeded',
      providerRef: tid,
      method: 'CARD',
    });
    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
    expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 10_000n);
    expect((await eventsOf(payment.id)).map((event) => event.type)).toEqual([
      'notify',
      'notify',
      'notify',
    ]);
  });

  it('never credits an approval 재통보 for a payment no ReturnUrl claimed', async () => {
    // The PG approves only when our ReturnUrl calls urlCallApproval, after its claim commits:
    // an approval notice for an unclaimed payment cannot be genuine. Acknowledged (a re-send
    // cannot change it), recorded, not credited.
    const pending = await reserveSmartroPayment(t.db, user.id);
    const res = await postNotify(
      notifyForm({ paymentId: pending.id, priceKrw: pending.priceKrw, tid: testTid() }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(await paymentRow(pending.id)).toMatchObject({ status: 'pending', providerRef: null });
    expect((await eventsOf(pending.id)).map((event) => event.type)).toEqual(['notify']);

    // Closed by the StopUrl before any claim: stays failed.
    const stopped = await prepared();
    await t.app.inject({
      method: 'GET',
      url: `/api/v1/payments/smartro/stop?m=${stopped.form.Moid}`,
    });
    const late = await postNotify(
      notifyForm({ paymentId: stopped.paymentId, priceKrw: pack.priceKrw, tid: testTid() }),
    );
    expect(late.body).toBe('OK');
    expect(await paymentRow(stopped.paymentId)).toMatchObject({
      status: 'failed',
      providerRef: null,
    });
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);
  });

  it('answers a 5xx without OK when crediting the 재통보 fails, so it comes again', async () => {
    const claim = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: claim });
    const tid = testTid();
    const form = notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
    const spy = vi
      .spyOn(t.app.get(WalletService), 'creditPayment')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    try {
      const res = await postNotify(form);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('OK');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', providerRef: claim });
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);

    // SmartroPay's next attempt finds our side working again.
    expect((await postNotify(form)).body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded', providerRef: tid });
  });

  it('credits no approval 재통보 while a cancel 재통보 of the card is on record', async () => {
    // A partial cancel made in the merchant admin while the approval's answer was lost: part of
    // the card is cancelled, so the whole P is not owed. The approval notice that follows is
    // acknowledged, not credited, and the log says how to reconcile it.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      for (const status of ['pending', 'failed'] as const) {
        const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
        await t.db
          .update(schema.payments)
          .set({ status })
          .where(eq(schema.payments.id, payment.id));
        const tid = testTid();
        const partial = notifyForm({
          paymentId: payment.id,
          priceKrw: payment.priceKrw,
          tid,
          amt: '1000',
          resultCode: '2001',
          stateCd: '1',
        });
        expect((await postNotify(partial)).body).toBe('OK');
        error.mockClear();
        const approval = await postNotify(
          notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid }),
        );
        expect(approval.statusCode).toBe(200);
        expect(approval.body).toBe('OK');
        expect(error).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(
              `which is ${status}: a partial cancel 재통보 of the card is on record; not credited .*settle it cancelled.*balance-adjust`,
            ),
          ),
        );
        expect(await paymentRow(payment.id)).toMatchObject({ status });
        expect((await eventsOf(payment.id)).map((event) => event.type)).toEqual([
          'notify',
          'notify',
        ]);
      }

      // A full cancel notice recorded, its judgement not yet run (it follows, under the lock the
      // credit holds): held back too — that notice closes the payment, or a person settles it.
      const racing = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
      const racingTid = testTid();
      await t.db.insert(schema.paymentEvents).values({
        paymentId: racing.id,
        type: 'notify',
        resultCode: '2001',
        payload: { StateCd: '1', ResultCode: '2001', Tid: racingTid, Amt: '9700' },
      });
      const approval = await postNotify(
        notifyForm({ paymentId: racing.id, priceKrw: racing.priceKrw, tid: racingTid }),
      );
      expect(approval.body).toBe('OK');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /which is pending: a full cancel 재통보 of the card is on record; not credited — that notice closes it cancelled unless it already ran and did not; if it stays pending, .*settle it \(POST \/admin\/payments\/[0-9a-f-]+\/settle\)$/,
        ),
      );
      expect(await paymentRow(racing.id)).toMatchObject({ status: 'pending' });
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);

    // A cancel that failed is no cancel: the approval notice credits.
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    const tid = testTid();
    await postNotify(
      notifyForm({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid,
        resultCode: '2002',
        stateCd: '1',
      }),
    );
    await postNotify(notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid }));
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded', providerRef: tid });
    expectLedgerChain(await ledgerOf(user.id), SIGNUP_BONUS_P + 10_000n);
  });

  it('credits a payment we had failed when the PG says it was approved', async () => {
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    await t.db
      .update(schema.payments)
      .set({ status: 'failed' })
      .where(eq(schema.payments.id, payment.id));
    const res = await postNotify(
      notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid: testTid() }),
    );
    expect(res.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded' });
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it('acknowledges but does not credit a 재통보 whose Tid another payment already holds', async () => {
    const first = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    const secondClaim = testTid();
    const second = await reserveSmartroPayment(t.db, user.id, { claimedBy: secondClaim });
    const tid = testTid();
    expect(
      (await postNotify(notifyForm({ paymentId: first.id, priceKrw: first.priceKrw, tid }))).body,
    ).toBe('OK');
    // The same Tid for another payment: the unique index refuses the credit, and a re-send
    // could not change that, so it is acknowledged (not a 5xx the PG would keep repeating).
    const res = await postNotify(
      notifyForm({ paymentId: second.id, priceKrw: second.priceKrw, tid }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(await paymentRow(second.id)).toMatchObject({
      status: 'pending',
      providerRef: secondClaim,
    });
    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it('acknowledges but does not credit a 재통보 for another amount, or for an unknown Moid', async () => {
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    const wrong = await postNotify(
      notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid: testTid(), amt: '100' }),
    );
    expect(wrong.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending' });

    const stranger = await postNotify(
      notifyForm({
        paymentId: '3f1a5b6c-1111-4222-8333-444455556666',
        priceKrw: 9_700,
        tid: testTid(),
      }),
    );
    expect(stranger.statusCode).toBe(200);
    expect(stranger.body).toBe('OK');
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('records a cancel made outside the service without clawing the P back', async () => {
    const form = await prepared();
    const tid = testTid();
    approveWith(form, tid);
    expect(redirectOf(await postReturn(form.form.Moid, { Tid: tid, TrAuthKey: 'k' })).result).toBe(
      'succeeded',
    );
    const res = await postNotify(
      notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid,
        resultCode: '2001',
        stateCd: '1',
      }),
    );
    expect(res.body).toBe('OK');
    expect(await paymentRow(form.paymentId)).toMatchObject({ status: 'succeeded' });
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
    const events = await eventsOf(form.paymentId);
    expect(events.at(-1)).toMatchObject({ type: 'notify', resultCode: '2001' });
    expect(events.at(-1)!.payload).toMatchObject({ StateCd: '1' });
    expect(events.at(-1)!.payload).not.toHaveProperty('BuyerName');
  });

  it("words a partial cancel's fix by the payment's status", async () => {
    // No settle outcome moves part of the P: the log names the settle that closes the payment,
    // if one applies, and the balance adjustment that sets the P the rest of the card is worth.
    const cases: [PaymentStatus, RegExp][] = [
      [
        'pending',
        /a settle credit is refused \(partial_cancel\) — settle it cancelled \(POST \/admin\/payments\/[0-9a-f-]+\/settle\), then adjust the balance \(POST \/admin\/users\/:id\/balance-adjust\)/,
      ],
      ['failed', /a settle credit is refused \(partial_cancel\) — settle it cancelled \(/],
      [
        'cancelled',
        /if the admin list flags it \(its net cancel unconfirmed\), settle it cancelled \(POST \/admin\/payments\/[0-9a-f-]+\/settle; a settle credit is refused: partial_cancel\); either way adjust the balance/,
      ],
      ['refunding', /a settle restore is refused \(partial_cancel\) — settle it refunded \(/],
      [
        'succeeded',
        /no settle applies to a succeeded payment — adjust the balance only \(POST \/admin\/users\/:id\/balance-adjust\)$/,
      ],
      ['refunded', /no settle applies to a refunded payment — adjust the balance only/],
    ];
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (const [status, fix] of cases) {
        const approvalTid = testTid();
        const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: approvalTid });
        await t.db
          .update(schema.payments)
          .set({ status })
          .where(eq(schema.payments.id, payment.id));
        error.mockClear();
        // Its own Tid, the approval's as Otid: a partial cancel ("부분취소의 경우").
        const res = await postNotify(
          notifyForm({
            paymentId: payment.id,
            priceKrw: payment.priceKrw,
            tid: testTid(),
            otid: approvalTid,
            resultCode: '2001',
            stateCd: '2',
          }),
        );
        expect(res.body).toBe('OK');
        const logged = error.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes('reports a partial cancel'));
        expect({ status, logged }).toEqual({ status, logged: [expect.stringMatching(fix)] });
        expect(await paymentRow(payment.id)).toMatchObject({ status });
      }

      // Never claimed, so never approved: no card of it to reconcile.
      const unclaimed = await reserveSmartroPayment(t.db, user.id);
      error.mockClear();
      await postNotify(
        notifyForm({
          paymentId: unclaimed.id,
          priceKrw: unclaimed.priceKrw,
          tid: testTid(),
          otid: testTid(),
          resultCode: '2001',
          stateCd: '2',
        }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/reports a partial cancel.*no ReturnUrl claimed it/),
      );
    } finally {
      error.mockRestore();
    }
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('shouts when a credited payment hears of an approval under another Tid than its own', async () => {
    // A settle credit given the wrong Tid (the operator's typo): the payment holds A, while the
    // PG's approval — and so every 재통보 of it — names B. Nothing moves; the log says so.
    const form = await prepared();
    const recordedTid = testTid();
    approveWith(form, recordedTid);
    expect(
      redirectOf(await postReturn(form.form.Moid, { Tid: recordedTid, TrAuthKey: 'k' })).result,
    ).toBe('succeeded');
    const realTid = testTid();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // The approval 재통보 of B.
      const approval = await postNotify(
        notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid: realTid }),
      );
      expect(approval.body).toBe('OK');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('the approval Tid on record differs'),
      );
      // Its own Tid again (a re-sent notice) is no alarm.
      error.mockClear();
      await postNotify(
        notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid: recordedTid }),
      );
      expect(error).not.toHaveBeenCalled();

      // B cancelled in the merchant admin: a full cancel of "another approval" — on a credited
      // payment, an error that names the fix, not a warning.
      const cancelOfB = notifyForm({
        paymentId: form.paymentId,
        priceKrw: pack.priceKrw,
        tid: realTid,
        resultCode: '2001',
        stateCd: '1',
      });
      expect((await postNotify(cancelOfB)).body).toBe('OK');
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/names another approval than .*succeeded.*balance-adjust/),
      );

      // Refunding (its cancel of A got no answer): the fix is a settle.
      error.mockClear();
      await t.db
        .update(schema.payments)
        .set({ status: 'refunding' })
        .where(eq(schema.payments.id, form.paymentId));
      expect((await postNotify(cancelOfB)).body).toBe('OK');
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/names another approval than .*refunding.*settle it refunded/),
      );
      error.mockClear();
      await postNotify(
        notifyForm({ paymentId: form.paymentId, priceKrw: pack.priceKrw, tid: realTid }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('the approval Tid on record differs'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('names another approval'));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    expect(await paymentRow(form.paymentId)).toMatchObject({
      status: 'refunding',
      providerRef: recordedTid,
    });
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);
  });

  it('closes a claimed payment its cancel 재통보 reports cancelled, so a late approval notice credits nothing', async () => {
    // The approval's answer was lost (the payment is claimed, `pending`) and the card was
    // cancelled in the merchant admin. A full cancel carries the approval's Tid — not the
    // authentication Tid the claim recorded; the Moid names the payment.
    const claim = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: claim });
    const approvalTid = testTid();
    const cancel = (
      resultCode: string,
      extra: { resultMsg?: string; payMethod?: string; tid?: string; amt?: string } = {},
    ) =>
      notifyForm({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid: approvalTid,
        otid: approvalTid,
        resultCode,
        stateCd: '1',
        ...extra,
      });

    // A cancel that failed, or a card's 2015 (해당거래 취소실패): recorded, nothing moves.
    for (const resultCode of ['2002', '2015']) {
      expect((await postNotify(cancel(resultCode, { resultMsg: '취소 실패' }))).body).toBe('OK');
      expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', providerRef: claim });
    }
    // A partial cancel went through — its own Tid with the approval's as Otid, or part of the
    // amount — but the rest of the card stays charged: recorded, nothing moves.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (const partial of [{ tid: testTid() }, { amt: '1000' }]) {
        expect((await postNotify(cancel('2001', partial))).body).toBe('OK');
        expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending' });
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('reports a partial cancel'));
    } finally {
      error.mockRestore();
    }
    expect((await eventsOf(payment.id)).map((event) => event.type)).toEqual([
      'notify',
      'notify',
      'notify',
      'notify',
    ]);

    expect((await postNotify(cancel('2001'))).body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'cancelled',
      providerRef: claim,
      resultMessage: '결제대행사 취소 통보에 따른 취소',
    });
    expect((await eventsOf(payment.id)).at(-1)).toMatchObject({
      type: 'net_cancel',
      resultCode: '2001',
      payload: { outcome: 'cancelled', notice: true },
    });

    // SmartroPay re-sends the approval's notice: acknowledged, never credited.
    const late = await postNotify(
      notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid: approvalTid }),
    );
    expect(late.statusCode).toBe(200);
    expect(late.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled' });

    // A claimed payment we had failed (an approval notice would credit it): the same. With no
    // method on the payment, the notice's own PayMethod reads the code — 2015 is SmilePay's
    // "already cancelled".
    const failed = await reserveSmartroPayment(t.db, user.id, { claimedBy: testTid() });
    await t.db
      .update(schema.payments)
      .set({ status: 'failed' })
      .where(eq(schema.payments.id, failed.id));
    const smile = notifyForm({
      paymentId: failed.id,
      priceKrw: failed.priceKrw,
      tid: testTid(),
      resultCode: '2015',
      stateCd: '2',
      payMethod: 'SMILEPAY',
    });
    expect((await postNotify(smile)).body).toBe('OK');
    expect(await paymentRow(failed.id)).toMatchObject({ status: 'cancelled' });
    expect(
      (
        await postNotify(
          notifyForm({ paymentId: failed.id, priceKrw: failed.priceKrw, tid: testTid() }),
        )
      ).body,
    ).toBe('OK');
    expect(await paymentRow(failed.id)).toMatchObject({ status: 'cancelled' });

    // Never claimed, so never approved: nothing to cancel — recorded only.
    const unclaimed = await reserveSmartroPayment(t.db, user.id);
    const stray = await postNotify(
      notifyForm({
        paymentId: unclaimed.id,
        priceKrw: unclaimed.priceKrw,
        tid: testTid(),
        resultCode: '2001',
        stateCd: '1',
      }),
    );
    expect(stray.body).toBe('OK');
    expect(await paymentRow(unclaimed.id)).toMatchObject({ status: 'pending', providerRef: null });
    expect((await eventsOf(unclaimed.id)).map((event) => event.type)).toEqual(['notify']);

    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect((await balanceOf(user.id)).availableP).toBe(SIGNUP_BONUS_P);
  });
});
