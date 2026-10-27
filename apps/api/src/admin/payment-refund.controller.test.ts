/**
 * `POST /admin/payments/:id/refund` (ADR-0042 「관리자 환불」) against the docker `test` profile:
 * claw the Coin back, cancel at the PG, compensate on a refusal, stay `refunding` on silence.
 *
 * Paid Coin is opened for this app (`paidCoinSales: true`): the refund is preserved code, closed
 * in production while sales are off (ADR-0049; paid-coin-sales.test.ts proves that). Payments
 * come from the mock's immediate charge, and the mock's `cancel` is scripted per test to answer
 * as a PG would — a confirmation, a refusal, or nothing. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { schema } from '@buddha/db';
import {
  userChannel,
  type AdminPayment,
  type ChargeResult,
  type PaymentStatus,
} from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MockPaymentProvider } from '../payments/mock-payment.provider.js';
import { type CancelOutcome, type CancelRequest } from '../payments/payment-provider.js';
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
import { sleep } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const REASON = '고객 청약철회 요청 (7일 이내, 미사용)';

/** A PG that gave no answer: what a timed-out cancel call throws. */
class GatewayUnreachableError extends Error {
  override name = 'GatewayUnreachableError';
}

describe.skipIf(!hasTestInfra)('admin payment refund (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  /** 10,000 Coin for 9,700원. */
  let pack: TestPackage;
  /** Every cancel the provider was asked for, in order. */
  let cancels: CancelRequest[];
  /** How the provider answers the next cancel; the mock's own answer unless a test scripts it. */
  let onCancel: (request: CancelRequest) => CancelOutcome | Promise<CancelOutcome>;
  let mockCancel: (request: CancelRequest) => Promise<CancelOutcome>;

  beforeAll(async () => {
    t = await createTestApp({ paidCoinSales: true });
    // The registry holds this instance, so a refund of a `mock` payment reaches the spy.
    const mock = t.app.get(MockPaymentProvider);
    mockCancel = mock.cancel.bind(mock);
    vi.spyOn(mock, 'cancel').mockImplementation(async (request) => {
      cancels.push(request);
      return onCancel(request);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    cancels = [];
    onCancel = mockCancel;
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

  /** A charge of `member` through the immediate flow: 10,000 Coin credited. */
  async function charge(): Promise<{ id: string; providerRef: string }> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(member.cookie),
      payload: chargeBody(pack, member.id),
    });
    expect(res.statusCode).toBe(200);
    const { payment } = res.json<{ data: ChargeResult }>().data;
    return { id: payment.id, providerRef: payment.providerRef! };
  }

  /** A payment row of `member` that no charge credited (`pending`, `failed`). */
  async function uncredited(status: PaymentStatus): Promise<string> {
    const [row] = await t.db
      .insert(schema.payments)
      .values({
        userId: member.id,
        amountCoin: pack.amountCoin,
        priceKrw: pack.priceKrw,
        packageId: pack.id,
        provider: 'mock',
        status,
        idempotencyKey: randomUUID(),
      })
      .returning();
    return row!.id;
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

  const refused = (resultCode: string, resultMessage: string): CancelOutcome => ({
    status: 'refused',
    resultCode,
    resultMessage,
  });
  const unreachable = (): never => {
    throw new GatewayUnreachableError('timed out');
  };

  /** A refund whose cancel got no answer: `refunding`, the Coin clawed back (502). */
  async function stuckRefunding(id: string): Promise<void> {
    onCancel = unreachable;
    expect((await refund(id)).statusCode).toBe(502);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
  }

  it('refunds an unused charge: Coin out, the whole amount cancelled at its provider', async () => {
    const { id, providerRef } = await charge();
    expect((await balanceOf(member.id)).availableCoin).toBe(10_000n);

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
      provider: 'mock',
      providerRef,
      status: 'refunded',
      amountCoin: '10000',
      priceKrw: 9_700,
    });
    expect(body.refundedAt).toEqual(expect.any(String));

    // What the provider received: a full cancel of the KRW paid, with the admin's reason.
    expect(cancels).toEqual([
      { paymentId: id, providerRef, priceKrw: 9_700, reason: REASON, method: null },
    ]);

    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => [entry.type, entry.amountCoin])).toEqual([
      ['DEPOSIT', 10_000n],
      ['PAYMENT_CANCEL', -10_000n],
    ]);
    expect(ledger[1]).toMatchObject({ refType: 'payment', refId: id });
    expectLedgerChain(ledger, 0n);

    // Audited in the claw-back's own transaction (admin-audit.test's rule).
    const actions = await refundActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      adminId: admin.id,
      targetType: 'payment',
      targetId: id,
      payload: { amountCoin: '10000', priceKrw: 9_700, provider: 'mock', memo: REASON },
    });
    expect(actions[0]!.createdAt.getTime()).toBe(ledger[1]!.createdAt.getTime());

    expect((await eventsOf(id)).map((event) => event.type)).toEqual(['refund_cancel']);

    // The balance screen hears about the claw-back without a reload (PLAN 8).
    expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
      {
        type: 'user:balance',
        availableCoin: '0',
        lockedCoin: '0',
        ledgerEntryId: ledger[1]!.id.toString(),
        ts: ledger[1]!.createdAt.toISOString(),
      },
    ]);
  });

  it("answers a replayed charge key with the charge's DEPOSIT after the refund, never the claw-back", async () => {
    // The refund's PAYMENT_CANCEL sits under the same reference (payment, id) as the DEPOSIT,
    // and is the newer of the two — first in the (user_id, created_at DESC) index.
    const key = 'refunded-mock-charge-key';
    const buy = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(member.cookie, key),
        payload: chargeBody(pack, member.id),
      });
    const first = await buy();
    expect(first.statusCode).toBe(200);
    const charged = first.json<{ data: ChargeResult }>().data;
    expect((await refund(charged.payment.id)).statusCode).toBe(200);

    const replay = await buy();
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json<{ data: ChargeResult }>().data;
    expect(replayed.ledgerEntry).toEqual(charged.ledgerEntry);
    expect(replayed.ledgerEntry).toMatchObject({ type: 'DEPOSIT', amountCoin: '10000' });
    // The payment and the balance as they are now; the replay bought nothing.
    expect(replayed.payment).toMatchObject({ id: charged.payment.id, status: 'refunded' });
    expect(replayed.balance.availableCoin).toBe('0');
    expect((await ledgerOf(member.id)).map((entry) => entry.type)).toEqual([
      'DEPOSIT',
      'PAYMENT_CANCEL',
    ]);
  });

  it('refuses once part of the Coin is used (INSUFFICIENT_BALANCE), changing nothing', async () => {
    const { id } = await charge();
    // Spend 1 Coin of the charge (a new account has nothing else, #70): 9,999 Coin left against
    // a 10,000 Coin payment.
    const spent = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${member.id}/balance-adjust`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { amountCoin: '-1', memo: 'spent' },
    });
    expect(spent.statusCode).toBe(200);

    const res = await refund(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } });
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded', refundedAt: null });
    expect((await balanceOf(member.id)).availableCoin).toBe(9_999n);
    expect(await refundActions()).toHaveLength(0);
    expect(cancels).toHaveLength(0);
  });

  it('refuses after the refund window, and for a payment that is not a settled charge', async () => {
    const { id } = await charge();
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

    for (const status of ['pending', 'failed'] as const) {
      const res = await refund(await uncredited(status));
      expect(res.json(), status).toMatchObject({
        error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'status' }] },
      });
    }

    // A provider this deployment cannot reach (a row from some other PG).
    const foreign = await charge();
    await t.db
      .update(schema.payments)
      .set({ provider: 'acme' })
      .where(eq(schema.payments.id, foreign.id));
    expect((await refund(foreign.id)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'provider' }] },
    });

    expect(await refundActions()).toHaveLength(0);
    expect(cancels).toHaveLength(0);
  });

  it('validates the request: admin only, a reason, a known payment', async () => {
    const { id } = await charge();
    expect((await refund(id, REASON, member.cookie)).statusCode).toBe(403);
    expect((await refund(id, '   ')).statusCode).toBe(400);
    expect((await refund('3f1a5b6c-1111-4222-8333-444455556666')).statusCode).toBe(404);
    expect((await refund('not-a-uuid')).statusCode).toBe(400);
    expect(await paymentRow(id)).toMatchObject({ status: 'succeeded' });
  });

  it('puts the Coin back when the PG refuses the cancel (PAYMENT_CANCEL_REVERSAL)', async () => {
    const { id } = await charge();
    onCancel = () => refused('2002', '취소 불가 거래');
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
    expect(ledger.map((entry) => [entry.type, entry.amountCoin])).toEqual([
      ['DEPOSIT', 10_000n],
      ['PAYMENT_CANCEL', -10_000n],
      ['PAYMENT_CANCEL_REVERSAL', 10_000n],
    ]);
    expectLedgerChain(ledger, 10_000n);
    // The attempt stays audited: the Coin did leave the balance, if only for a moment.
    expect(await refundActions()).toHaveLength(1);
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: '2002',
      resultMessage: '취소 불가 거래',
    });
  });

  it('stays refunding when the PG does not answer, and a retry finishes it', async () => {
    const { id } = await charge();
    onCancel = unreachable;
    const first = await refund(id);
    expect(first.statusCode).toBe(502);
    // Sealed like any 5xx: the code survives, the message does not.
    expect(first.json()).toEqual({
      error: { code: 'PAYMENT_GATEWAY_ERROR', message: 'Internal server error' },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    expect((await balanceOf(member.id)).availableCoin).toBe(0n);
    // What broke is recorded by its name only: an error's text can carry the request.
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: null,
      payload: { error: 'GatewayUnreachableError' },
    });

    // The first cancel did reach the card after all: the retry hears "already cancelled".
    onCancel = () => ({ status: 'cancelled', resultCode: '2013', resultMessage: '기취소 거래' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });

    expect(cancels).toHaveLength(2);
    expect(cancels[1]).toMatchObject({ reason: '재시도' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, 0n);
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
    const { id } = await charge();
    const responses = await Promise.all([refund(id), refund(id)]);
    const statuses = responses.map((res) => res.statusCode).sort();
    // The loser found it `refunding` with the winner's cancel in flight (DUPLICATE_REQUEST), or
    // already `refunded`, or lost the claw-back's lock (REFUND_NOT_ALLOWED). Either way: 409,
    // one claw-back and one cancel.
    expect(statuses).toEqual([200, 409]);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, 0n);
    expect(await refundActions()).toHaveLength(1);
    expect(cancels).toHaveLength(1);
  });

  it('runs one cancel at a time: a retry waits out an attempt still in flight', async () => {
    const { id, providerRef } = await charge();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers: (() => Promise<CancelOutcome>)[] = [
      // The first attempt hangs on the PG, and in the end hears "already cancelled".
      async () => {
        await gate;
        return { status: 'cancelled', resultCode: '2013', resultMessage: '기취소 거래' };
      },
      () => Promise.resolve({ status: 'cancelled', resultCode: '2001' }),
    ];
    onCancel = () => answers[cancels.length - 1]!();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      // light-my-request dispatches lazily: `.then` is what sends the request.
      const first = refund(id).then((res) => res);
      await vi.waitFor(() => {
        expect(cancels).toHaveLength(1);
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
      expect(cancels).toHaveLength(1);
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
      expect(cancels).toHaveLength(2);
      expect(await refundActions()).toHaveLength(2);

      // The first attempt's answer lands after all: the payment is already refunded — the
      // same end — so it changes nothing, and no alarm goes off over it.
      release();
      expect((await first).statusCode).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`cancelled ${providerRef}; it was refunded already`),
      );
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('no longer refunding'));
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, 0n);
  });

  // --- a retry never puts the Coin back by itself (PAY-1) -----------------------------

  it('keeps a refused retry refunding with the Coin still out', async () => {
    const { id } = await charge();
    await stuckRefunding(id);

    // The first attempt may have cancelled the card: this "no" must not give the Coin back.
    onCancel = () => refused('2002', '취소 실패');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let retry: Awaited<ReturnType<typeof refund>>;
    try {
      retry = await refund(id, '재시도');
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/refused the retried cancel \(2002\).*left refunding/),
      );
    } finally {
      error.mockRestore();
    }
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: {
        code: 'PAYMENT_GATEWAY_REFUSED',
        details: [{ path: ['gateway'], message: '2002 취소 실패' }],
      },
    });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding', refundedAt: null });
    expect((await balanceOf(member.id)).availableCoin).toBe(0n);
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, 0n);
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: '2002',
    });
    // Its answer is recorded, so the next retry need not wait out the lease.
    onCancel = () => ({ status: 'cancelled', resultCode: '2013' });
    expect((await refund(id, '다시')).statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
  });

  it('keeps an answer that leaves the card unknown refunding; a retry then finishes it', async () => {
    const { id } = await charge();
    onCancel = () => ({ status: 'unknown', resultMessage: '시스템 오류' });
    const first = await refund(id);
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ error: { code: 'PAYMENT_GATEWAY_ERROR' } });
    expect(await paymentRow(id)).toMatchObject({ status: 'refunding' });
    expect((await balanceOf(member.id)).availableCoin).toBe(0n);
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      type: 'refund_cancel',
      resultCode: null,
      resultMessage: '시스템 오류',
    });
    expect(
      (await ledgerOf(member.id)).filter((entry) => entry.type === 'PAYMENT_CANCEL_REVERSAL'),
    ).toHaveLength(0);

    onCancel = () => ({ status: 'cancelled', resultCode: '2013' });
    const retry = await refund(id, '재시도');
    expect(retry.statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(1);
    expectLedgerChain(ledger, 0n);
  });

  it('never restores a first attempt a retry took over: the retry decides', async () => {
    const { id, providerRef } = await charge();
    let refuseFirst: () => void = () => undefined;
    let answerRetry: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => (refuseFirst = resolve));
    const retryGate = new Promise<void>((resolve) => (answerRetry = resolve));
    const answers: (() => Promise<CancelOutcome>)[] = [
      async () => {
        await firstGate;
        return refused('2002', '취소 실패');
      },
      async () => {
        await retryGate;
        return { status: 'cancelled', resultCode: '2001' };
      },
    ];
    onCancel = () => answers[cancels.length - 1]!();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const first = refund(id).then((res) => res);
      await vi.waitFor(() => {
        expect(cancels).toHaveLength(1);
      });
      // The first attempt's stamp: the claw-back's clock, written with its audit row.
      const firstStamp = (await paymentRow(id)).updatedAt;
      expect((await refundActions())[0]!.createdAt).toEqual(firstStamp);
      // The first attempt outlives its lease (a slow PG): a retry takes the payment over, and
      // its cancel is on the card when the first attempt's refusal finally lands.
      await t.db
        .update(schema.payments)
        .set({ updatedAt: sql`now() - interval '70 seconds'` })
        .where(eq(schema.payments.id, id));
      const aged = (await paymentRow(id)).updatedAt;
      const retry = refund(id, '재시도').then((res) => res);
      await vi.waitFor(() => {
        expect(cancels).toHaveLength(2);
      });
      // What the first attempt's restore will find is the RETRY's lease — its own stamp, written
      // with its audit row — not the aging above: that is what keeps the Coin out. (A takeRetry
      // that stamped nothing would leave the aged value, which differs from the first stamp too,
      // and pass the rest of this test.)
      const retryAction = (await refundActions()).find(
        (action) => (action.payload as { retry?: boolean }).retry === true,
      );
      const leased = (await paymentRow(id)).updatedAt;
      expect(leased).toEqual(retryAction!.createdAt);
      expect(leased.getTime()).toBeGreaterThan(aged.getTime());
      expect(leased.getTime()).toBeGreaterThan(firstStamp.getTime());

      refuseFirst();
      const late = await first;
      // Not this attempt's any more: nothing put back, left to the retry.
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({
        error: {
          code: 'PAYMENT_GATEWAY_REFUSED',
          details: [{ path: ['gateway'], message: '2002 취소 실패' }],
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
    expect(await paymentRow(id)).toMatchObject({ status: 'refunded', providerRef });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, 0n);
  });

  it('answers an unanswered attempt a retry took over and finished as refunded', async () => {
    // The first attempt outlives its lease; a retry takes over and the PG cancels the card. The
    // first attempt's call then times out: the refund is done, so that is no error either.
    const { id } = await charge();
    let silenceFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => (silenceFirst = resolve));
    const answers: (() => Promise<CancelOutcome>)[] = [
      async () => {
        await firstGate;
        return unreachable();
      },
      () => Promise.resolve({ status: 'cancelled', resultCode: '2001' }),
    ];
    onCancel = () => answers[cancels.length - 1]!();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const first = refund(id).then((res) => res);
      await vi.waitFor(() => {
        expect(cancels).toHaveLength(1);
      });
      await t.db
        .update(schema.payments)
        .set({ updatedAt: sql`now() - interval '70 seconds'` })
        .where(eq(schema.payments.id, id));
      expect((await refund(id, '재시도')).statusCode).toBe(200);
      expect(await paymentRow(id)).toMatchObject({ status: 'refunded' });

      silenceFirst();
      const late = await first;
      expect(late.statusCode).toBe(200);
      expect(late.json<{ data: AdminPayment }>().data).toMatchObject({ status: 'refunded' });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'refund_cancel', resultCode: null });
    const ledger = await ledgerOf(member.id);
    expect(ledger.map((entry) => entry.type)).toEqual(['DEPOSIT', 'PAYMENT_CANCEL']);
    expectLedgerChain(ledger, 0n);
  });

  it('claims no refunding left when the payment moved elsewhere while its cancel was in flight', async () => {
    // Defensive: nothing else moves a `refunding` payment anywhere but `refunded` today.
    // Simulated by moving the row straight to `succeeded` while the PG holds the cancel: the
    // answer is recorded, nothing is restored, and the error claims no `refunding` to retry.
    const paths: {
      name: string;
      retry: boolean;
      answer: () => CancelOutcome;
      status: number;
      body: unknown;
    }[] = [
      {
        name: 'refused retry',
        retry: true,
        answer: () => refused('2002', '취소 실패'),
        status: 409,
        body: {
          error: {
            code: 'PAYMENT_GATEWAY_REFUSED',
            message: 'The payment gateway refused the retried cancel',
            details: [{ path: ['gateway'], message: '2002 취소 실패' }],
          },
        },
      },
      {
        name: 'unanswered first attempt',
        retry: false,
        answer: unreachable,
        status: 502,
        body: { error: { code: 'PAYMENT_GATEWAY_ERROR', message: 'Internal server error' } },
      },
      {
        name: 'unanswered retry',
        retry: true,
        answer: () => ({ status: 'unknown', resultMessage: '시스템 오류' }),
        status: 502,
        body: { error: { code: 'PAYMENT_GATEWAY_ERROR', message: 'Internal server error' } },
      },
    ];
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (const path of paths) {
        const { id } = await charge();
        if (path.retry) await stuckRefunding(id);
        error.mockClear();
        onCancel = async () => {
          await t.db
            .update(schema.payments)
            .set({ status: 'succeeded', updatedAt: sql`now()` })
            .where(eq(schema.payments.id, id));
          return path.answer();
        };
        const res = await refund(id, path.retry ? '재시도' : REASON);
        expect(res.statusCode, path.name).toBe(path.status);
        expect(res.json(), path.name).toEqual(path.body);
        expect(error, path.name).toHaveBeenCalledTimes(1);
        expect(error, path.name).toHaveBeenCalledWith(
          expect.stringMatching(/the payment was succeeded, no longer refunding/),
        );
        expect(await paymentRow(id), path.name).toMatchObject({
          status: 'succeeded',
          refundedAt: null,
        });
        expect((await eventsOf(id)).at(-1), path.name).toMatchObject({ type: 'refund_cancel' });
      }
    } finally {
      error.mockRestore();
    }
    // Nothing put back by the refund: each charge's claw-back stands, with no reversal.
    const ledger = await ledgerOf(member.id);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL')).toHaveLength(paths.length);
    expect(ledger.filter((entry) => entry.type === 'PAYMENT_CANCEL_REVERSAL')).toHaveLength(0);
    expectLedgerChain(ledger, 0n);
  });

  // --- the policy's edges (T3) ---------------------------------------------------------

  it('refunds just inside the window, and counts from created_at when approved_at is null', async () => {
    const inside = await charge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: sql`now() - interval '6 days 23 hours'` })
      .where(eq(schema.payments.id, inside.id));
    expect((await refund(inside.id)).statusCode).toBe(200);
    expect(await paymentRow(inside.id)).toMatchObject({ status: 'refunded' });

    // A row credited before approved_at existed: its reservation's own time decides.
    const old = await charge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: null, createdAt: sql`now() - interval '8 days'` })
      .where(eq(schema.payments.id, old.id));
    expect((await refund(old.id)).json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ message: 'window_closed' }] },
    });
    const recent = await charge();
    await t.db
      .update(schema.payments)
      .set({ approvedAt: null })
      .where(eq(schema.payments.id, recent.id));
    expect((await refund(recent.id)).statusCode).toBe(200);
    expect(await paymentRow(recent.id)).toMatchObject({ status: 'refunded' });
  });

  it("refunds when exactly the payment's Coin is still available", async () => {
    // Other Coin first, then spent: 10,000 Coin left against a 10,000 Coin payment — none of it
    // used. (A new account starts at 0, #70.)
    const adjustBy = (amountCoin: string, memo: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${member.id}/balance-adjust`,
        headers: { ...jsonHeaders, cookie: admin.cookie },
        payload: { amountCoin, memo },
      });
    expect((await adjustBy('2500', 'other coin')).statusCode).toBe(200);
    const { id } = await charge();
    expect((await adjustBy('-2500', 'spent the other coin')).statusCode).toBe(200);
    expect((await balanceOf(member.id)).availableCoin).toBe(10_000n);

    const res = await refund(id);
    expect(res.statusCode).toBe(200);
    expect((await balanceOf(member.id)).availableCoin).toBe(0n);
    expectLedgerChain(await ledgerOf(member.id), 0n);
  });
});
