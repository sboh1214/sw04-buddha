import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeMarketAtClose } from './market-close.js';
import {
  cancelLockedOrders,
  lockAccountOrders,
  lockMarketOrders,
  ordersAwaitingRecovery,
} from './order-cancel.js';
import type { OrderRow } from './orders.js';
import {
  balances,
  fills,
  ledgerEntries,
  marketEvents,
  marketPauses,
  markets,
  orders,
  positions,
  profiles,
} from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import { createMarket, createMarketPause, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
} from './test/ledger.js';
import {
  cancelTestOrder,
  checkOrderInvariants,
  closeTestMarket,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/**
 * 시장 마감과 주문 만료 (#120, ADR-0115): `closeMarketAtClose` against the test database — the skips
 * that lock and write nothing, the close of an OPEN and a PAUSED market with every live order of
 * every account type ended 만료 and its lock back (a held market's kept), the books it never moves,
 * and the races on the market lock (an own cancel, a second closer, an account's batch, another
 * market's pause of the same people).
 */
describe.skipIf(!hasTestDb())('the close at close_at (#120, docker test profile)', () => {
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

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const market = async () => (await createMarket(t.db, { createdBy: adminId })).id;
  async function placed(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result.order;
  }
  const orderRow = async (id: string): Promise<OrderRow> =>
    (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const marketRow = async (id: string) =>
    (await t.db.select().from(markets).where(eq(markets.id, id)))[0]!;
  const coin = async (userId: string) => {
    const row = (await balanceOf(t.db, userId))!;
    return { available: row.availableCoin, locked: row.lockedCoin };
  };
  /** The market's live orders, any account type. */
  const live = (marketId: string) =>
    t.db
      .select()
      .from(orders)
      .where(
        and(eq(orders.marketId, marketId), inArray(orders.status, ['open', 'partially_filled'])),
      )
      .orderBy(asc(orders.arrivalSeq));
  /** What the close never moves: the ledger, the fills and the market's contracts. */
  const books = async (marketId: string) => {
    const { yes, no, collateralCoin } = await contractBook(t.db, marketId);
    return {
      entries: (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n,
      fills: (await t.db.select({ n: count() }).from(fills))[0]!.n,
      supply: await ledgerSupply(t.db),
      contracts: { yes, no, collateralCoin },
    };
  };
  /** Every table the close could write: what a skip must leave as is. */
  const written = async () => ({
    markets: await t.db.select().from(markets).orderBy(markets.id),
    events: (await t.db.select({ n: count() }).from(marketEvents))[0]!.n,
    pauses: await t.db.select().from(marketPauses).orderBy(marketPauses.id),
    orders: await t.db.select().from(orders).orderBy(orders.arrivalSeq),
    positions: await t.db.select().from(positions).orderBy(positions.userId, positions.outcome),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
  });
  const expectSound = async () => expect(await checkOrderInvariants(t.db)).toEqual([]);
  /** Whether another connection can take `userId`'s balance row now (none held by a close). */
  const balanceFree = async (userId: string) => {
    const other = await t.db.$client.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM balances WHERE user_id = $1 FOR UPDATE NOWAIT', [userId]);
      return true;
    } catch {
      return false;
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
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

  describe('skips', () => {
    it('leaves a market neither OPEN nor PAUSED, and one not due, as it is, locking no one', async () => {
      const a = await member();
      const ahead = await market();
      await placed({ ownerId: a, marketId: ahead, limitPriceCoin: 40 });
      // 1 s ahead by the DB clock: still not due.
      const soon = await market();
      await placed({ ownerId: a, marketId: soon, limitPriceCoin: 30 });
      await passMarketClose(t.db, soon, new Date((await clockTimestamp(t.db)).getTime() + 1_000));
      const scheduled = (await createMarket(t.db, { createdBy: adminId, status: 'scheduled' })).id;
      const closed = (await createMarket(t.db, { createdBy: adminId, status: 'closed' })).id;
      await passMarketClose(t.db, scheduled);
      // A CLOSED market that still has A's live, locked order: a ledger-held market closed on
      // schedule. Its skip must come before `lockMarketOrders`, or it would take A's row.
      const heldClosed = await market();
      const kept = await placed({ ownerId: a, marketId: heldClosed, limitPriceCoin: 20 });
      await createMarketPause(t.db, {
        marketId: heldClosed,
        reason: 'ledger_failure',
        by: adminId,
      });
      await passMarketClose(t.db, heldClosed);
      expect((await closeTestMarket(t.db, heldClosed)).closed).toBe(true);
      expect(await orderRow(kept.id)).toEqual(kept);
      const before = await written();
      for (const [m, reason] of [
        [ahead, 'not_due'],
        [soon, 'not_due'],
        [scheduled, 'not_open_or_paused'],
        [closed, 'not_open_or_paused'],
        [heldClosed, 'not_open_or_paused'],
      ] as const) {
        await t.db.transaction(async (tx) => {
          expect(await closeMarketAtClose(tx, m)).toEqual({ closed: false, reason });
          // Decided before any balance row: the owner's row is free while the skip's
          // transaction is still open.
          expect(await balanceFree(a)).toBe(true);
        });
      }
      expect(await written()).toEqual(before);
    });

    it('skips a stale delayed job after a supplement extended the close; the market still trades', async () => {
      const m = await market();
      const a = await member();
      const resting = await placed({ ownerId: a, marketId: m, limitPriceCoin: 40 });
      // The old close came and went unexecuted, then a supplement moved it a day ahead.
      await passMarketClose(t.db, m);
      await passMarketClose(t.db, m, new Date(Date.now() + 86_400_000));
      expect(await closeTestMarket(t.db, m)).toEqual({ closed: false, reason: 'not_due' });
      expect(await orderRow(resting.id)).toEqual(resting);
      expect((await placed({ ownerId: a, marketId: m, limitPriceCoin: 30 })).status).toBe('open');
    });
  });

  describe('the close', () => {
    it('closes an OPEN market and ends every live order 만료 at the close’s instant, books unmoved', async () => {
      const m = await market();
      const other = await market();
      const a = await member();
      const b = await member();
      const c = await member(1_150n);
      await mintTestPairs(t.db, {
        marketId: m,
        yesHolderId: c,
        noHolderId: await member(),
        qty: 3,
      });
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      // A's GTC NO buy 3 @ 40, 1 filled by B's IOC YES buy: 부분 체결.
      const partial = await placed({
        ownerId: a,
        marketId: m,
        outcome: 'NO',
        limitPriceCoin: 40,
        qty: 3,
      });
      await placed({ ownerId: b, marketId: m, timeInForce: 'ioc', limitPriceCoin: 65, qty: 1 });
      const sell = await placed({
        ownerId: c,
        marketId: m,
        side: 'sell',
        limitPriceCoin: 70,
        qty: 2,
      });
      const bot = await placed({ ownerId: mm, marketId: m, limitPriceCoin: 30, qty: 2 });
      const elsewhere = await placed({ ownerId: a, marketId: other, limitPriceCoin: 20 });
      const filled = await orderRow(partial.id);
      expect(filled).toMatchObject({ status: 'partially_filled', filledQty: 1 });
      const booksBefore = await books(m);
      const bPosition = await positionOf(t.db, b, m, 'YES');
      await passMarketClose(t.db, m);

      const done = await closeTestMarket(t.db, m);
      if (!done.closed) throw new Error('closed');
      expect(done.pause).toBeNull();
      expect(done.expired.held).toEqual([]);
      expect(done.expired.expired.map((row) => row.id)).toEqual([partial.id, sell.id, bot.id]);
      // One instant: the event's, the market row's, the payload's and every expired order's.
      const row = await marketRow(m);
      expect(row).toMatchObject({ status: 'closed', statusEventId: done.statusEventId });
      expect(row.updatedAt).toEqual(done.closedAt);
      expect(row.scheduledJudgementAt!.getTime()).toBeGreaterThan(done.closedAt.getTime());
      const [event] = await t.db
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.id, done.statusEventId));
      expect(event).toMatchObject({
        type: 'closed',
        fromStatus: 'open',
        toStatus: 'closed',
        actorId: null,
        payload: { closedAt: done.closedAt.toISOString(), source: 'job' },
        createdAt: done.closedAt,
      });
      expect(await orderRow(partial.id)).toEqual({
        ...filled,
        status: 'expired',
        endedAt: done.closedAt,
        updatedAt: done.closedAt,
      });
      for (const id of [sell.id, bot.id]) {
        expect(await orderRow(id)).toMatchObject({
          status: 'expired',
          cancelReason: null,
          rejectReason: null,
          filledQty: 0,
          endedAt: done.closedAt,
        });
      }
      // No live order of any account type; every lock in the market given back.
      expect(await live(m)).toEqual([]);
      expect(await coin(a)).toEqual({ available: 1_000n - 40n - 20n, locked: 20n });
      expect(await positionOf(t.db, c, m, 'YES')).toMatchObject({ qty: 3, lockedQty: 0 });
      expect(
        await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: m }),
      ).toMatchObject({ lockedCoin: 0n, availableCoin: 1_000n });
      expect(await positionOf(t.db, b, m, 'YES')).toEqual(bPosition);
      expect(await orderRow(elsewhere.id)).toEqual(elsewhere);
      expect(done.expired.touched.positions.map((p) => p.userId)).toEqual([c]);
      expect(await books(m)).toEqual(booksBefore);
      await expectSound();
      // After the close the market takes no order (마감) and its contracts stay where they are.
      const late = await placed({
        ownerId: b,
        marketId: m,
        timeInForce: 'ioc',
        limitPriceCoin: 65,
      });
      expect(late).toMatchObject({ status: 'rejected', rejectReason: 'closed' });
      expect(await books(m)).toEqual(booksBefore);
    });

    it('closes a PAUSED market on schedule: its pause ended closed_at_close, nothing left to expire', async () => {
      const m = await market();
      const a = await member();
      const row = await placed({ ownerId: a, marketId: m, limitPriceCoin: 40 });
      const paused = await createMarketPause(t.db, { marketId: m, by: adminId });
      expect(await orderRow(row.id)).toMatchObject({ status: 'cancelled', cancelReason: 'paused' });
      await passMarketClose(t.db, m);
      const done = await closeTestMarket(t.db, m);
      if (!done.closed) throw new Error('closed');
      expect(done.pause).toMatchObject({
        id: paused.pause.id,
        endKind: 'closed_at_close',
        endedAt: done.closedAt,
        endEventId: done.statusEventId,
      });
      expect(done.expired).toEqual({ expired: [], held: [], touched: { positions: [] } });
      expect((await marketRow(m)).status).toBe('closed');
      await expectSound();
    });

    it('closes a ledger-held market on schedule and keeps its orders live and locked (#93’s)', async () => {
      const m = await market();
      const a = await member();
      const row = await placed({ ownerId: a, marketId: m, limitPriceCoin: 40, qty: 2 });
      await createMarketPause(t.db, { marketId: m, reason: 'ledger_failure', by: adminId });
      await passMarketClose(t.db, m);
      const done = await closeTestMarket(t.db, m);
      if (!done.closed) throw new Error('closed');
      expect(done.pause).toMatchObject({ reason: 'ledger_failure', endKind: 'closed_at_close' });
      expect(done.expired).toEqual({ expired: [], held: [row], touched: { positions: [] } });
      expect(await orderRow(row.id)).toEqual(row);
      expect(await coin(a)).toEqual({ available: 920n, locked: 80n });
      expect(await ordersAwaitingRecovery(t.db, a)).toEqual([row]);
      await expectSound();
    });
  });

  describe('races on the market lock', () => {
    it('leaves exactly one of 취소 완료 and 만료 when an own cancel meets the close', async () => {
      for (const first of ['cancel', 'close'] as const) {
        const m = await market();
        const a = await member();
        const row = await placed({ ownerId: a, marketId: m, limitPriceCoin: 40, qty: 2 });
        await passMarketClose(t.db, m);
        const held = await holdMarket(m);
        const one =
          first === 'cancel'
            ? cancelTestOrder(t.db, { ownerId: a, orderId: row.id })
            : closeTestMarket(t.db, m);
        await waitForLockWaiter(t.db.$client, `the ${first} waits on the market`);
        const two =
          first === 'cancel'
            ? closeTestMarket(t.db, m)
            : cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
        await waitForLockWaiter(t.db.$client, 'both wait on the market', 2);
        await held.release();
        const [cancel, close] =
          first === 'cancel' ? [await one, await two] : [await two, await one];
        const final = await orderRow(row.id);
        if (first === 'cancel') {
          expect(cancel).toMatchObject({ kind: 'cancelled' });
          expect(close).toMatchObject({ closed: true, expired: { expired: [] } });
          expect(final).toMatchObject({ status: 'cancelled', cancelReason: 'by_owner' });
        } else {
          expect(close).toMatchObject({ closed: true, expired: { expired: [{ id: row.id }] } });
          expect(cancel).toMatchObject({ kind: 'ended', order: { status: 'expired' } });
          expect(final).toMatchObject({ status: 'expired', cancelReason: null });
        }
        // One release: the lock is back once, never twice.
        expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
        await expectSound();
      }
    });

    it('closes once when two closers meet: the second skips and releases nothing', async () => {
      const m = await market();
      const a = await member();
      await placed({ ownerId: a, marketId: m, limitPriceCoin: 40, qty: 2 });
      await passMarketClose(t.db, m);
      const held = await holdMarket(m);
      const one = closeTestMarket(t.db, m);
      const two = closeTestMarket(t.db, m);
      await waitForLockWaiter(t.db.$client, 'both closers wait on the market', 2);
      await held.release();
      const results = await Promise.all([one, two]);
      expect(results.filter((r) => r.closed)).toHaveLength(1);
      expect(results.filter((r) => !r.closed)).toEqual([
        { closed: false, reason: 'not_open_or_paused' },
      ]);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      const events = await t.db.select().from(marketEvents).where(eq(marketEvents.marketId, m));
      expect(events.filter((e) => e.type === 'closed')).toHaveLength(1);
      await expectSound();
    });

    it('meets an account’s batch and another market’s pause of the same people without a deadlock', async () => {
      for (let round = 0; round < 3; round += 1) {
        const m = await market();
        const n = await market();
        const a = await member();
        const b = await member();
        const mm = await fundMarketMakerFunds(t.db, m, 500n);
        for (const marketId of [m, n]) {
          await placed({ ownerId: a, marketId, limitPriceCoin: 30 });
          await placed({ ownerId: b, marketId, outcome: 'NO', limitPriceCoin: 30 });
        }
        await placed({ ownerId: mm, marketId: m, limitPriceCoin: 20 });
        await passMarketClose(t.db, m);
        const restrict = t.db.transaction(async (tx) => {
          await tx.select().from(profiles).where(eq(profiles.userId, a)).for('update');
          const locked = await lockAccountOrders(tx, a);
          const at = await clockTimestamp(tx);
          return cancelLockedOrders(tx, locked, { reason: 'restricted', at });
        });
        const pause = t.db.transaction(async (tx) => {
          await lockMarket(tx, n);
          const locked = await lockMarketOrders(tx, n);
          const at = await clockTimestamp(tx);
          return cancelLockedOrders(tx, locked, { reason: 'paused', at });
        });
        const [closed, restricted, paused] = await Promise.all([
          closeTestMarket(t.db, m),
          restrict,
          pause,
        ]);
        expect(closed.closed).toBe(true);
        // Each order ended once, by whichever came first.
        const ended = [
          ...(closed.closed ? closed.expired.expired : []),
          ...restricted.cancelled,
          ...paused.cancelled,
        ].map((row) => row.id);
        expect(new Set(ended).size).toBe(ended.length);
        expect(ended).toHaveLength(5);
        expect(await live(m)).toEqual([]);
        await expectSound();
      }
    });
  });
});
