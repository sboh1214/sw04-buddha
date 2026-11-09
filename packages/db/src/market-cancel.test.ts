import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MARKET_CANCEL_APPROVAL_KIND, MARKET_STATUSES } from '@buddha/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { burnMarketMakerPairs } from './contracts.js';
import {
  cancelScheduledMarket,
  marketHasHumanFill,
  type CancelScheduledMarketInput,
} from './market-cancel.js';
import { closeMarketAtClose } from './market-close.js';
import { submitMarketDispute } from './market-dispute.js';
import { recordJudgementDelay } from './market-judgement-delay.js';
import { approveMarketJudgement } from './market-judgement.js';
import { openScheduledMarket } from './market-open.js';
import { pauseMarket } from './market-pause.js';
import { transitionMarket } from './market-transitions.js';
import { lockMarketOrders } from './order-cancel.js';
import {
  approvalRequests,
  ledgerEntries,
  marketEvents,
  marketSettlementSteps,
  markets,
  orders,
} from './schema/index.js';
import {
  cancelScheduledMarketNow,
  closeMarketEarly,
  createFill,
  createJudgementRequest,
  createMarket,
  createMarketCancelRequest,
  createScheduledMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { balanceOf, fundMarketMakerFunds, mintTestPairs } from './test/ledger.js';
import {
  CANCELLED_MARKET_HUMAN_FILLS_CHECK_SQL,
  CANCELLED_MARKET_LIVE_ORDERS_CHECK_SQL,
  NO_MARKET_STATS,
  cancelTestOrder,
  checkCancelledMarkets,
  checkMarketStats,
  checkOrderInvariants,
  closeTestMarket,
  createOrder,
  marketStatsOf,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  tradeOnce,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/** Thrown to roll a probing transaction back. */
class Probed extends Error {}

/**
 * 거래 없는 시장의 취소 (#20, ADR-0117; ADR-0107 결정 5 '#20·#120 거래가 전혀 없던과 자동
 * CANCELLED', '#20 운영자의 취소 경로', '#20 CANCELLED 시장의 결과 유형'): the one judgement of
 * '사용자 체결 0건' (`marketHasHumanFill`), the operator's SCHEDULED → CANCELLED
 * (`cancelScheduledMarket`) and its race with the scheduled open, and what a CANCELLED market
 * refuses from then on — against the test database. The close and the early close that cancel are
 * market-close.test.ts's and market-pause.test.ts's.
 */
describe.skipIf(!hasTestDb())('market cancel (#20, docker test profile)', () => {
  let t: TestDb;
  let adminId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;
  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const rowOf = async (id: string) =>
    (await t.db.select().from(markets).where(eq(markets.id, id)))[0]!;
  const eventsOf = (id: string) =>
    t.db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.marketId, id))
      .orderBy(asc(marketEvents.id));
  const expectSound = async () => {
    expect(await checkOrderInvariants(t.db)).toEqual([]);
    expect(await checkMarketStats(t.db)).toEqual([]);
    expect(await checkCancelledMarkets(t.db)).toEqual([]);
  };
  /** Holds `marketId`'s lock on a connection of its own until `release` is called. */
  async function holdMarket(marketId: string) {
    const holder = await t.db.$client.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [marketId]);
    return {
      release: async () => {
        await holder.query('ROLLBACK');
        holder.release();
      },
    };
  }

  type Approving = Omit<CancelScheduledMarketInput, 'market' | 'orders' | 'now'>;

  /**
   * As the approval cancels: the market lock, the row FOR UPDATE after it, its orders locked, the
   * clock, then `cancelScheduledMarket`; the request is marked approved only when it cancelled (the
   * API refuses the approval otherwise, so its transaction writes nothing).
   */
  function approve(marketId: string, input: Approving) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const locked = await lockMarketOrders(tx, marketId);
      const now = await clockTimestamp(tx);
      const result = await cancelScheduledMarket(tx, {
        market: market!,
        orders: locked,
        now,
        ...input,
      });
      if (result.cancelled) {
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: input.approverId,
            decisionReason: '확인함',
            decidedAt: now,
          })
          .where(eq(approvalRequests.id, input.approvalId));
      }
      return { now, result };
    });
  }

  /** A pending `market_cancel` request of the market and what its approval passes. */
  async function requested(marketId: string, statusEventId?: number): Promise<Approving> {
    const requestedBy = await admin();
    const request = await createMarketCancelRequest(t.db, {
      marketId,
      by: requestedBy,
      ...(statusEventId === undefined ? {} : { statusEventId }),
    });
    return {
      approverId: await admin(),
      approvalId: request.id,
      requestedBy,
      reason: request.requestReason,
      statusEventId: (request.payload as { statusEventId: number }).statusEventId,
    };
  }

  /** The worker's open, in its own transaction (`openScheduledMarket`, `source: 'job'`). */
  const openNow = (marketId: string) =>
    t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const now = await clockTimestamp(tx);
      return openScheduledMarket(tx, { market: market!, now, actorId: null, source: 'job' });
    });

  describe('marketHasHumanFill', () => {
    it('is false with no fill, with resting orders alone, and with orders that never filled', async () => {
      const empty = await createMarket(t.db);
      expect(await marketHasHumanFill(t.db, empty.id)).toBe(false);
      const resting = await createMarket(t.db);
      const mm = await fundMarketMakerFunds(t.db, resting.id, 500n);
      await placeTestOrder(t.db, { ownerId: mm, marketId: resting.id, limitPriceCoin: 30 });
      const a = await member();
      await placeTestOrder(t.db, { ownerId: a, marketId: resting.id, limitPriceCoin: 20 });
      // An IOC that found nothing to fill.
      await placeTestOrder(t.db, {
        ownerId: a,
        marketId: resting.id,
        outcome: 'NO',
        timeInForce: 'ioc',
        limitPriceCoin: 30,
      });
      expect(await marketHasHumanFill(t.db, resting.id)).toBe(false);
      // Another market's fill is not this one's.
      await tradeOnce(t.db, empty.id);
      expect(await marketHasHumanFill(t.db, resting.id)).toBe(false);
    });

    it('is true for a person ↔ person fill, a person ↔ 운영 마켓메이커 fill either way, a pair mint and a partial fill', async () => {
      const minted = await createMarket(t.db);
      await tradeOnce(t.db, minted.id);
      // The 운영 마켓메이커 rests, a person fills it — and the other way round.
      const botResting = await createMarket(t.db);
      const mm = await fundMarketMakerFunds(t.db, botResting.id, 500n);
      await placeTestOrder(t.db, {
        ownerId: mm,
        marketId: botResting.id,
        outcome: 'NO',
        limitPriceCoin: 50,
      });
      await placeTestOrder(t.db, {
        ownerId: await member(),
        marketId: botResting.id,
        timeInForce: 'ioc',
      });
      const botIncoming = await createMarket(t.db);
      await fundMarketMakerFunds(t.db, botIncoming.id, 500n);
      await createFill(t.db, { marketId: botIncoming.id, userId: mm, amountCoin: 50n, qty: 1 });
      const paired = await createMarket(t.db);
      await fundMarketMakerFunds(t.db, paired.id, 500n);
      await mintTestPairs(t.db, {
        marketId: paired.id,
        yesHolderId: await member(),
        noHolderId: mm,
        qty: 2,
      });
      const partial = await createMarket(t.db);
      await placeTestOrder(t.db, {
        ownerId: await member(),
        marketId: partial.id,
        outcome: 'NO',
        limitPriceCoin: 50,
        qty: 3,
      });
      await placeTestOrder(t.db, {
        ownerId: await member(),
        marketId: partial.id,
        timeInForce: 'ioc',
      });
      for (const m of [minted, botResting, botIncoming, paired, partial]) {
        expect(await marketHasHumanFill(t.db, m.id), m.id).toBe(true);
      }
    });
  });

  describe('cancelScheduledMarket', () => {
    it('cancels a SCHEDULED market: the approver’s cancelled event, the request’s reason, the result empty', async () => {
      const { market: scheduled } = await createScheduledMarket(t.db, {
        scheduledOpenAt: new Date(Date.now() + 3_600_000),
      });
      const approving = await requested(scheduled.id);
      expect(approving.statusEventId).toBe(scheduled.statusEventId);
      const entries = (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n;
      const { now, result } = await approve(scheduled.id, approving);
      if (!result.cancelled) throw new Error('cancelled');
      expect(result.expired).toEqual({ expired: [], held: [], touched: { positions: [] } });
      expect((await eventsOf(scheduled.id)).at(-1)).toEqual({
        id: result.eventId,
        marketId: scheduled.id,
        type: 'cancelled',
        actorId: approving.approverId,
        fromStatus: 'scheduled',
        toStatus: 'cancelled',
        payload: {
          cancelledAt: now.toISOString(),
          source: 'operator',
          reason: approving.reason,
          approvalId: approving.approvalId,
          requestedBy: approving.requestedBy,
        },
        createdAt: now,
      });
      // Nothing else of the market moves: its times, its statistics, no result, no open.
      expect(await rowOf(scheduled.id)).toEqual({
        ...scheduled,
        status: 'cancelled',
        statusEventId: result.eventId,
        updatedAt: now,
      });
      expect(result.market).toMatchObject({
        resolvedResult: null,
        openAt: null,
        ruleVersion: null,
      });
      expect(await marketStatsOf(t.db, scheduled.id)).toEqual(NO_MARKET_STATS);
      expect((await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n).toBe(entries);
      // The request keeps who asked, who decided, when and both reasons.
      const [request] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approving.approvalId));
      expect(request).toMatchObject({
        kind: MARKET_CANCEL_APPROVAL_KIND,
        targetType: 'market',
        targetId: scheduled.id,
        status: 'approved',
        requestedBy: approving.requestedBy,
        decidedBy: approving.approverId,
        decidedAt: now,
      });
      await expectSound();
    });

    it.each(MARKET_STATUSES.filter((status) => status !== 'scheduled'))(
      'skips a %s market as not_scheduled, writing nothing — no operator path from it',
      async (status) => {
        const market = await createMarket(t.db, { status });
        const approving = await requested(market.id, 1);
        expect((await approve(market.id, approving)).result).toEqual({
          cancelled: false,
          reason: 'not_scheduled',
        });
        expect(await rowOf(market.id)).toEqual(market);
        expect(await eventsOf(market.id)).toEqual([]);
      },
    );

    it('skips a request asked in an earlier SCHEDULED state as stale: sent back and approved again', async () => {
      const { market: scheduled } = await createScheduledMarket(t.db, {
        scheduledOpenAt: new Date(Date.now() + 3_600_000),
      });
      const old = await requested(scheduled.id);
      // 되돌리기 and a new review: SCHEDULED again, under a newer status event.
      for (const [from, to, type] of [
        ['scheduled', 'draft', 'reverted'],
        ['draft', 'review', 'submitted'],
        ['review', 'scheduled', 'approved'],
      ] as const) {
        await t.db.transaction(async (tx) => {
          await lockMarket(tx, scheduled.id);
          await transitionMarket(tx, {
            marketId: scheduled.id,
            from,
            to,
            type,
            actorId: adminId,
            at: await clockTimestamp(tx),
          });
        });
      }
      const again = await rowOf(scheduled.id);
      expect(again.status).toBe('scheduled');
      expect((await approve(scheduled.id, old)).result).toEqual({
        cancelled: false,
        reason: 'stale',
      });
      expect(await rowOf(scheduled.id)).toEqual(again);
      // A request of the new state cancels it.
      expect((await approve(scheduled.id, await requested(scheduled.id))).result).toMatchObject({
        cancelled: true,
      });
    });

    it('throws on an approval by the requester, writing nothing', async () => {
      const { market: scheduled } = await createScheduledMarket(t.db);
      const approving = await requested(scheduled.id);
      await expect(
        approve(scheduled.id, { ...approving, approverId: approving.requestedBy }),
      ).rejects.toThrow('approved by an admin other than its requester');
      expect(await rowOf(scheduled.id)).toEqual(scheduled);
      await expect(
        cancelScheduledMarketNow(t.db, scheduled.id, { requestedBy: adminId, approvedBy: adminId }),
      ).rejects.toThrow('the requester never approves the cancel');
    });

    it('cancels one past its open and its close, and ends a live order a test left 만료', async () => {
      // No time is checked (ADR-0107 결정 5 says SCHEDULED only); and every entry into CANCELLED
      // ends what is live, though a SCHEDULED market takes no order (#177 7·8항).
      const { market: scheduled } = await createScheduledMarket(t.db);
      const a = await member();
      const refused = await placeTestOrder(t.db, { ownerId: a, marketId: scheduled.id });
      expect(refused).toMatchObject({
        kind: 'placed',
        order: { status: 'rejected', rejectReason: 'not_open_yet' },
      });
      const setStatus = (status: 'open' | 'scheduled') =>
        t.db.update(markets).set({ status }).where(eq(markets.id, scheduled.id));
      await setStatus('open');
      const stray = await placeTestOrder(t.db, {
        ownerId: a,
        marketId: scheduled.id,
        limitPriceCoin: 40,
        qty: 2,
      });
      await setStatus('scheduled');
      if (stray.kind !== 'placed') throw new Error('placed');
      expect((await balanceOf(t.db, a))!.lockedCoin).toBe(80n);
      await passMarketClose(t.db, scheduled.id);
      const done = await cancelScheduledMarketNow(t.db, scheduled.id);
      expect(done.market).toMatchObject({ status: 'cancelled', resolvedResult: null });
      expect(done.expired.expired).toEqual([
        expect.objectContaining({
          id: stray.order.id,
          status: 'expired',
          endedAt: done.market.updatedAt,
        }),
      ]);
      expect((await balanceOf(t.db, a))!.lockedCoin).toBe(0n);
      expect(done.request).toMatchObject({ status: 'approved', kind: MARKET_CANCEL_APPROVAL_KIND });
      await expectSound();
    });
  });

  describe('the race with the scheduled open (one market lock)', () => {
    it('opens or cancels, never both: whichever comes second skips not_scheduled', async () => {
      for (const first of ['open', 'cancel'] as const) {
        const { market: scheduled } = await createScheduledMarket(t.db);
        const approving = await requested(scheduled.id);
        const held = await holdMarket(scheduled.id);
        const one = first === 'open' ? openNow(scheduled.id) : approve(scheduled.id, approving);
        await waitForLockWaiter(t.db.$client, `the ${first} waits on the market`);
        const two = first === 'open' ? approve(scheduled.id, approving) : openNow(scheduled.id);
        await waitForLockWaiter(t.db.$client, 'both wait on the market', 2);
        await held.release();
        const [opened, cancelled] =
          first === 'open' ? [await one, await two] : [await two, await one];
        const row = await rowOf(scheduled.id);
        if (first === 'open') {
          expect(opened).toMatchObject({ opened: true });
          expect(cancelled).toMatchObject({
            result: { cancelled: false, reason: 'not_scheduled' },
          });
          expect(row.status).toBe('open');
        } else {
          expect(cancelled).toMatchObject({ result: { cancelled: true } });
          expect(opened).toEqual({ opened: false, reason: 'not_scheduled' });
          expect(row).toMatchObject({ status: 'cancelled', openAt: null, ruleVersion: null });
        }
        const transitions = (await eventsOf(scheduled.id)).filter(
          (event) => event.fromStatus === 'scheduled',
        );
        expect(transitions.map((event) => event.type)).toEqual([
          first === 'open' ? 'opened' : 'cancelled',
        ]);
      }
    });
  });

  describe('after CANCELLED', () => {
    it('refuses every order, fill, burn, pause, close, open, judgement, dispute and delay record', async () => {
      // The three paths: the close at close_at, the approved early close, the SCHEDULED cancel.
      const closedM = await createMarket(t.db);
      const a = await member();
      const rested = await placeTestOrder(t.db, {
        ownerId: a,
        marketId: closedM.id,
        limitPriceCoin: 40,
      });
      if (rested.kind !== 'placed') throw new Error('placed');
      // The 운영 마켓메이커 exists, so a burn is judged by the market's status.
      await fundMarketMakerFunds(t.db, closedM.id, 500n);
      await passMarketClose(t.db, closedM.id);
      expect(await closeTestMarket(t.db, closedM.id)).toMatchObject({ status: 'cancelled' });
      const earlyM = await createMarket(t.db);
      expect((await closeMarketEarly(t.db, earlyM.id, { humanFill: false })).market.status).toBe(
        'cancelled',
      );
      const { market: scheduled } = await createScheduledMarket(t.db);
      await cancelScheduledMarketNow(t.db, scheduled.id);

      const b = await member();
      for (const id of [closedM.id, earlyM.id, scheduled.id]) {
        const before = await rowOf(id);
        expect(before).toMatchObject({ status: 'cancelled', resolvedResult: null });
        // 마감: a new order is rejected with the reason a CLOSED market gives (#177 8항).
        expect(
          await placeTestOrder(t.db, { ownerId: b, marketId: id, timeInForce: 'ioc' }),
        ).toMatchObject({ kind: 'placed', order: { status: 'rejected', rejectReason: 'closed' } });
        await t.db
          .transaction(async (tx) => {
            await lockMarket(tx, id);
            const [market] = await tx
              .select()
              .from(markets)
              .where(eq(markets.id, id))
              .for('update');
            const now = await clockTimestamp(tx);
            expect(await closeMarketAtClose(tx, id)).toEqual({
              closed: false,
              reason: 'not_open_or_paused',
            });
            expect(
              await openScheduledMarket(tx, { market: market!, now, actorId: null, source: 'job' }),
            ).toEqual({ opened: false, reason: 'not_scheduled' });
            const locked = await lockMarketOrders(tx, id);
            expect(
              await pauseMarket(tx, {
                market: market!,
                orders: locked,
                now,
                actorId: adminId,
                reason: 'basis_change',
                note: '실질 기준이 바뀌었다.',
                resultPublishedAt: null,
              }),
            ).toEqual({ paused: false, reason: 'not_open' });
            // No judgement: its registration is never approved (#152), no dispute (#175).
            const request = await createJudgementRequest(tx as unknown as Db, { marketId: id });
            expect(
              await approveMarketJudgement(tx, {
                market: market!,
                request,
                now,
                approverId: await admin(),
                eventDeadlineConfirmed: true,
                disputeWindowMinutes: 1_440,
              }),
            ).toEqual({ published: false, reason: 'not_closed' });
            expect(
              await submitMarketDispute(tx, {
                market: market!,
                userId: b,
                judgementVersion: 1,
                links: ['https://example.com/evidence'],
                reason: '결과가 다르다.',
                now,
              }),
            ).toEqual({ created: false, reason: 'not_provisional' });
            await expect(
              recordJudgementDelay(tx, {
                market: market!,
                reason: '확인 중이다.',
                nextReviewAt: new Date(now.getTime() + 3_600_000),
                recordedBy: adminId,
                now,
              }),
            ).rejects.toThrow('takes no judgement delay record');
            // Rolled back: the request above is a probe, not a record.
            throw new Probed();
          })
          .catch((error: unknown) => {
            if (!(error instanceof Probed)) throw error;
          });
        expect(await rowOf(id)).toEqual(before);
        expect(
          await t.db
            .select()
            .from(marketSettlementSteps)
            .where(eq(marketSettlementSteps.marketId, id)),
        ).toEqual([]);
      }
      // The bot's pairs are #181's: no burn on a market that left trading.
      expect(
        await t.db.transaction((tx) =>
          burnMarketMakerPairs(tx, { marketId: closedM.id, burnId: randomUUID(), qty: 1 }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'not_trading' });
      // A member's cancel of the order the close expired is answered as it ended.
      expect(await cancelTestOrder(t.db, { ownerId: a, orderId: rested.order.id })).toMatchObject({
        kind: 'ended',
        order: { status: 'expired' },
      });
      expect(
        await t.db
          .select()
          .from(orders)
          .where(and(eq(orders.marketId, closedM.id), eq(orders.userId, a))),
      ).toEqual([expect.objectContaining({ id: rested.order.id, status: 'expired' })]);
      await expectSound();
    });
  });

  describe('the operators’ checks', () => {
    it('find a CANCELLED market with a person’s fill and one with a live order not held', async () => {
      const run = async (query: string) =>
        (await t.db.$client.query<Record<string, unknown>>(query)).rows;
      expect(await run(CANCELLED_MARKET_HUMAN_FILLS_CHECK_SQL)).toEqual([]);
      expect(await run(CANCELLED_MARKET_LIVE_ORDERS_CHECK_SQL)).toEqual([]);
      // States no flow leaves, written as only a test can: a raw transition over a fill, and a
      // lock-less live order on a cancelled market.
      const filled = await createMarket(t.db);
      await createFill(t.db, { marketId: filled.id, amountCoin: 50n, qty: 1 });
      const stray = await createMarket(t.db);
      const order = await createOrder(t.db, { marketId: stray.id, limitPriceCoin: 30 });
      for (const m of [filled, stray]) {
        await t.db.transaction(async (tx) => {
          await lockMarket(tx, m.id);
          await transitionMarket(tx, {
            marketId: m.id,
            from: 'open',
            to: 'cancelled',
            type: 'cancelled',
            actorId: null,
            at: await clockTimestamp(tx),
          });
        });
      }
      expect(await run(CANCELLED_MARKET_HUMAN_FILLS_CHECK_SQL)).toEqual([
        { market_id: filled.id, human_fills: 1 },
      ]);
      expect(await run(CANCELLED_MARKET_LIVE_ORDERS_CHECK_SQL)).toEqual([
        expect.objectContaining({ market_id: stray.id, order_id: order.id, status: 'open' }),
      ]);
    });

    it('are the checks docs/OPERATIONS.md gives operators, word for word', () => {
      // docs/OPERATIONS.md '거래 없는 시장의 취소 (#20, ADR-0117)': its two SQL blocks, in order.
      const doc = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
      const section = doc.slice(doc.indexOf('## 거래 없는 시장의 취소 (#20, ADR-0117)'));
      const body = section.slice(0, section.indexOf('\n## '));
      const queries = [...body.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]);
      expect(queries).toEqual([
        CANCELLED_MARKET_HUMAN_FILLS_CHECK_SQL,
        CANCELLED_MARKET_LIVE_ORDERS_CHECK_SQL,
      ]);
    });
  });
});
