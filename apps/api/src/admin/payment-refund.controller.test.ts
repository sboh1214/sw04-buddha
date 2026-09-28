/**
 * `POST /admin/payments/:id/refund` (ADR-0042, DESIGN §5.6) against the docker `test` profile:
 * claw the P back, cancel at the PG, compensate on a refusal, stay `refunding` on silence.
 *
 * The app runs PAYMENT_PROVIDER=mock with SmartroPay still configured — the state after a
 * switch back — so both kinds of payment exist side by side: mock ones through the immediate
 * charge, SmartroPay ones through the ReturnUrl with the fake PG. A refund goes to the provider
 * recorded on the payment, whichever that is. Skips when TEST_* are unset.
 */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { schema } from '@buddha/db';
import {
  SIGNUP_BONUS_P,
  paymentIdToMoid,
  userChannel,
  type AdminPayment,
  type ChargeResult,
} from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  chargeBody,
  chargeHeaders,
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestPackage,
  type TestUser,
} from '../test/app.js';
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import {
  FORM_HEADERS,
  FakeSmartroClient,
  TEST_NOTIFY_IP,
  TEST_SMARTRO,
  approvalAnswer,
  formBody,
  notifyForm,
  reserveSmartroPayment,
  testSignValue,
  testTid,
} from '../test/smartro.js';
import { sleep, waitForLockWaiter } from '../test/wait.js';
import { SmartroUnreachableError } from '../payments/smartro/smartro-client.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const REASON = '고객 청약철회 요청 (7일 이내, 미사용)';

describe.skipIf(!hasTestInfra)('admin payment refund (integration)', () => {
  let t: TestApp;
  const pg = new FakeSmartroClient();
  let admin: TestUser;
  let member: TestUser;
  /** 10,000P for 9,700원. */
  let pack: TestPackage;

  beforeAll(async () => {
    t = await createTestApp({ smartro: { client: pg, provider: 'mock' } });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    pg.reset();
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
    pack = await createTestPackage(t.db);
  });

  const refund = (paymentId: string, reason: string = REASON, cookie = admin.cookie) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/${paymentId}/refund`,
      headers: { ...jsonHeaders, cookie },
      payload: { reason },
    });

  /**
   * A SmartroPay charge of `member`, approved through the ReturnUrl like a real one — by card,
   * or by the easy-pay `payMethod` the payer picked in the window (with its success code).
   */
  async function smartroCharge(
    payMethod: { payMethod: string; resultCode: string } = {
      payMethod: 'CARD',
      resultCode: '3001',
    },
  ): Promise<{ id: string; tid: string }> {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    pg.onApprove = () =>
      approvalAnswer({ paymentId: payment.id, priceKrw: payment.priceKrw, tid, ...payMethod });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/smartro/return?m=${paymentIdToMoid(payment.id)}`,
      headers: FORM_HEADERS,
      payload: formBody({ Tid: tid, TrAuthKey: 'auth-key' }),
    });
    expect(String(res.headers.location)).toContain('result=succeeded');
    return { id: payment.id, tid };
  }

  /** A mock charge of `member` through the immediate flow. */
  async function mockCharge(): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(member.cookie),
      payload: chargeBody(pack, member.id),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: ChargeResult }>().data.payment.id;
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

  async function refundActions() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.type, 'payment_refund'));
  }

  async function eventsOf(paymentId: string) {
    return t.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.paymentId, paymentId))
      .orderBy(asc(schema.paymentEvents.id));
  }

  /** SmartroPay's server posting a 재통보, from its STG address. */
  const postNotify = (fields: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: FORM_HEADERS,
      payload: formBody(fields),
      remoteAddress: TEST_NOTIFY_IP,
    });

  /** A refund whose cancel got no answer: `refunding`, the P clawed back (502). */
  async function stuckRefunding(id: string): Promise<void> {
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    expect((await refund(id)).statusCode).toBe(502);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
  }

  it('refunds an unused SmartroPay charge: P out, the whole card amount cancelled', async () => {
    const { id, tid } = await smartroCharge();
    expect((await balanceOf(member.id)).availableP).toBe(SIGNUP_BONUS_P + 10_000n);

    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(member.id));
    let res: Awaited<ReturnType<typeof refund>>;
    try {
      res = await refund(id);
      const started = Date.now();
      while (received.length < 1 && Date.now() - started < 5_000) await sleep(20);
    } finally {
      await subscriber.quit();
    }

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: AdminPayment }>().data;
    expect(body).toMatchObject({
      id,
      userId: member.id,
      provider: 'smartro',
      providerRef: tid,
      status: 'refunded',
      amountP: '10000',
      priceKrw: 9_700,
    });
    expect(body.refundedAt).toEqual(expect.any(String));

    // What SmartroPay received: a full cancel of the KRW paid, VAT split as at payment time.
    expect(pg.cancels).toEqual([
      {
        Tid: tid,
        Mid: TEST_SMARTRO.mid,
        CancelAmt: '9700',
        CancelPwd: TEST_SMARTRO.cancelPassword,
        CancelMsg: REASON,
        CancelSeq: '1',
        PartialCancelCode: '0',
        HashData: createHash('sha256')
          .update(`${tid}${TEST_SMARTRO.merchantKey}97000`)
          .digest('base64'),
        CancelTaxAmt: '8819',
        CancelTaxFreeAmt: '0',
        CancelVatAmt: '881',
        outerMid: TEST_SMARTRO.mid,
      },
    ]);

    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => [entry.type, entry.amountP])).toEqual([
      ['BONUS', SIGNUP_BONUS_P],
      ['DEPOSIT', 10_000n],
      ['PAYMENT_CANCEL', -10_000n],
    ]);
    expect(ledger[2]).toMatchObject({ refType: 'payment', refId: id });
    expectLedgerChain(ledger, SIGNUP_BONUS_P);

    // Audited in the claw-back's own transaction (admin-audit.test's rule).
    const actions = await refundActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      adminId: admin.id,
      targetType: 'payment',
      targetId: id,
      payload: { amountP: '10000', priceKrw: 9_700, provider: 'smartro', memo: REASON },
    });
    expect(actions[0]!.createdAt.getTime()).toBe(ledger[2]!.createdAt.getTime());

    const events = await t.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.paymentId, id))
      .orderBy(asc(schema.paymentEvents.id));
    expect(events.at(-1)).toMatchObject({ type: 'refund_cancel', resultCode: '2001' });

    // The balance screen hears about the claw-back without a reload (PLAN 8).
    expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
      {
        type: 'user:balance',
        availableP: SIGNUP_BONUS_P.toString(),
        lockedP: '0',
        ledgerEntryId: ledger[2]!.id.toString(),
        ts: ledger[2]!.createdAt.toISOString(),
      },
    ]);
  });

  it('refunds a mock charge through the mock provider (the provider on the row decides)', async () => {
    const id = await mockCharge();
    const res = await refund(id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({
      provider: 'mock',
      status: 'refunded',
    });
    expect(pg.cancels).toHaveLength(0);
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P);
  });

  it("answers a replayed charge key with the charge's DEPOSIT after the refund, never the claw-back", async () => {
    // The refund's PAYMENT_CANCEL sits under the same reference (payment, id) as the DEPOSIT,
    // and is the newer of the two — first in the (user_id, created_at DESC) index.
    const key = 'refunded-mock-charge-key';
    const charge = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(member.cookie, key),
        payload: chargeBody(pack, member.id),
      });
    const first = await charge();
    expect(first.statusCode).toBe(200);
    const charged = first.json<{ data: ChargeResult }>().data;
    expect((await refund(charged.payment.id)).statusCode).toBe(200);

    const replay = await charge();
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json<{ data: ChargeResult }>().data;
    expect(replayed.ledgerEntry).toEqual(charged.ledgerEntry);
    expect(replayed.ledgerEntry).toMatchObject({ type: 'DEPOSIT', amountP: '10000' });
    // The payment and the balance as they are now; the replay bought nothing.
    expect(replayed.payment).toMatchObject({ id: charged.payment.id, status: 'refunded' });
    expect(replayed.balance.availableP).toBe(SIGNUP_BONUS_P.toString());
    expect((await ledgerOf(member.id)).map((entry) => entry.type)).toEqual([
      'BONUS',
      'DEPOSIT',
      'PAYMENT_CANCEL',
    ]);
  });

  it('refuses once part of the P is used (INSUFFICIENT_BALANCE), changing nothing', async () => {
    const { id } = await smartroCharge();
    // Spend the bonus and 1P of the charge: 9,999P left against a 10,000P payment.
    const spent = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${member.id}/balance-adjust`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { amountP: (-(SIGNUP_BONUS_P + 1n)).toString(), memo: 'spent' },
    });
    expect(spent.statusCode).toBe(200);

    const res = await refund(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } });
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded', refundedAt: null });
    expect((await balanceOf(member.id)).availableP).toBe(9_999n);
    expect(await refundActions()).toHaveLength(0);
    expect(pg.cancels).toHaveLength(0);
  });

  it('refuses after the refund window, and for a payment that is not a settled charge', async () => {
    const { id } = await smartroCharge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: sql`now() - interval '7 days 1 minute'` })
      .where(eq(schema.payments.id, id));
    const late = await refund(id);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      error: {
        code: 'REFUND_NOT_ALLOWED',
        details: [{ path: ['payment'], message: 'window_closed' }],
      },
    });

    const pending = await reserveSmartroPayment(t.db, member.id);
    const failed = await reserveSmartroPayment(t.db, member.id);
    await t.db
      .update(schema.payments)
      .set({ status: 'failed' })
      .where(eq(schema.payments.id, failed.id));
    for (const payment of [pending, failed]) {
      const res = await refund(payment.id);
      expect(res.json()).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }

    // A provider this deployment cannot reach (a row from some other PG).
    const foreign = await mockCharge();
    await t.db
      .update(schema.payments)
      .set({ provider: 'acme' })
      .where(eq(schema.payments.id, foreign));
    expect((await refund(foreign)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'provider' }] },
    });

    expect(await refundActions()).toHaveLength(0);
    expect(pg.cancels).toHaveLength(0);
  });

  it('validates the request: admin only, a reason, a known payment', async () => {
    const id = await mockCharge();
    expect((await refund(id, REASON, member.cookie)).statusCode).toBe(403);
    expect((await refund(id, '   ')).statusCode).toBe(400);
    expect((await refund('3f1a5b6c-1111-4222-8333-444455556666')).statusCode).toBe(404);
    expect((await refund('not-a-uuid')).statusCode).toBe(400);
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });
  });

  it('puts the P back when the PG refuses the cancel (PAYMENT_CANCEL_REVERSAL)', async () => {
    const { id } = await smartroCharge();
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 불가 거래' });
    const res = await refund(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'PAYMENT_GATEWAY_REFUSED',
        details: [{ path: ['gateway'], message: '2002 취소 불가 거래' }],
      },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded', refundedAt: null });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => [entry.type, entry.amountP])).toEqual([
      ['BONUS', SIGNUP_BONUS_P],
      ['DEPOSIT', 10_000n],
      ['PAYMENT_CANCEL', -10_000n],
      ['PAYMENT_CANCEL_REVERSAL', 10_000n],
    ]);
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);
    // The attempt stays audited: the P did leave the balance, if only for a moment.
    expect(await refundActions()).toHaveLength(1);
  });

  it('stays refunding when the PG does not answer, and a retry finishes it (2013)', async () => {
    const { id } = await smartroCharge();
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    const first = await refund(id);
    expect(first.statusCode).toBe(502);
    // Sealed like any 5xx: the code survives, the message does not.
    expect(first.json()).toEqual({
      error: { code: 'PAYMENT_GATEWAY_ERROR', message: 'Internal server error' },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    expect((await balanceOf(member.id)).availableP).toBe(SIGNUP_BONUS_P);

    // The first cancel did reach the card after all: the retry hears "already cancelled".
    pg.onCancel = () => ({ ResultCode: '2013', ResultMsg: '기취소 거래' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });

    expect(pg.cancels).toHaveLength(2);
    expect(pg.cancels[1]).toMatchObject({ CancelMsg: '재시도' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
    // The retry is audited too: who finalised it, and the reason the PG got.
    const actions = await refundActions();
    expect(actions).toHaveLength(2);
    expect(actions.find((action) => action.payload?.retry === true)).toMatchObject({
      adminId: admin.id,
      targetId: id,
      payload: { memo: '재시도', retry: true },
    });

    // Done is done.
    const again = await refund(id);
    expect(again.json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
    });
  });

  it('claws back once when two refunds of one payment race', async () => {
    const { id } = await smartroCharge();
    const responses = await Promise.all([refund(id), refund(id)]);
    const statuses = responses.map((res) => res.statusCode).sort();
    // The loser found it `refunding` with the winner's cancel in flight (DUPLICATE_REQUEST), or
    // already `refunded`, or lost the claw-back's lock (REFUND_NOT_ALLOWED). Either way: 409,
    // one claw-back and one cancel.
    expect(statuses).toEqual([200, 409]);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
    expect(await refundActions()).toHaveLength(1);
    expect(pg.cancels).toHaveLength(1);
  });

  it('runs one cancel at a time: a retry waits out an attempt still in flight', async () => {
    const { id, tid } = await smartroCharge();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers = [
      // The first attempt hangs on the PG, and in the end hears "already cancelled".
      async () => {
        await gate;
        return { ResultCode: '2013', ResultMsg: '기취소 거래' };
      },
      () => Promise.resolve({ ResultCode: '2001', ResultMsg: '취소 성공' }),
    ];
    pg.onCancel = () => answers[pg.cancels.length - 1]!();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      // light-my-request dispatches lazily: `.then` is what sends the request.
      const first = refund(id).then((res) => res);
      await vi.waitFor(() => {
        expect(pg.cancels).toHaveLength(1);
      });

      // Still waiting on the PG: a retry is refused rather than sent beside it.
      const early = await refund(id, '재시도');
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({
        error: {
          code: 'DUPLICATE_REQUEST',
          details: [{ path: ['payment'], message: 'in progress' }],
        },
      });
      expect(pg.cancels).toHaveLength(1);
      expect(await refundActions()).toHaveLength(1);

      // An attempt silent for longer than any PG call lasts died with its process: a retry
      // takes over, and is audited.
      await t.db
        .update(schema.payments)
        .set({ updatedAt: sql`now() - interval '2 minutes'` })
        .where(eq(schema.payments.id, id));
      const late = await refund(id, '재시도');
      expect(late.statusCode).toBe(200);
      expect(late.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
      expect(pg.cancels).toHaveLength(2);
      expect(await refundActions()).toHaveLength(2);

      // The first attempt's answer lands after all: the payment is already refunded — the
      // same end — so it changes nothing, and no alarm goes off over it.
      release();
      expect((await first).statusCode).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`cancelled ${tid}; it was refunded already`),
      );
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('no longer refunding'));
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });
  // --- a retry never puts the P back by itself (PAY-1) --------------------------------

  it('finishes a retried NaverPay refund on NaverPay\'s own "already cancelled" (NP17)', async () => {
    const { id } = await smartroCharge({ payMethod: 'NAVER', resultCode: 'NP00' });
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded', method: 'NAVER' });
    await stuckRefunding(id);

    // The first cancel reached NaverPay; the retry hears its code, not SmartroPay's 2013.
    pg.onCancel = () => ({ ResultCode: 'NP17', ResultMsg: '이미 전체 취소된 결제' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('keeps a refused retry refunding with the P still out, for an admin to settle', async () => {
    const { id } = await smartroCharge();
    await stuckRefunding(id);

    // The first attempt may have cancelled the card: this "no" must not give the P back.
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 실패' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: {
        code: 'PAYMENT_GATEWAY_REFUSED',
        details: [
          { path: ['gateway'], message: '2002 취소 실패' },
          { path: ['payment'], message: 'settle_required' },
        ],
      },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding', refundedAt: null });
    expect((await balanceOf(member.id)).availableP).toBe(SIGNUP_BONUS_P);
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: '2002',
    });
    // Its answer is recorded, so the next retry need not wait out the lease.
    pg.onCancel = () => ({ ResultCode: '2013', ResultMsg: '기취소 거래' });
    expect((await refund(id, '다시')).statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
  });

  it('still restores on a first attempt a card refuses, 2015 included (기취소 only for SmilePay)', async () => {
    const { id } = await smartroCharge();
    pg.onCancel = () => ({ ResultCode: '2015', ResultMsg: '해당거래 취소실패' });
    const res = await refund(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'PAYMENT_GATEWAY_REFUSED', details: [{ message: '2015 해당거래 취소실패' }] },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P + 10_000n);
  });

  it('keeps an answer without a ResultCode refunding; a numeric 2013 then finishes it', async () => {
    const { id } = await smartroCharge();
    pg.onCancel = () => ({ ResultMsg: '시스템 오류' });
    const first = await refund(id);
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ error: { code: 'PAYMENT_GATEWAY_ERROR' } });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    expect((await balanceOf(member.id)).availableP).toBe(SIGNUP_BONUS_P);
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: null,
      resultMessage: '시스템 오류',
    });
    expect(
      (await ledgerOf(member.id)).filter((entry) => entry.type === 'PAYMENT_CANCEL_REVERSAL'),
    ).toHaveLength(0);

    // JSON may carry the code as a number.
    pg.onCancel = () => ({ ResultCode: 2013 });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('finishes a refunding refund when the 재통보 reports its cancel (StateCd 1)', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: FORM_HEADERS,
      payload: formBody(
        notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode: '2001', stateCd: '1' }),
      ),
      remoteAddress: TEST_NOTIFY_IP,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    const row = await paymentRow(id);
    expect(row).toMatchObject({ status: 'refunded' });
    expect(row.refundedAt).toBeInstanceOf(Date);
    // The P was clawed back when the refund began: nothing more moves.
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);

    // A cancel notice for another Tid finishes nothing.
    const other = await smartroCharge();
    await stuckRefunding(other.id);
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: FORM_HEADERS,
      payload: formBody(
        notifyForm({
          paymentId: other.id,
          priceKrw: 9_700,
          tid: testTid(),
          resultCode: '2001',
          stateCd: '1',
        }),
      ),
      remoteAddress: TEST_NOTIFY_IP,
    });
    expect(await paymentRow(other.id)).toMatchObject({ status: 'refunding' });
  });

  it('finishes a refused retry the 재통보 already reported cancelled', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);
    // A cancel notice recorded without finishing the refund (one that arrived before this
    // service finished refunds on it): the PG's word that the card is cancelled.
    await t.db.insert(schema.paymentEvents).values({
      paymentId: id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: tid, StateCd: '1', ResultCode: '2001' },
    });
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 실패' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P);
  });

  // --- a cancel 재통보 counts only when its code says cancelled -------------------------

  it('finishes a first attempt the PG refuses once its 재통보 said the card was cancelled', async () => {
    const { id, tid } = await smartroCharge();
    // Cancelled in the merchant admin while `succeeded`: the notice is recorded, nothing moves.
    const notice = await postNotify(
      notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode: '2001', stateCd: '1' }),
    );
    expect(notice.body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });

    // The admin refunds it; the PG answers in a code we do not know as "already cancelled".
    // Its own notice already said so: done, and the P is not put back.
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 불가 거래' });
    const res = await refund(id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: '2002',
    });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('takes nothing from a cancel 재통보 whose code is no cancel (2002, a card 2015)', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);

    for (const [resultCode, resultMsg] of [
      ['2002', '취소 실패'],
      // 기취소 for SmilePay only; for a card, 해당거래 취소실패.
      ['2015', '해당거래 취소실패'],
    ] as const) {
      const res = await postNotify(
        notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode, resultMsg, stateCd: '2' }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('OK');
      expect(await paymentRow(id)).toMatchObject({ status: 'refunding', refundedAt: null });
      // Recorded all the same: it is SmartroPay's.
      expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'notify', resultCode });
    }

    // Nor does it count for a retry the PG refuses: still `refunding`, for a settle.
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 실패' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: {
        code: 'PAYMENT_GATEWAY_REFUSED',
        details: [{ path: ['gateway'] }, { path: ['payment'], message: 'settle_required' }],
      },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('finishes on a full 후취소 재통보 (StateCd 2), never on a partial one', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // A partial cancel made in the merchant admin: its own Tid with the approval's as Otid
      // ("부분취소의 경우"), or part of the amount under the approval's Tid. The rest of the card
      // stays charged: nothing is finished on it.
      for (const partial of [
        { tid: testTid(), otid: tid },
        { tid, amt: '1000' },
      ]) {
        const res = await postNotify(
          notifyForm({
            paymentId: id,
            priceKrw: 9_700,
            resultCode: '2001',
            stateCd: '2',
            ...partial,
          }),
        );
        expect(res.body).toBe('OK');
        expect(await paymentRow(id)).toMatchObject({ status: 'refunding', refundedAt: null });
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('reports a partial cancel'));
    } finally {
      error.mockRestore();
    }
    // Nor does a partial one count for a retry the PG refuses: still `refunding`, for a settle.
    pg.onCancel = () => ({ ResultCode: '2032', ResultMsg: '취소금액 오류' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: { details: [{ path: ['gateway'] }, { message: 'settle_required' }] },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });

    // The full cancel names the approval itself (Tid, and Otid when it carries one): done.
    const res = await postNotify(
      notifyForm({
        paymentId: id,
        priceKrw: 9_700,
        tid,
        otid: tid,
        resultCode: '2001',
        stateCd: '2',
      }),
    );
    expect(res.body).toBe('OK');
    const row = await paymentRow(id);
    expect(row).toMatchObject({ status: 'refunded', providerRef: tid });
    expect(row.refundedAt).toBeInstanceOf(Date);
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it("never finishes a refund on a recorded partial cancel's notice, even the PG refusing", async () => {
    // An operator cancelled 1,000원 of a charge in the merchant admin while it was `succeeded`:
    // recorded, nothing moved. A refund then asks for the whole amount, which the PG refuses.
    const { id, tid } = await smartroCharge();
    await t.db.insert(schema.paymentEvents).values({
      paymentId: id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: testTid(), Otid: tid, StateCd: '2', ResultCode: '2001', Amt: '1000' },
    });
    pg.onCancel = () => ({ ResultCode: '2031', ResultMsg: '전체금액취소 불가' });
    const res = await refund(id);
    // Not `refunded`: 8,700원 of the card is still charged. The P goes back as for any refusal.
    expect(res.statusCode).toBe(409);
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P + 10_000n);

    // A retry of a stuck refund does not finish on it either.
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    expect((await refund(id)).statusCode).toBe(502);
    pg.onCancel = () => ({ ResultCode: '2031', ResultMsg: '전체금액취소 불가' });
    expect((await refund(id, '재시도')).json()).toMatchObject({
      error: { details: [{ path: ['gateway'] }, { message: 'settle_required' }] },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
  });

  it('finishes an unanswered cancel, first attempt or retry, once a 재통보 reported it cancelled', async () => {
    // Cancelled in the merchant admin while `succeeded`; the admin's refund then gets no answer.
    const first = await smartroCharge();
    expect(
      (
        await postNotify(
          notifyForm({
            paymentId: first.id,
            priceKrw: 9_700,
            tid: first.tid,
            resultCode: '2001',
            stateCd: '1',
          }),
        )
      ).body,
    ).toBe('OK');
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    const res = await refund(first.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
    expect((await ledgerOf(member.id)).map((entry) => entry.type)).toEqual([
      'BONUS',
      'DEPOSIT',
      'PAYMENT_CANCEL',
    ]);

    // A retry whose answer carries no ResultCode, with a notice recorded meanwhile.
    const second = await smartroCharge();
    await stuckRefunding(second.id);
    await t.db.insert(schema.paymentEvents).values({
      paymentId: second.id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: second.tid, StateCd: '1', ResultCode: '2001', Amt: '9700' },
    });
    pg.onCancel = () => ({ ResultMsg: '시스템 오류' });
    const retry = await refund(second.id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(await paymentRow(second.id)).toMatchObject({ status: 'refunded' });
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P);
  });

  it('reads a recorded 구통보 (TID, OTID) and a code kept only in its column', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);
    // 구통보 names, and a payload without its ResultCode: the row's result_code reads it.
    await t.db.insert(schema.paymentEvents).values({
      paymentId: id,
      type: 'notify',
      resultCode: '2001',
      payload: { TID: tid, OTID: tid, StateCd: '1', Amt: '9700' },
    });
    pg.onCancel = () => ({ ResultCode: '2002', ResultMsg: '취소 실패' });
    expect((await refund(id, '재시도')).statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
  });

  it('takes a 구통보 cancel notice by its TID, and its OTID as the mark of a partial cancel', async () => {
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);
    const oldNotice = (ownTid: string, originalTid: string) => ({
      PayMethod: 'CARD',
      MID: TEST_SMARTRO.mid,
      Amt: '9700',
      GoodsName: '포인트 10,000P',
      TID: ownTid,
      OTID: originalTid,
      OID: paymentIdToMoid(id),
      AuthDate: '260928103000',
      ResultCode: '2001',
      ResultMsg: '취소 성공',
      StateCd: '2',
      SignValue: testSignValue(ownTid, '2001'),
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect((await postNotify(oldNotice(testTid(), tid))).body).toBe('OK');
    } finally {
      error.mockRestore();
    }
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    expect((await eventsOf(id)).at(-1)!.payload).toMatchObject({ OTID: tid });

    expect((await postNotify(oldNotice(tid, tid))).body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
  });

  it("reads a notice's code by the payment's method, not the notice's PayMethod", async () => {
    // A card payment: 2015 is 해당거래 취소실패 for a card, whatever PayMethod the notice names.
    const { id, tid } = await smartroCharge();
    await stuckRefunding(id);
    const res = await postNotify(
      notifyForm({
        paymentId: id,
        priceKrw: 9_700,
        tid,
        resultCode: '2015',
        stateCd: '2',
        payMethod: 'SMILEPAY',
      }),
    );
    expect(res.body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding', method: 'CARD' });
  });

  it('never restores a first attempt a retry took over: the retry decides', async () => {
    const { id, tid } = await smartroCharge();
    let refuseFirst: () => void = () => undefined;
    let answerRetry: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => (refuseFirst = resolve));
    const retryGate = new Promise<void>((resolve) => (answerRetry = resolve));
    const answers = [
      async () => {
        await firstGate;
        return { ResultCode: '2002', ResultMsg: '취소 실패' };
      },
      async () => {
        await retryGate;
        return { ResultCode: '2001', ResultMsg: '취소 성공' };
      },
    ];
    pg.onCancel = () => answers[pg.cancels.length - 1]!();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const first = refund(id).then((res) => res);
      await vi.waitFor(() => {
        expect(pg.cancels).toHaveLength(1);
      });
      // The first attempt outlives its lease (a slow PG): a retry takes the payment over, and
      // its cancel is on the card when the first attempt's refusal finally lands.
      await t.db
        .update(schema.payments)
        .set({ updatedAt: sql`now() - interval '70 seconds'` })
        .where(eq(schema.payments.id, id));
      const retry = refund(id, '재시도').then((res) => res);
      await vi.waitFor(() => {
        expect(pg.cancels).toHaveLength(2);
      });

      refuseFirst();
      const late = await first;
      // Not this attempt's any more: nothing put back, left to the retry (or a settle).
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({
        error: {
          code: 'PAYMENT_GATEWAY_REFUSED',
          details: [
            { path: ['gateway'], message: '2002 취소 실패' },
            { message: 'settle_required' },
          ],
        },
      });
      expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('after a retry took the payment over'),
      );

      answerRetry();
      expect((await retry).statusCode).toBe(200);
    } finally {
      error.mockRestore();
    }
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded', providerRef: tid });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('finishes instead of restoring when a 재통보 lands while the refusal waits on the balance', async () => {
    // The PG refuses the cancel; meanwhile a slow writer of the account (an order, say) holds
    // its balance row, so the restore waits on it — and SmartroPay's notice of the cancel
    // arrives in that window. The P must not go back to a card the PG says is cancelled.
    for (const arrival of ['recorded', 'applied'] as const) {
      const { id, tid } = await smartroCharge();
      const holder = await t.db.$client.connect();
      let open = false;
      let pending: ReturnType<typeof refund> | undefined;
      try {
        pg.onCancel = async () => {
          await holder.query('BEGIN');
          open = true;
          await holder.query(
            `SELECT user_id FROM balances WHERE user_id = '${member.id}' FOR UPDATE`,
          );
          return { ResultCode: '2002', ResultMsg: '취소 실패' };
        };
        pending = refund(id).then((res) => res);
        await waitForLockWaiter(holder, 'the restore on the balance row');
        if (arrival === 'recorded') {
          // Its event committed; its own transaction has yet to reach the payment row.
          await t.db.insert(schema.paymentEvents).values({
            paymentId: id,
            type: 'notify',
            resultCode: '2001',
            payload: { Tid: tid, StateCd: '1', ResultCode: '2001', Amt: '9700' },
          });
        } else {
          // Handled in full: the refund is finished before the restore gets the balance.
          const notice = await postNotify(
            notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode: '2001', stateCd: '1' }),
          );
          expect(notice.body).toBe('OK');
        }
        await holder.query('COMMIT');
        open = false;
        const res = await pending;
        expect(res.statusCode).toBe(200);
        expect(res.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
      } finally {
        if (open) await holder.query('ROLLBACK');
        holder.release();
        await pending?.catch(() => undefined);
      }
    }
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL_REVERSAL')).toHaveLength(0);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('raises no alarm when the 재통보 of its own cancel finishes the refund first', async () => {
    const { id, tid } = await smartroCharge();
    // The PG notifies the cancel before it answers the call.
    pg.onCancel = async () => {
      const notice = await postNotify(
        notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode: '2001', stateCd: '1' }),
      );
      expect(notice.body).toBe('OK');
      return { ResultCode: '2001', ResultMsg: '취소 성공' };
    };
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await refund(id);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
      expect(error).not.toHaveBeenCalled();

      // The same when its answer is a refusal after all: the notice is the PG's word.
      const other = await smartroCharge();
      pg.onCancel = async () => {
        await postNotify(
          notifyForm({
            paymentId: other.id,
            priceKrw: 9_700,
            tid: other.tid,
            resultCode: '2001',
            stateCd: '1',
          }),
        );
        return { ResultCode: '2002', ResultMsg: '취소 실패' };
      };
      const refused = await refund(other.id);
      expect(refused.statusCode).toBe(200);
      expect(await paymentRow(other.id)).toMatchObject({ status: 'refunded' });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P);
  });

  // --- the policy's edges (T3) ---------------------------------------------------------

  it('refunds just inside the window, and counts from created_at when approved_at is null', async () => {
    const inside = await smartroCharge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: sql`now() - interval '6 days 23 hours'` })
      .where(eq(schema.payments.id, inside.id));
    expect((await refund(inside.id)).statusCode).toBe(200);
    expect(await paymentRow(inside.id)).toMatchObject({ status: 'refunded' });

    // A row credited before approved_at existed: its reservation's own time decides.
    const old = await smartroCharge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: null, createdAt: sql`now() - interval '8 days'` })
      .where(eq(schema.payments.id, old.id));
    expect((await refund(old.id)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'window_closed' }] },
    });
    const recent = await smartroCharge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: null })
      .where(eq(schema.payments.id, recent.id));
    expect((await refund(recent.id)).statusCode).toBe(200);
    expect(await paymentRow(recent.id)).toMatchObject({ status: 'refunded' });
  });

  it("refunds when exactly the payment's P is still available", async () => {
    const { id } = await smartroCharge();
    // Spend the whole sign-up bonus: 10,000P left against a 10,000P payment — none of it used.
    const spent = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${member.id}/balance-adjust`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { amountP: (-SIGNUP_BONUS_P).toString(), memo: 'spent the bonus' },
    });
    expect(spent.statusCode).toBe(200);
    expect((await balanceOf(member.id)).availableP).toBe(10_000n);

    const res = await refund(id);
    expect(res.statusCode).toBe(200);
    expect((await balanceOf(member.id)).availableP).toBe(0n);
    expectLedgerChain(await ledgerOf(member.id), 0n);
  });
});
