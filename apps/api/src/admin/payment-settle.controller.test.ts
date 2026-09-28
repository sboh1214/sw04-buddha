/**
 * `POST /admin/payments/:id/settle` (ADR-0042, DESIGN addendum §D) against the docker `test`
 * profile: an admin settles by hand the SmartroPay payments the API could not settle by itself
 * — a claimed `pending` one whose approval answer never came, a `cancelled` one whose net cancel
 * got no clear answer, a `refunding` one whose cancel got no clear answer — and the admin list
 * flags exactly those (`needsReview`). Each state is reached through the real flows with the
 * fake PG, and aged by moving `updated_at` back (SETTLE_MIN_AGE_MS). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P, paymentIdToMoid, type AdminPayment } from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
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
  approvalAnswer,
  formBody,
  notifyForm,
  reserveSmartroPayment,
  testTid,
} from '../test/smartro.js';
import { recordPaymentEvent } from '../payments/payment-events.js';
import { SmartroUnreachableError } from '../payments/smartro/smartro-client.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const REASON = '가맹점 관리자에서 승인 내역 확인';

describe.skipIf(!hasTestInfra)('admin payment settle (integration)', () => {
  let t: TestApp;
  const pg = new FakeSmartroClient();
  let admin: TestUser;
  let member: TestUser;
  /** 10,000P for 9,700원. */
  let pack: TestPackage;

  beforeAll(async () => {
    t = await createTestApp({ smartro: { client: pg } });
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

  const settle = (
    paymentId: string,
    outcome: string,
    cookie = admin.cookie,
    reason = REASON,
    tid?: string,
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/${paymentId}/settle`,
      headers: { ...jsonHeaders, cookie },
      payload: { outcome, reason, ...(tid === undefined ? {} : { tid }) },
    });

  /** A settle `credit` with the approval's Tid the merchant admin shows (none on record). */
  const settleCredit = (paymentId: string, tid: string) =>
    settle(paymentId, 'credit', admin.cookie, REASON, tid);

  const postReturn = (paymentId: string, fields: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/smartro/return?m=${paymentIdToMoid(paymentId)}`,
      headers: FORM_HEADERS,
      payload: formBody(fields),
    });

  const postNotify = (fields: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: FORM_HEADERS,
      payload: formBody(fields),
      remoteAddress: TEST_NOTIFY_IP,
    });

  async function paymentRow(id: string) {
    const [row] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, id));
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

  async function settleActions() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.type, 'payment_settle'));
  }

  /** Untouched for 3 minutes: past SETTLE_MIN_AGE_MS, so nothing can still be working on it. */
  async function age(id: string): Promise<void> {
    await t.db
      .update(schema.payments)
      .set({ updatedAt: sql`now() - interval '3 minutes'` })
      .where(eq(schema.payments.id, id));
  }

  /** How the admin list shows the payment. */
  async function listed(id: string): Promise<AdminPayment> {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/payments',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json<{ data: AdminPayment[] }>().data.find((payment) => payment.id === id);
    if (!row) throw new Error(`payment ${id} is not listed`);
    return row;
  }

  /**
   * A claimed `pending` payment whose approval never answered (nor did the inquiry): the
   * ReturnUrl left it for the 재통보 or an admin.
   */
  async function unanswered(): Promise<{ id: string; tid: string }> {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    const res = await postReturn(payment.id, { Tid: tid, TrAuthKey: 'k' });
    expect(String(res.headers.location)).toContain('result=pending');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', providerRef: tid });
    return { id: payment.id, tid };
  }

  /** An approval that did not verify, whose net cancel got no answer: stays `cancelled`. */
  async function cancelUnknown(): Promise<{ id: string; tid: string }> {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    pg.onApprove = () =>
      approvalAnswer({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid,
        overrides: { SignValue: 'forged' },
      });
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    await postReturn(payment.id, { Tid: tid, TrAuthKey: 'k' });
    pg.reset();
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled', providerRef: tid });
    return { id: payment.id, tid };
  }

  /** A charged SmartroPay payment whose refund's cancel got no answer: `refunding`, P out. */
  async function refundUnanswered(): Promise<{ id: string; tid: string }> {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    pg.onApprove = () => approvalAnswer({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
    expect(
      String((await postReturn(payment.id, { Tid: tid, TrAuthKey: 'k' })).headers.location),
    ).toContain('result=succeeded');
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    const refund = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/${payment.id}/refund`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { reason: '청약철회' },
    });
    expect(refund.statusCode).toBe(502);
    pg.reset();
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'refunding' });
    return { id: payment.id, tid };
  }

  it('credits a claimed payment the card was charged for, once; a late 재통보 changes nothing', async () => {
    const { id, tid: authTid } = await unanswered();
    expect((await listed(id)).needsReview).toBe(false); // someone may still be working on it
    await age(id);
    expect((await listed(id)).needsReview).toBe(true);

    // Every answer was lost, so no approval is on record: the admin gives the approval's Tid
    // as the merchant admin shows it — not necessarily the authentication's the claim holds.
    const missing = await settle(id, 'credit');
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['tid'] }] },
    });
    const tid = testTid();
    const res = await settleCredit(id, tid);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: AdminPayment }>().data;
    expect(body).toMatchObject({
      id,
      status: 'succeeded',
      providerRef: tid,
      resultMessage: '관리자 수동 정리',
      needsReview: false,
    });
    expect(tid).not.toBe(authTid);
    expect(body.approvedAt).toEqual(expect.any(String));
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => [entry.type, entry.amountP])).toEqual([
      ['BONUS', SIGNUP_BONUS_P],
      ['DEPOSIT', 10_000n],
    ]);
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);

    // Audited in the credit's own transaction.
    const actions = await settleActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      adminId: admin.id,
      targetType: 'payment',
      targetId: id,
      payload: { outcome: 'credit', from: 'pending', amountP: '10000', tid, memo: REASON },
    });

    // The PG's approval notice arrives after all: settled already, so nothing more.
    const notice = await postNotify(notifyForm({ paymentId: id, priceKrw: 9_700, tid }));
    expect(notice.body).toBe('OK');
    expect((await ledgerOf(member.id)).filter((entry) => entry.type === 'DEPOSIT')).toHaveLength(1);
    // Done is done.
    expect((await settleCredit(id, tid)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ path: ['payment'], message: 'status' }] },
    });

    // A refund cancels the approval's Tid, the one stored.
    const refund = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/${id}/refund`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { reason: '청약철회' },
    });
    expect(refund.statusCode).toBe(200);
    expect(pg.cancels.map((cancel) => cancel.Tid)).toEqual([tid]);
  });

  it('closes a claimed payment the card was cancelled for; a late approval 재통보 is a no-op', async () => {
    const { id, tid } = await unanswered();
    await age(id);
    const res = await settle(id, 'cancelled');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'cancelled',
      needsReview: false,
    });
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', manual: true },
    });

    const notice = await postNotify(notifyForm({ paymentId: id, priceKrw: 9_700, tid }));
    expect(notice.statusCode).toBe(200);
    expect(notice.body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(member.id)).toHaveLength(1);
  });

  it('fails a pending payment that was never approved, claimed or not', async () => {
    const claimed = await unanswered();
    const unclaimed = await reserveSmartroPayment(t.db, member.id);
    for (const id of [claimed.id, unclaimed.id]) {
      await age(id);
      const res = await settle(id, 'failed');
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: AdminPayment }>().data).toMatchObject({
        status: 'failed',
        resultMessage: '관리자 수동 정리',
      });
    }
    // Credit or cancel an unclaimed one: nothing was ever approved, so there is no card to judge.
    const other = await reserveSmartroPayment(t.db, member.id);
    await age(other.id);
    for (const outcome of ['credit', 'cancelled']) {
      expect(
        (await settle(other.id, outcome, admin.cookie, REASON, testTid())).json(),
      ).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }
    // Nor anything but `failed` of one failed unclaimed: nothing to check.
    await age(unclaimed.id);
    for (const outcome of ['credit', 'cancelled', 'failed']) {
      expect(
        (await settle(unclaimed.id, outcome, admin.cookie, REASON, testTid())).json(),
      ).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }
    expect(await ledgerOf(member.id)).toHaveLength(1);
    expect(await settleActions()).toHaveLength(2);
  });

  it('settles a net cancel that got no answer either way', async () => {
    // The card was not cancelled after all: credited.
    const kept = await cancelUnknown();
    await age(kept.id);
    expect((await listed(kept.id)).needsReview).toBe(true);
    const credited = await settle(kept.id, 'credit');
    expect(credited.statusCode).toBe(200);
    expect(credited.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'succeeded',
      providerRef: kept.tid,
      needsReview: false,
    });

    // The card was cancelled: confirmed, and no longer flagged.
    const gone = await cancelUnknown();
    await age(gone.id);
    const confirmed = await settle(gone.id, 'cancelled');
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'cancelled',
      needsReview: false,
    });
    // Once confirmed, the card IS cancelled: it cannot be credited any more.
    expect((await settle(gone.id, 'credit')).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
    });

    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P + 10_000n);
  });

  it("takes the PG's cancel 재통보 as the confirmation a net cancel never got", async () => {
    const { id, tid } = await cancelUnknown();
    await age(id);
    expect((await listed(id)).needsReview).toBe(true);
    const notice = await postNotify(
      notifyForm({ paymentId: id, priceKrw: 9_700, tid, resultCode: '2001', stateCd: '1' }),
    );
    expect(notice.body).toBe('OK');
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', notice: true },
    });
    expect((await listed(id)).needsReview).toBe(false);
    // The card IS cancelled: never credited, by hand or by a late approval notice.
    await age(id);
    expect((await settle(id, 'credit')).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
    });
    expect((await postNotify(notifyForm({ paymentId: id, priceKrw: 9_700, tid }))).body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'cancelled' });
    expect(await ledgerOf(member.id)).toHaveLength(1);
  });

  it('keeps a confirmed net cancel confirmed whatever a later attempt heard', async () => {
    const payment = await reserveSmartroPayment(t.db, member.id, { claimedBy: testTid() });
    await t.db
      .update(schema.payments)
      .set({ status: 'cancelled', updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.payments.id, payment.id));
    // Confirmed first; a later attempt (a resend) got no clear answer.
    for (const outcome of ['cancelled', 'unknown']) {
      await t.db
        .insert(schema.paymentEvents)
        .values({ paymentId: payment.id, type: 'net_cancel', payload: { outcome } });
    }
    expect((await listed(payment.id)).needsReview).toBe(false);
    for (const outcome of ['credit', 'cancelled']) {
      expect((await settle(payment.id, outcome)).json()).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }
  });

  it('settles a stuck refund as refunded, or restores its P', async () => {
    const done = await refundUnanswered();
    await age(done.id);
    expect((await listed(done.id)).needsReview).toBe(true);
    const refunded = await settle(done.id, 'refunded');
    expect(refunded.statusCode).toBe(200);
    const body = refunded.json<{ data: AdminPayment }>().data;
    expect(body).toMatchObject({ status: 'refunded', needsReview: false });
    expect(body.refundedAt).toEqual(expect.any(String));
    // The P was clawed back when the refund began: nothing more moves.
    expect((await ledgerOf(member.id)).map((entry) => entry.type)).toEqual([
      'BONUS',
      'DEPOSIT',
      'PAYMENT_CANCEL',
    ]);

    const kept = await refundUnanswered();
    await age(kept.id);
    const restored = await settle(kept.id, 'restore');
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'succeeded',
      refundedAt: null,
      needsReview: false,
    });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual([
      'BONUS',
      'DEPOSIT',
      'PAYMENT_CANCEL',
      'DEPOSIT',
      'PAYMENT_CANCEL',
      'PAYMENT_CANCEL_REVERSAL',
    ]);
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);
    expect((await eventsOf(kept.id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      payload: { outcome: 'refused', manual: true },
    });

    // A refund is not credited or cancelled by hand.
    const third = await refundUnanswered();
    await age(third.id);
    for (const outcome of ['credit', 'cancelled', 'failed']) {
      expect((await settle(third.id, outcome)).json()).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }
    expect(await settleActions()).toHaveLength(2);
  });

  // --- a credit stores the approval's Tid, and only an approval that matches ---------------

  it("credits with the approval on record: its Tid and PayMethod, not the claim's", async () => {
    // A ReturnUrl that died right after the approval's answer: recorded, never credited. The
    // approval's Tid differs from the authentication's the claim holds (an easy-pay method).
    const authTid = testTid();
    const payment = await reserveSmartroPayment(t.db, member.id, {
      packageId: pack.id,
      claimedBy: authTid,
    });
    const approvalTid = testTid();
    await recordPaymentEvent(t.db, {
      paymentId: payment.id,
      type: 'approval',
      resultCode: 'NP00',
      payload: approvalAnswer({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid: approvalTid,
        resultCode: 'NP00',
        payMethod: 'NAVER',
      }),
    });
    // A later answer whose SignValue does not verify names another Tid: the verified one wins.
    await recordPaymentEvent(t.db, {
      paymentId: payment.id,
      type: 'approval_inquiry',
      resultCode: '3001',
      payload: approvalAnswer({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid: testTid(),
        overrides: { SignValue: 'forged' },
      }),
    });
    await age(payment.id);
    expect((await listed(payment.id)).needsReview).toBe(true);

    // A Tid given must be the one on record.
    expect((await settleCredit(payment.id, authTid)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'approval_mismatch' }] },
    });
    const res = await settle(payment.id, 'credit');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'succeeded',
      providerRef: approvalTid,
      method: 'NAVER',
    });
    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P + 10_000n);
  });

  it("refunds a settled credit whose card the merchant admin cancelled: the approval's Tid", async () => {
    // The approval's Tid differs from the authentication's the claim holds; the admin read it
    // in the merchant admin.
    const { id, tid: authTid } = await unanswered();
    await age(id);
    const approvalTid = testTid();
    expect((await settleCredit(id, approvalTid)).statusCode).toBe(200);

    // The operator cancels the card there; its 재통보 names the approval.
    const notice = await postNotify(
      notifyForm({
        paymentId: id,
        priceKrw: 9_700,
        tid: approvalTid,
        resultCode: '2001',
        stateCd: '1',
      }),
    );
    expect(notice.body).toBe('OK');
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });

    // The admin refunds it. The PG cannot cancel it again; its notice already said it is.
    pg.onCancel = () => ({ ResultCode: '2012', ResultMsg: '취소 해당거래 없음' });
    const refund = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/${id}/refund`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { reason: '가맹점 관리자에서 취소됨' },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
    expect(pg.cancels.map((cancel) => cancel.Tid)).toEqual([approvalTid]);
    expect(approvalTid).not.toBe(authTid);
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });

  it('credits an approval net-cancelled for its SignValue alone, under its own Tid', async () => {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const authTid = testTid();
    const approvalTid = testTid();
    pg.onApprove = () =>
      approvalAnswer({
        paymentId: payment.id,
        priceKrw: payment.priceKrw,
        tid: approvalTid,
        overrides: { SignValue: 'forged' },
      });
    pg.onCancel = () => {
      throw new SmartroUnreachableError('timed out');
    };
    await postReturn(payment.id, { Tid: authTid, TrAuthKey: 'k' });
    pg.reset();
    await age(payment.id);
    const res = await settleCredit(payment.id, approvalTid);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'succeeded',
      providerRef: approvalTid,
      method: 'CARD',
    });
  });

  it('refuses to credit an approval that does not match the payment (approval_mismatch)', async () => {
    const mismatched = async (overrides: Record<string, unknown>) => {
      const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
      const tid = testTid();
      pg.onApprove = () =>
        approvalAnswer({ paymentId: payment.id, priceKrw: payment.priceKrw, tid, overrides });
      pg.onCancel = () => {
        throw new SmartroUnreachableError('timed out');
      };
      await postReturn(payment.id, { Tid: tid, TrAuthKey: 'k' });
      pg.reset();
      expect(await paymentRow(payment.id)).toMatchObject({ status: 'cancelled' });
      await age(payment.id);
      return { id: payment.id, tid };
    };
    for (const [overrides, field] of [
      [{ Amt: '5000' }, 'Amt'],
      [{ Mid: 'someoneels' }, 'Mid'],
    ] as const) {
      const { id, tid } = await mismatched(overrides);
      const res = await settle(id, 'credit');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: {
          code: 'REFUND_NOT_ALLOWED',
          details: [{ path: ['payment'], message: 'approval_mismatch' }],
        },
      });
      expect(res.json<{ error: { message: string } }>().error.message).toContain(field);
      // Not by giving another Tid either.
      expect((await settleCredit(id, testTid())).json()).toMatchObject({
        error: { details: [{ message: 'approval_mismatch' }] },
      });
      // The operator cancels the card in the merchant admin, and settles it so.
      expect((await settle(id, 'cancelled')).statusCode).toBe(200);
      expect(await paymentRow(id)).toMatchObject({ status: 'cancelled', providerRef: tid });
    }

    // An approval 재통보 for another amount, acknowledged without a credit: the same.
    const { id } = await unanswered();
    expect(
      (
        await postNotify(
          notifyForm({ paymentId: id, priceKrw: 9_700, tid: testTid(), amt: '5000' }),
        )
      ).body,
    ).toBe('OK');
    await age(id);
    expect((await settle(id, 'credit')).json()).toMatchObject({
      error: { details: [{ message: 'approval_mismatch' }] },
    });
    expect(await ledgerOf(member.id)).toHaveLength(1);
  });

  it('refuses an approval Tid another payment already holds (approval_mismatch)', async () => {
    const first = await unanswered();
    const second = await unanswered();
    await age(first.id);
    await age(second.id);
    const tid = testTid();
    expect((await settleCredit(first.id, tid)).statusCode).toBe(200);
    const res = await settleCredit(second.id, tid);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'approval_mismatch' }] },
    });
    // Nothing of it was written: no credit, no audit row.
    expect(await paymentRow(second.id)).toMatchObject({
      status: 'pending',
      providerRef: second.tid,
    });
    expect(await settleActions()).toHaveLength(1);

    // An approval 재통보 carrying that Tid for the second payment (acknowledged, not credited):
    // the Tid on record is refused the same way.
    await postNotify(notifyForm({ paymentId: second.id, priceKrw: 9_700, tid }));
    await age(second.id);
    expect((await settle(second.id, 'credit')).json()).toMatchObject({
      error: { details: [{ message: 'approval_mismatch' }] },
    });
    const deposits = (await ledgerOf(member.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
  });

  it('refuses a credit or a restore once a cancel 재통보 reports the card cancelled', async () => {
    // Its `notify` event commits before its own transaction queues on the payment's lock: a
    // settle that holds the lock meanwhile must not credit a card the PG says is cancelled.
    const { id } = await unanswered();
    await age(id);
    await t.db.insert(schema.paymentEvents).values({
      paymentId: id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: testTid(), StateCd: '1', ResultCode: '2001', Amt: '9700' },
    });
    const refused = await settleCredit(id, testTid());
    expect(refused.json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
    });
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('cancel 재통보');
    expect((await settle(id, 'cancelled')).statusCode).toBe(200);

    // A partial cancel does not count: it is left to the admin.
    const partial = await unanswered();
    await age(partial.id);
    await t.db.insert(schema.paymentEvents).values({
      paymentId: partial.id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: testTid(), Otid: testTid(), StateCd: '1', ResultCode: '2001' },
    });
    expect((await settleCredit(partial.id, testTid())).statusCode).toBe(200);

    const stuck = await refundUnanswered();
    await age(stuck.id);
    await t.db.insert(schema.paymentEvents).values({
      paymentId: stuck.id,
      type: 'notify',
      resultCode: '2001',
      payload: { Tid: stuck.tid, StateCd: '2', ResultCode: '2001', Amt: '9700' },
    });
    expect((await settle(stuck.id, 'restore')).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
    });
    expect((await settle(stuck.id, 'refunded')).statusCode).toBe(200);
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual([
      'BONUS',
      'DEPOSIT',
      'DEPOSIT',
      'PAYMENT_CANCEL',
    ]);
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);
  });

  // --- a claimed `failed` payment ---------------------------------------------------------

  it('settles a claimed failed payment the card may be charged for, flagged until checked', async () => {
    // Failed on the word of something other than the approval, whose own answer never came
    // (an inquiry's "nothing found", as this service once took it; a settle to failed).
    const failedUnanswered = async () => {
      const { id, tid } = await unanswered();
      await t.db
        .update(schema.payments)
        .set({ status: 'failed' })
        .where(eq(schema.payments.id, id));
      await age(id);
      return { id, tid };
    };

    const charged = await failedUnanswered();
    expect((await listed(charged.id)).needsReview).toBe(true);
    const approvalTid = testTid();
    const credited = await settleCredit(charged.id, approvalTid);
    expect(credited.statusCode).toBe(200);
    expect(credited.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'succeeded',
      providerRef: approvalTid,
      needsReview: false,
    });
    expect((await settleActions())[0]).toMatchObject({
      payload: { outcome: 'credit', from: 'failed', tid: approvalTid },
    });

    const cancelled = await failedUnanswered();
    const closed = await settle(cancelled.id, 'cancelled');
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'cancelled',
      needsReview: false,
    });
    expect((await eventsOf(cancelled.id)).at(-1)).toMatchObject({
      type: 'net_cancel',
      payload: { outcome: 'cancelled', manual: true },
    });

    // Checked in the merchant admin: never charged. It stays failed, and is no longer flagged.
    const checked = await failedUnanswered();
    const confirmed = await settle(checked.id, 'failed');
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ data: AdminPayment }>().data).toMatchObject({
      status: 'failed',
      resultMessage: '관리자 수동 정리',
    });
    await age(checked.id);
    expect((await listed(checked.id)).needsReview).toBe(false);
    // An approval 재통보 that cannot be credited afterwards flags it again, and cannot be
    // credited by hand either.
    expect(
      (
        await postNotify(
          notifyForm({ paymentId: checked.id, priceKrw: 9_700, tid: testTid(), amt: '100' }),
        )
      ).body,
    ).toBe('OK');
    await age(checked.id);
    expect((await listed(checked.id)).needsReview).toBe(true);
    expect((await settle(checked.id, 'credit')).json()).toMatchObject({
      error: { details: [{ message: 'approval_mismatch' }] },
    });

    // A claimed payment the approval itself refused was never charged: not flagged.
    const refused = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    pg.onApprove = () =>
      approvalAnswer({
        paymentId: refused.id,
        priceKrw: refused.priceKrw,
        tid,
        resultCode: '3011',
        resultMsg: '카드번호 오류',
      });
    expect(
      String((await postReturn(refused.id, { Tid: tid, TrAuthKey: 'k' })).headers.location),
    ).toContain('result=failed');
    await age(refused.id);
    expect((await listed(refused.id)).needsReview).toBe(false);

    expectLedgerChain(await ledgerOf(member.id), SIGNUP_BONUS_P + 10_000n);
  });

  it('waits out anything that may still be working on the payment (in_progress)', async () => {
    const { id } = await unanswered();
    const early = await settle(id, 'credit');
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      error: {
        code: 'REFUND_NOT_ALLOWED',
        details: [{ path: ['payment'], message: 'in_progress' }],
      },
    });
    // Just inside the 2 minutes: still refused.
    await t.db
      .update(schema.payments)
      .set({ updatedAt: sql`now() - interval '110 seconds'` })
      .where(eq(schema.payments.id, id));
    expect((await settle(id, 'credit')).json()).toMatchObject({
      error: { details: [{ message: 'in_progress' }] },
    });
    // A refund attempt stamps its payment too: a fresh `refunding` one waits as well.
    const refunding = await refundUnanswered();
    expect((await settle(refunding.id, 'restore')).json()).toMatchObject({
      error: { details: [{ message: 'in_progress' }] },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'pending' });
    expect(await settleActions()).toHaveLength(0);
  });

  it('settles SmartroPay payments only, and only the states it can decide', async () => {
    const mock = await reserveSmartroPayment(t.db, member.id);
    await t.db
      .update(schema.payments)
      .set({ provider: 'mock', updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.payments.id, mock.id));
    expect((await settle(mock.id, 'failed')).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'provider' }] },
    });
    expect((await listed(mock.id)).needsReview).toBe(false);

    // A charge that succeeded is refunded, never settled.
    const { id } = await unanswered();
    await age(id);
    expect((await settleCredit(id, testTid())).statusCode).toBe(200);
    await age(id);
    for (const outcome of ['credit', 'cancelled', 'failed', 'refunded', 'restore']) {
      expect((await settle(id, outcome, admin.cookie, REASON, testTid())).json()).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }
    expect((await listed(id)).needsReview).toBe(false);
  });

  it('validates the request: admin only, a known outcome, a reason, a known payment', async () => {
    const { id } = await unanswered();
    await age(id);
    expect((await settle(id, 'credit', member.cookie)).statusCode).toBe(403);
    expect((await settle(id, 'succeeded')).statusCode).toBe(400);
    expect((await settle(id, 'credit', admin.cookie, '   ')).statusCode).toBe(400);
    expect((await settle(id, 'credit', admin.cookie, REASON, '')).statusCode).toBe(400);
    expect((await settle(id, 'credit', admin.cookie, REASON, 'two words')).statusCode).toBe(400);
    expect((await settle('3f1a5b6c-1111-4222-8333-444455556666', 'credit')).statusCode).toBe(404);
    expect((await settle('not-a-uuid', 'credit')).statusCode).toBe(400);
    expect(await paymentRow(id)).toMatchObject({ status: 'pending' });
    expect(await settleActions()).toHaveLength(0);
  });
});
