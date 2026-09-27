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
  TEST_SMARTRO,
  approvalAnswer,
  formBody,
  reserveSmartroPayment,
  testTid,
} from '../test/smartro.js';
import { sleep } from '../test/wait.js';
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

  /** A SmartroPay charge of `member`, approved through the ReturnUrl like a real one. */
  async function smartroCharge(): Promise<{ id: string; tid: string }> {
    const payment = await reserveSmartroPayment(t.db, member.id, { packageId: pack.id });
    const tid = testTid();
    pg.onApprove = () => approvalAnswer({ paymentId: payment.id, priceKrw: payment.priceKrw, tid });
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

      // The first attempt's answer lands after all: the payment is already refunded, so it
      // changes nothing and says so for a person to check.
      release();
      expect((await first).statusCode).toBe(200);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`cancelled ${tid} but the payment was no longer refunding`),
      );
    } finally {
      error.mockRestore();
    }
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P);
  });
});
