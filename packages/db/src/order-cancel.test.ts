import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OrderSide, Outcome, TimeInForce } from '@buddha/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { endPauseAtClose } from './market-pause.js';
import { transitionMarket } from './market-transitions.js';
import {
  cancelLockedOrders,
  cancelOrder,
  expireLockedOrders,
  lockAccountOrders,
  lockMarketOrders,
  ordersAwaitingRecovery,
  type LockedOrders,
} from './order-cancel.js';
import type { OrderRow } from './orders.js';
import {
  balances,
  fills,
  ledgerEntries,
  markets,
  orders,
  positions,
  profiles,
} from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import {
  closeMarketEarly,
  createMarket,
  createMarketPause,
  createModerationAction,
  createUser,
  resumeMarket,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
  withLedgerGuardsOff,
} from './test/ledger.js';
import {
  cancelTestAccountOrders,
  cancelTestOrder,
  checkOrderInvariants,
  closeTestMarket,
  createOrder,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  tradeOnce,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/** The node-postgres SQLSTATE of a refusal, wrapped by drizzle or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/**
 * The batch's phase-1 value is branded (ADR-0113 결정 4): only `lockMarketOrders` and
 * `lockAccountOrders` make one, so a caller that read the rows outside their locks (or set `held`
 * itself) cannot hand them to `cancelLockedOrders`, `pauseMarket` or `endMarketPause`. The checks
 * are compile-time (`pnpm typecheck` fails if a `@ts-expect-error` below stops being an error).
 */
describe('LockedOrders (#178, no database)', () => {
  it('cannot be built by hand', () => {
    const rows: OrderRow[] = [];
    // @ts-expect-error -- no brand: not made by lockMarketOrders or lockAccountOrders
    const forged: LockedOrders = {
      scope: { kind: 'market', marketId: 'm' },
      markets: [{ marketId: 'm', held: false, orders: rows }],
    };
    const call = (tx: Parameters<typeof cancelLockedOrders>[0]) =>
      cancelLockedOrders(
        tx,
        // @ts-expect-error -- the same literal straight into the call
        { scope: { kind: 'account', ownerId: 'a' }, markets: [] },
        { reason: 'restricted', at: new Date(0) },
      );
    expect(forged.markets).toHaveLength(1);
    expect(call).toBeTypeOf('function');
  });
});

/**
 * 주문 취소 (#178, ADR-0113): the one cancel processing against the test database — one order by its
 * owner, a market's batch, an account's batch, the markets held for a ledger failure, the races and
 * the books after each (every lock an order's, collateral, YES = NO and the ledger untouched).
 */
describe.skipIf(!hasTestDb())('order cancel (#178, docker test profile)', () => {
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
    return result;
  }
  /** Shorthand for an order: owner, market, outcome, side, time in force, limit, qty. */
  const order = (
    ownerId: string,
    marketId: string,
    outcome: Outcome,
    side: OrderSide,
    timeInForce: TimeInForce,
    limitPriceCoin: number,
    qty: number,
  ) => placed({ ownerId, marketId, outcome, side, timeInForce, limitPriceCoin, qty });
  /** A resting GTC order's row. */
  const resting = async (
    ownerId: string,
    marketId: string,
    outcome: Outcome,
    side: OrderSide,
    limitPriceCoin: number,
    qty: number,
  ) => {
    const done = await order(ownerId, marketId, outcome, side, 'gtc', limitPriceCoin, qty);
    expect(done.order.status).toBe('open');
    return done.order;
  };
  const orderRow = async (id: string): Promise<OrderRow> =>
    (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const coin = async (userId: string) => {
    const row = (await balanceOf(t.db, userId))!;
    return { available: row.availableCoin, locked: row.lockedCoin };
  };
  /** A person holding `qty` YES of `marketId` (a pair mint against a fresh member's NO at 50). */
  const yesHolder = async (marketId: string, qty: number, coinLeft = 1_000n) => {
    const id = await member(coinLeft + 50n * BigInt(qty));
    await mintTestPairs(t.db, { marketId, yesHolderId: id, noHolderId: await member(), qty });
    return id;
  };
  /** What a cancel never changes: the ledger, the fills and every market's contracts. */
  const books = async (marketIds: string[]) => ({
    entries: (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n,
    fills: (await t.db.select({ n: count() }).from(fills))[0]!.n,
    supply: await ledgerSupply(t.db),
    // The contracts and the collateral; a sell's lock (`lockedYes`, `lockedNo`) is the cancel's.
    markets: (await Promise.all(marketIds.map((id) => contractBook(t.db, id)))).map(
      ({ yes, no, collateralCoin }) => ({ yes, no, collateralCoin }),
    ),
  });
  /** Every table a cancel could write, and every balance: what a refusal must leave as is. */
  const written = async () => ({
    orders: await t.db.select().from(orders).orderBy(orders.arrivalSeq),
    fills: (await t.db.select({ n: count() }).from(fills))[0]!.n,
    entries: (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n,
    positions: await t.db.select().from(positions).orderBy(positions.userId, positions.outcome),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
  });
  const expectSound = async () => expect(await checkOrderInvariants(t.db)).toEqual([]);
  /**
   * A CLOSED market as the worker left it before #120 (no expiry): OPEN or PAUSED → CLOSED, the
   * pause ended, the live orders left live and locked — a pre-#120 leftover, which the operators'
   * check (a) shows and an owner can still cancel. A close whose expiry fails rolls back whole and
   * leaves the market OPEN, so (a) never shows it.
   */
  const closeWithoutExpiry = (marketId: string) =>
    t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [current] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const now = await clockTimestamp(tx);
      const eventId = await transitionMarket(tx, {
        marketId,
        from: current!.status,
        to: 'closed',
        type: 'closed',
        actorId: null,
        payload: { closedAt: now.toISOString(), source: 'job' },
        at: now,
      });
      if (current!.status === 'paused') await endPauseAtClose(tx, { marketId, now, eventId });
    });
  /** The close at `close_at` as the worker runs it (#120): due now, then `closeMarketAtClose`. */
  const closeNow = async (marketId: string) => {
    await passMarketClose(t.db, marketId);
    return closeTestMarket(t.db, marketId);
  };
  const ledgerPause = (marketId: string) =>
    createMarketPause(t.db, { marketId, reason: 'ledger_failure', by: adminId });
  /** Holds `marketId`'s lock on a connection of its own until `release` is called. */
  async function holdMarket(marketId: string) {
    const holder = await t.db.$client.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [marketId]);
    return {
      waitFor: (what: string, n = 1) => waitForLockWaiter(holder, what, n),
      release: async () => {
        await holder.query('COMMIT');
        holder.release();
      },
    };
  }

  describe('cancelOrder: one order by its owner', () => {
    it('ends a resting buy as 취소 완료(본인 취소): the whole rest, its lock back, nothing else', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 3);
      expect(await coin(a)).toEqual({ available: 880n, locked: 120n });
      const before = await books([m]);
      const from = await clockTimestamp(t.db);
      const done = await cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      const to = await clockTimestamp(t.db);
      expect(done.kind).toBe('cancelled');
      if (done.kind !== 'cancelled') return;
      expect(done.order).toEqual({
        ...row,
        status: 'cancelled',
        cancelReason: 'by_owner',
        endedAt: done.order.endedAt,
        updatedAt: done.order.endedAt,
      });
      expect(done.order.endedAt!.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(done.order.endedAt!.getTime()).toBeLessThanOrEqual(to.getTime());
      expect(await orderRow(row.id)).toEqual(done.order);
      expect(done.touched).toEqual({ positions: [] });
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      expect(await books([m])).toEqual(before);
      await expectSound();
    });

    it('keeps a partly filled order’s fills and releases only its rest', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const row = await resting(a, m, 'NO', 'buy', 40, 3);
      const crossed = await order(b, m, 'YES', 'buy', 'ioc', 65, 1);
      expect(crossed.fills).toHaveLength(1);
      const partial = await orderRow(row.id);
      expect(partial).toMatchObject({ status: 'partially_filled', filledQty: 1 });
      expect(await coin(a)).toEqual({ available: 880n, locked: 80n });
      const before = await books([m]);
      const done = await cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      expect(done).toMatchObject({
        kind: 'cancelled',
        order: {
          status: 'cancelled',
          cancelReason: 'by_owner',
          qty: 3,
          filledQty: 1,
          filledAmountCoin: partial.filledAmountCoin,
        },
      });
      expect(await coin(a)).toEqual({ available: 960n, locked: 0n });
      expect(await positionOf(t.db, a, m, 'NO')).toMatchObject({ qty: 1, lockedQty: 0 });
      expect(await books([m])).toEqual(before);
      await expectSound();
    });

    it('gives a sell’s contracts back and names the position it wrote', async () => {
      const m = await market();
      const a = await yesHolder(m, 3);
      const row = await resting(a, m, 'YES', 'sell', 60, 2);
      expect(await positionOf(t.db, a, m, 'YES')).toMatchObject({ qty: 3, lockedQty: 2 });
      const before = await books([m]);
      const done = await cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      expect(done.kind).toBe('cancelled');
      if (done.kind !== 'cancelled') return;
      const position = await positionOf(t.db, a, m, 'YES');
      expect(position).toMatchObject({ qty: 3, lockedQty: 0 });
      expect(done.touched.positions).toEqual([position]);
      expect(await books([m])).toEqual(before);
      await expectSound();
    });

    it('releases the 운영 마켓메이커’s lock into its market’s funds, no person’s account touched', async () => {
      const m = await market();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const funds = { kind: 'market_maker_funds', marketId: m } as const;
      const row = await resting(mm, m, 'NO', 'buy', 40, 3);
      expect(await ledgerAccountBalance(t.db, funds)).toMatchObject({ lockedCoin: 120n });
      const people = await t.db
        .select()
        .from(balances)
        .where(sql`${balances.userId} IS NOT NULL`);
      const done = await cancelTestOrder(t.db, { ownerId: mm, orderId: row.id });
      expect(done).toMatchObject({ kind: 'cancelled', touched: { positions: [] } });
      expect(await ledgerAccountBalance(t.db, funds)).toMatchObject({
        availableCoin: 1_000n,
        lockedCoin: 0n,
      });
      expect(
        await t.db
          .select()
          .from(balances)
          .where(sql`${balances.userId} IS NOT NULL`),
      ).toEqual(people);
      await expectSound();
    });

    it('gives the 운영 마켓메이커’s sell its contracts back and names no position (no person’s)', async () => {
      const m = await market();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      await mintTestPairs(t.db, {
        marketId: m,
        yesHolderId: mm,
        noHolderId: await member(),
        qty: 3,
      });
      const row = await resting(mm, m, 'YES', 'sell', 60, 2);
      expect(await positionOf(t.db, mm, m, 'YES')).toMatchObject({ qty: 3, lockedQty: 2 });
      const before = await books([m]);
      const done = await cancelTestOrder(t.db, { ownerId: mm, orderId: row.id });
      expect(done).toMatchObject({ kind: 'cancelled', touched: { positions: [] } });
      expect(await positionOf(t.db, mm, m, 'YES')).toMatchObject({ qty: 3, lockedQty: 0 });
      expect(await books([m])).toEqual(before);
      await expectSound();
    });

    it('keeps the gap of an account whose total left its ledger (releaseCoin)', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 1);
      await withLedgerGuardsOff((client) =>
        client.query('UPDATE balances SET available_coin = available_coin - 5 WHERE user_id = $1', [
          a,
        ]),
      );
      expect(await cancelTestOrder(t.db, { ownerId: a, orderId: row.id })).toMatchObject({
        kind: 'cancelled',
      });
      const after = (await balanceOf(t.db, a))!;
      expect(after).toMatchObject({ availableCoin: 995n, lockedCoin: 0n, ledgerCoin: 1_000n });
    });

    it('answers an ended order as it is, writing nothing (filled, cancelled, expired, rejected)', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const filled = await resting(a, m, 'NO', 'buy', 40, 1);
      await order(b, m, 'YES', 'buy', 'ioc', 65, 1);
      const cancelled = await resting(a, m, 'YES', 'buy', 10, 1);
      await cancelTestOrder(t.db, { ownerId: a, orderId: cancelled.id });
      const rejected = (await order(a, m, 'YES', 'buy', 'ioc', 99, 1)).order; // no quote
      const budget = (await placed({ ownerId: b, marketId: m, budgetCoin: 100n })).order;
      const expired = await createOrder(t.db, { marketId: m, userId: a, status: 'expired' });
      const before = await written();
      for (const [ownerId, id, status] of [
        [a, filled.id, 'filled'],
        [a, cancelled.id, 'cancelled'],
        [a, rejected.id, 'rejected'],
        [b, budget.id, budget.status],
        [a, expired.id, 'expired'],
      ] as const) {
        const done = await cancelTestOrder(t.db, { ownerId, orderId: id });
        expect(done).toEqual({ kind: 'ended', order: await orderRow(id) });
        expect(done.kind === 'ended' && done.order.status).toBe(status);
      }
      expect(await written()).toEqual(before);
      await expectSound();
    });

    it('finds no order of another account, an unknown id, or the bot’s asked by a person', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const mine = await resting(a, m, 'YES', 'buy', 40, 1);
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const bots = await resting(mm, m, 'NO', 'buy', 40, 1);
      const before = await written();
      for (const [ownerId, orderId] of [
        [b, mine.id],
        [a, randomUUID()],
        [a, bots.id],
      ] as const) {
        expect(await cancelTestOrder(t.db, { ownerId, orderId })).toEqual({ kind: 'not_found' });
      }
      expect(await written()).toEqual(before);
    });

    it('refuses a reason the intake writes', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 1);
      await expect(
        t.db.transaction((tx) =>
          cancelOrder(tx, { ownerId: a, orderId: row.id, reason: 'ioc_remainder' as never }),
        ),
      ).rejects.toThrow(RangeError);
      expect((await orderRow(row.id)).status).toBe('open');
    });

    // Traded, the close is CLOSED; with no fill a person's account is on, CANCELLED (#20) —
    // held either way (`ledgerHeldMarketSql` reads the pause, not the status).
    it.each([
      { traded: true, status: 'closed' },
      { traded: false, status: 'cancelled' },
    ] as const)(
      'holds a live order of a ledger-failure market, until its close too ($status), and answers an ended one',
      async ({ traded, status }) => {
        const m = await market();
        const a = await member();
        const live = await resting(a, m, 'YES', 'buy', 40, 2);
        const ended = await resting(a, m, 'YES', 'buy', 10, 1);
        await cancelTestOrder(t.db, { ownerId: a, orderId: ended.id });
        // Two other members' pair at 50: it meets neither of A's buys.
        if (traded) await tradeOnce(t.db, m);
        await ledgerPause(m);
        // The ledger_failure pause cancelled nothing: the order waits with its lock.
        expect(await orderRow(live.id)).toEqual(live);
        const before = await written();
        expect(await cancelTestOrder(t.db, { ownerId: a, orderId: live.id })).toEqual({
          kind: 'held',
          order: live,
        });
        expect(await cancelTestOrder(t.db, { ownerId: a, orderId: ended.id })).toMatchObject({
          kind: 'ended',
          order: { status: 'cancelled', cancelReason: 'by_owner' },
        });
        expect(await written()).toEqual(before);
        // The close comes on schedule before the recovery: still held (#93 expires it), the
        // close's expiry skipping it (#120).
        expect(await closeNow(m)).toMatchObject({
          closed: true,
          status,
          expired: { expired: [], held: [live] },
        });
        expect(await cancelTestOrder(t.db, { ownerId: a, orderId: live.id })).toMatchObject({
          kind: 'held',
        });
        expect(await coin(a)).toEqual({ available: 920n, locked: 80n });
        expect(await ordersAwaitingRecovery(t.db, a)).toEqual([live]);
        await expectSound();
      },
    );

    it.each([
      { traded: true, status: 'closed' },
      { traded: false, status: 'cancelled' },
    ] as const)(
      'answers an order the close expired as it is ($status), and cancels a pre-#120 leftover',
      async ({ traded, status }) => {
        // The close (#120) expired it: the owner's cancel answers its final state, nothing written
        // — CLOSED after a person's fill, CANCELLED with none (#20).
        const m = await market();
        const a = await member();
        const row = await resting(a, m, 'YES', 'buy', 40, 1);
        if (traded) await tradeOnce(t.db, m);
        expect(await closeNow(m)).toMatchObject({ closed: true, status });
        const before = await written();
        expect(await cancelTestOrder(t.db, { ownerId: a, orderId: row.id })).toMatchObject({
          kind: 'ended',
          order: { status: 'expired', cancelReason: null },
        });
        expect(await written()).toEqual(before);
        // A CLOSED market's live order from before #120 (ADR-0113 12-9) can still be cancelled.
        const old = await market();
        const left = await resting(a, old, 'YES', 'buy', 40, 1);
        await closeWithoutExpiry(old);
        expect(await cancelTestOrder(t.db, { ownerId: a, orderId: left.id })).toMatchObject({
          kind: 'cancelled',
          order: { status: 'cancelled', cancelReason: 'by_owner' },
        });
        expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
        await expectSound();
      },
    );

    it('releases once when asked twice in a row', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 2);
      const first = await cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      const second = await cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      expect(first.kind).toBe('cancelled');
      expect(second).toEqual({ kind: 'ended', order: first.kind === 'cancelled' && first.order });
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      await expectSound();
    });
  });

  describe('races on the market lock', () => {
    it('ends an order once when two cancels of it meet', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 2);
      const held = await holdMarket(m);
      const one = cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      const two = cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      await held.waitFor('both cancels wait on the market', 2);
      await held.release();
      const kinds = (await Promise.all([one, two])).map((done) => done.kind).sort();
      expect(kinds).toEqual(['cancelled', 'ended']);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      await expectSound();
    });

    it.each([
      ['the fill first, part of it', 'intake', 1],
      ['the fill first, all of it', 'intake', 2],
      ['the cancel first', 'cancel', 1],
    ] as const)('meets a crossing order: %s', async (_, first, qty) => {
      const m = await market();
      const a = await member();
      const b = await member();
      const row = await resting(a, m, 'NO', 'buy', 40, 2);
      const held = await holdMarket(m);
      const intake = () => order(b, m, 'YES', 'buy', 'ioc', 65, qty);
      const cancel = () => cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
      let crossing: ReturnType<typeof intake>;
      let cancelling: ReturnType<typeof cancel>;
      if (first === 'intake') {
        crossing = intake();
        await held.waitFor('the intake waits');
        cancelling = cancel();
      } else {
        cancelling = cancel();
        await held.waitFor('the cancel waits');
        crossing = intake();
      }
      await held.waitFor('both wait', 2);
      await held.release();
      const [crossed, cancelled] = await Promise.all([crossing, cancelling]);
      if (first === 'cancel') {
        expect(cancelled).toMatchObject({ kind: 'cancelled', order: { filledQty: 0 } });
        expect(crossed.fills).toEqual([]);
        expect(crossed.order.status).toBe('rejected');
      } else if (qty === 2) {
        expect(crossed.order.status).toBe('filled');
        expect(cancelled).toMatchObject({ kind: 'ended', order: { status: 'filled' } });
      } else {
        expect(crossed.order.status).toBe('filled');
        expect(cancelled).toMatchObject({
          kind: 'cancelled',
          order: { status: 'cancelled', filledQty: 1 },
        });
      }
      expect((await coin(a)).locked).toBe(0n);
      await expectSound();
    });

    it.each(['pause', 'cancel'] as const)(
      'meets a pause: exactly one ends the order (%s first)',
      async (first) => {
        const m = await market();
        const a = await member();
        const row = await resting(a, m, 'YES', 'buy', 40, 1);
        const held = await holdMarket(m);
        const pause = () => createMarketPause(t.db, { marketId: m, by: adminId });
        const cancel = () => cancelTestOrder(t.db, { ownerId: a, orderId: row.id });
        let pausing: ReturnType<typeof pause>;
        let cancelling: ReturnType<typeof cancel>;
        if (first === 'pause') {
          pausing = pause();
          await held.waitFor('the pause waits');
          cancelling = cancel();
        } else {
          cancelling = cancel();
          await held.waitFor('the cancel waits');
          pausing = pause();
        }
        await held.waitFor('both wait', 2);
        await held.release();
        const [, cancelled] = await Promise.all([pausing, cancelling]);
        const reason = first === 'pause' ? 'paused' : 'by_owner';
        expect(cancelled).toMatchObject({
          kind: first === 'pause' ? 'ended' : 'cancelled',
          order: { status: 'cancelled', cancelReason: reason },
        });
        expect(await orderRow(row.id)).toMatchObject({ cancelReason: reason });
        expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
        await expectSound();
      },
    );
  });

  describe('a market’s batch', () => {
    it('ends people’s and the 운영 마켓메이커’s orders at the pause, other markets untouched', async () => {
      const m = await market();
      const other = await market();
      const a = await member();
      const b = await yesHolder(m, 2);
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const rows = [
        await resting(a, m, 'NO', 'buy', 40, 2),
        await resting(b, m, 'YES', 'sell', 60, 1),
        await resting(mm, m, 'YES', 'buy', 30, 2),
      ];
      const kept = await resting(a, other, 'YES', 'buy', 20, 1);
      const before = await books([m, other]);
      const paused = await createMarketPause(t.db, { marketId: m, by: adminId });
      for (const row of rows) {
        expect(await orderRow(row.id)).toEqual({
          ...row,
          status: 'cancelled',
          cancelReason: 'paused',
          endedAt: paused.pause.pausedAt,
          updatedAt: paused.pause.pausedAt,
        });
      }
      expect(await orderRow(kept.id)).toEqual(kept);
      expect(await coin(a)).toEqual({ available: 980n, locked: 20n });
      expect(await positionOf(t.db, b, m, 'YES')).toMatchObject({ qty: 2, lockedQty: 0 });
      expect(
        await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: m }),
      ).toMatchObject({ availableCoin: 1_000n, lockedCoin: 0n });
      expect(await books([m, other])).toEqual(before);
      await expectSound();
    });

    it('skips a held market’s orders unless the batch ends its hold', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 1);
      await ledgerPause(m);
      const skipped = await t.db.transaction(async (tx) => {
        const locked = await lockMarketOrders(tx, m);
        expect(locked.markets).toEqual([{ marketId: m, held: true, orders: [row] }]);
        return cancelLockedOrders(tx, locked, { reason: 'paused', at: await clockTimestamp(tx) });
      });
      expect(skipped).toEqual({ cancelled: [], held: [row], touched: { positions: [] } });
      expect(await orderRow(row.id)).toEqual(row);
      const ended = await t.db.transaction(async (tx) => {
        const locked = await lockMarketOrders(tx, m);
        const at = await clockTimestamp(tx);
        return cancelLockedOrders(tx, locked, { reason: 'paused', at, endsHold: true });
      });
      expect(ended.held).toEqual([]);
      expect(ended.cancelled.map((done) => [done.id, done.cancelReason])).toEqual([
        [row.id, 'paused'],
      ]);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      // An account's batch never ends a hold: it took no balance row there.
      await expect(
        t.db.transaction(async (tx) => {
          const locked = await lockAccountOrders(tx, a);
          await cancelLockedOrders(tx, locked, {
            reason: 'restricted',
            at: await clockTimestamp(tx),
            endsHold: true,
          });
        }),
      ).rejects.toThrow("only a market's batch ends its hold");
      await expectSound();
    });

    it('pauses two markets of the same two people at once without a deadlock', async () => {
      for (let round = 0; round < 4; round += 1) {
        const [m1, m2] = [await market(), await market()];
        const u = await member();
        const v = await member();
        // Opposite arrival orders: u then v in m1, v then u in m2. Locking each holder at its own
        // release would cross; the one sorted `lockOrderHolders` call first cannot (ADR-0110 결정 4).
        await resting(u, m1, 'YES', 'buy', 30, 1);
        await resting(v, m1, 'NO', 'buy', 30, 1);
        await resting(v, m2, 'NO', 'buy', 30, 1);
        await resting(u, m2, 'YES', 'buy', 30, 1);
        const h1 = await holdMarket(m1);
        const h2 = await holdMarket(m2);
        const pausing = Promise.allSettled([
          createMarketPause(t.db, { marketId: m1, by: adminId }),
          createMarketPause(t.db, { marketId: m2, by: adminId }),
        ]);
        await h1.waitFor('both pauses wait', 2);
        await Promise.all([h1.release(), h2.release()]);
        const endings = (await pausing).map((r) =>
          r.status === 'fulfilled' ? 'ok' : sqlState(r.reason),
        );
        expect(endings).toEqual(['ok', 'ok']);
        expect(await coin(u)).toEqual({ available: 1_000n, locked: 0n });
        expect(await coin(v)).toEqual({ available: 1_000n, locked: 0n });
      }
      await expectSound();
    });
  });

  describe('an account’s batch', () => {
    it('ends the person’s orders in every market at one instant, a held market’s skipped', async () => {
      const ms = [await market(), await market(), await market()];
      const heldMarket = await market();
      const a = await yesHolder(ms[2]!, 1);
      const b = await member();
      const mm = await fundMarketMakerFunds(t.db, ms[0]!, 1_000n);
      const mine = [
        await resting(a, ms[0]!, 'YES', 'buy', 40, 1),
        await resting(a, ms[1]!, 'NO', 'buy', 30, 2),
        await resting(a, ms[2]!, 'YES', 'sell', 70, 1),
      ];
      const partly = await resting(a, ms[1]!, 'YES', 'buy', 20, 2);
      await order(b, ms[1]!, 'NO', 'buy', 'ioc', 85, 1);
      const waiting = await resting(a, heldMarket, 'YES', 'buy', 10, 1);
      const others = [
        await resting(b, ms[0]!, 'YES', 'buy', 35, 1),
        await resting(mm, ms[0]!, 'NO', 'buy', 30, 1),
      ];
      await ledgerPause(heldMarket);
      const before = await books([...ms, heldMarket]);
      const done = await cancelTestAccountOrders(t.db, a, 'restricted');
      expect(done.held).toEqual([waiting]);
      expect(done.cancelled.map((row) => row.id).sort()).toEqual(
        [...mine, partly].map((row) => row.id).sort(),
      );
      for (const row of done.cancelled) {
        expect(row).toMatchObject({
          status: 'cancelled',
          cancelReason: 'restricted',
          endedAt: done.at,
          updatedAt: done.at,
        });
      }
      expect(done.cancelled.find((row) => row.id === partly.id)?.filledQty).toBe(1);
      expect(done.touched.positions).toEqual([await positionOf(t.db, a, ms[2]!, 'YES')]);
      expect(await positionOf(t.db, a, ms[2]!, 'YES')).toMatchObject({ lockedQty: 0 });
      // Only the held order's lock is left: 10 × 1.
      expect((await coin(a)).locked).toBe(10n);
      for (const row of others) expect(await orderRow(row.id)).toEqual(row);
      expect(await ordersAwaitingRecovery(t.db, a)).toEqual([waiting]);
      expect(await books([...ms, heldMarket])).toEqual(before);
      await expectSound();

      // The recovery approval (재개) ends it as 일시 중단, before the market reopens.
      const resumed = await resumeMarket(t.db, heldMarket);
      expect(await orderRow(waiting.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'paused',
        endedAt: resumed.pause.endedAt,
      });
      expect((await coin(a)).locked).toBe(0n);
      expect(await ordersAwaitingRecovery(t.db, a)).toEqual([]);
      await expectSound();
    });

    it('meets another market’s processing of the same person without a deadlock (10-28)', async () => {
      for (let round = 0; round < 4; round += 1) {
        const [m1, m2, m3] = [await market(), await market(), await market()];
        const u = await member();
        const v = await member();
        await resting(u, m1, 'YES', 'buy', 30, 1);
        await resting(u, m2, 'YES', 'buy', 30, 1);
        await resting(u, m3, 'NO', 'buy', 30, 1);
        await resting(v, m3, 'YES', 'buy', 30, 1);
        const held = [await holdMarket(m1), await holdMarket(m3)];
        const running = Promise.allSettled([
          cancelTestAccountOrders(t.db, u, 'account_closed'),
          createMarketPause(t.db, { marketId: m3, by: adminId }),
        ]);
        await held[0]!.waitFor('the account batch and the pause wait', 2);
        await Promise.all(held.map((h) => h.release()));
        const endings = (await running).map((r) =>
          r.status === 'fulfilled' ? 'ok' : sqlState(r.reason),
        );
        expect(endings).toEqual(['ok', 'ok']);
        expect((await coin(u)).locked).toBe(0n);
        expect((await coin(v)).locked).toBe(0n);
      }
      await expectSound();
    });

    it('throws when an order comes in a market it did not lock (the profile not held)', async () => {
      const [m1, m2] = [await market(), await market()];
      const a = await member();
      await resting(a, m1, 'YES', 'buy', 30, 1);
      const held = await holdMarket(m1);
      // No profile FOR UPDATE here: an intake in another market slips in after the first read.
      const batch = t.db.transaction(async (tx) => {
        const locked = await lockAccountOrders(tx, a);
        return cancelLockedOrders(tx, locked, {
          reason: 'restricted',
          at: await clockTimestamp(tx),
        });
      });
      await held.waitFor('the batch waits on the first market');
      await resting(a, m2, 'NO', 'buy', 30, 1);
      await held.release();
      await expect(batch).rejects.toThrow('lock the profile FOR UPDATE first');
      expect((await coin(a)).locked).toBe(60n);
      await expectSound();
    });

    it('ends an order whose owner now holds the admin role, as 관리자 권한 (#143’s call)', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 1);
      await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, a));
      const done = await cancelTestAccountOrders(t.db, a, 'admin_role');
      expect(done.cancelled).toMatchObject([
        { id: row.id, status: 'cancelled', cancelReason: 'admin_role' },
      ]);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      // Nothing live: nothing to lock or write.
      expect(await cancelTestAccountOrders(t.db, a, 'admin_role')).toMatchObject({
        cancelled: [],
        held: [],
      });
      await expectSound();
    });
  });

  describe('the expiry (#120)', () => {
    /** Moves `marketId` out of trading with a raw write, its orders left live and locked. */
    const leaveTrading = (marketId: string, status: 'closed' | 'cancelled' = 'closed') =>
      t.db.update(markets).set({ status }).where(eq(markets.id, marketId));
    /** A market's batch as the close takes it: locks, its instant, then the expiry. */
    const expireNow = (marketId: string, options: { endsHold?: boolean } = {}) =>
      t.db.transaction(async (tx) => {
        const locked = await lockMarketOrders(tx, marketId);
        const at = await clockTimestamp(tx);
        return { ...(await expireLockedOrders(tx, locked, { at, ...options })), at };
      });

    it('ends every live order of every account type as 만료, each lock back once, nothing else', async () => {
      const m = await market();
      const other = await market();
      const a = await member();
      const b = await member();
      const c = await yesHolder(m, 3);
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      // A's NO buy 3 @ 40, one filled by B's YES buy (a pair mint): 부분 체결.
      const partial = await resting(a, m, 'NO', 'buy', 40, 3);
      await order(b, m, 'YES', 'buy', 'ioc', 65, 1);
      const sell = await resting(c, m, 'YES', 'sell', 70, 2);
      const bot = await resting(mm, m, 'YES', 'buy', 30, 2);
      const elsewhere = await resting(a, other, 'YES', 'buy', 20, 1);
      const filled = await orderRow(partial.id);
      expect(filled).toMatchObject({ status: 'partially_filled', filledQty: 1 });
      await leaveTrading(m);
      const booksBefore = await books([m, other]);
      const bPosition = await positionOf(t.db, b, m, 'YES');

      const done = await expireNow(m);
      expect(done.expired.map((row) => row.id)).toEqual([partial.id, sell.id, bot.id]);
      expect(done.held).toEqual([]);
      for (const row of done.expired) {
        expect(row).toMatchObject({
          status: 'expired',
          cancelReason: null,
          rejectReason: null,
          endedAt: done.at,
          updatedAt: done.at,
        });
      }
      // The filled part kept: 1 of 3 at 40, the rest (2) no longer locked.
      expect(await orderRow(partial.id)).toEqual({
        ...filled,
        status: 'expired',
        endedAt: done.at,
        updatedAt: done.at,
      });
      // A's lock is its order in the other market alone; C's contracts back; the funds unlocked.
      expect(await coin(a)).toEqual({ available: 1_000n - 40n - 20n, locked: 20n });
      expect(await positionOf(t.db, c, m, 'YES')).toMatchObject({ qty: 3, lockedQty: 0 });
      expect(
        await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: m }),
      ).toMatchObject({ lockedCoin: 0n, availableCoin: 1_000n });
      expect(await positionOf(t.db, b, m, 'YES')).toEqual(bPosition);
      expect(await orderRow(elsewhere.id)).toEqual(elsewhere);
      // People's rows only: C's sell; the 운영 마켓메이커's buy wrote no position.
      expect(done.touched.positions.map((row) => [row.userId, row.outcome])).toEqual([[c, 'YES']]);
      // No ledger entry, fill or contract move.
      expect(await books([m, other])).toEqual(booksBefore);
      await expectSound();
      // Again with a fresh batch: nothing live, nothing written.
      const again = await written();
      expect((await expireNow(m)).expired).toEqual([]);
      expect(await written()).toEqual(again);
    });

    it('keeps a held market’s orders live and locked, unless the batch ends its hold (#93)', async () => {
      const m = await market();
      const a = await member();
      const live = await resting(a, m, 'YES', 'buy', 40, 2);
      await ledgerPause(m);
      // Closed on schedule before its recovery: still held.
      expect(await closeNow(m)).toMatchObject({ closed: true, expired: { held: [live] } });
      const before = await written();
      expect(await expireNow(m)).toMatchObject({ expired: [], held: [live] });
      expect(await written()).toEqual(before);
      expect(await coin(a)).toEqual({ available: 920n, locked: 80n });
      // #93's recovery of the closed market passes `endsHold`: 만료, not 취소 완료.
      const recovered = await expireNow(m, { endsHold: true });
      expect(recovered.expired).toMatchObject([
        { id: live.id, status: 'expired', cancelReason: null },
      ]);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      await expectSound();
    });

    it('refuses an account’s batch and a market still trading, writing nothing', async () => {
      const m = await market();
      const a = await member();
      await resting(a, m, 'YES', 'buy', 40, 1);
      const before = await written();
      // OPEN, then PAUSED (a ledger pause keeps the order): 만료 only after it leaves trading.
      await expect(expireNow(m)).rejects.toThrow('만료 only after it leaves trading');
      await ledgerPause(m);
      await expect(expireNow(m)).rejects.toThrow('만료 only after it leaves trading');
      await expect(
        t.db.transaction(async (tx) => {
          await tx.select().from(profiles).where(eq(profiles.userId, a)).for('update');
          const locked = await lockAccountOrders(tx, a);
          await expireLockedOrders(tx, locked, { at: await clockTimestamp(tx) });
        }),
      ).rejects.toThrow("만료 is a market's end");
      expect((await written()).orders).toEqual(before.orders);
      expect(await coin(a)).toEqual({ available: 960n, locked: 40n });
    });

    it('writes the 만료 only where the row is as read, on a CANCELLED market too', async () => {
      const m = await market();
      const a = await member();
      const row = await resting(a, m, 'YES', 'buy', 40, 1);
      await leaveTrading(m, 'cancelled');
      await expect(
        t.db.transaction(async (tx) => {
          const locked = await lockMarketOrders(tx, m);
          await tx
            .update(orders)
            .set({ status: 'cancelled', cancelReason: 'by_owner', endedAt: sql`now()` })
            .where(eq(orders.id, row.id));
          await expireLockedOrders(tx, locked, { at: await clockTimestamp(tx) });
        }),
      ).rejects.toThrow(`order ${row.id} changed outside its market's lock`);
      expect(await orderRow(row.id)).toEqual(row);
      // #20's CANCELLED expires the same way.
      expect((await expireNow(m)).expired).toMatchObject([{ id: row.id, status: 'expired' }]);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      await expectSound();
    });
  });

  describe('ledgerHeldMarketIds', () => {
    it('holds a lasting ledger_failure pause and one ended at the close, nothing else', async () => {
      const plain = await market();
      const lasting = await market();
      await ledgerPause(lasting);
      const closedBefore = await market();
      await ledgerPause(closedBefore);
      await closeNow(closedBefore);
      const resumed = await market();
      await ledgerPause(resumed);
      await resumeMarket(t.db, resumed);
      const closedEarly = await market();
      await ledgerPause(closedEarly);
      await closeMarketEarly(t.db, closedEarly);
      const pausedAgain = await market();
      await ledgerPause(pausedAgain);
      await resumeMarket(t.db, pausedAgain);
      await createMarketPause(t.db, { marketId: pausedAgain, by: adminId });
      const other = await market();
      await createMarketPause(t.db, { marketId: other, by: adminId });
      const closed = await market();
      await closeNow(closed);
      const all = [plain, lasting, closedBefore, resumed, closedEarly, pausedAgain, other, closed];
      expect(await ledgerHeldMarketIds(t.db, all)).toEqual(new Set([lasting, closedBefore]));
      expect(await ledgerHeldMarketIds(t.db, [])).toEqual(new Set());
    });
  });

  describe('the operators’ checks (docs/OPERATIONS.md 주문 취소)', () => {
    const doc = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 주문 취소 (#178, ADR-0113)');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const queries = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);

    it('has four read-only checks after the intake’s', () => {
      expect(start).toBeGreaterThan(doc.indexOf('## 주문 접수 (#119, ADR-0112)'));
      expect(queries).toHaveLength(4);
      for (const query of queries) expect(query.trimStart()).toMatch(/^SELECT /);
    });

    it('shows a CLOSED market’s order and a stray one in a PAUSED market, nothing of a closed or restricted account, and the held orders', async () => {
      const closed = await market();
      const heldMarket = await market();
      const closedHeld = await market();
      const paused = await market();
      const a = await member();
      const left = await resting(a, closed, 'YES', 'buy', 30, 1);
      const waiting = await resting(a, heldMarket, 'YES', 'buy', 20, 2);
      const closedWaiting = await resting(a, closedHeld, 'NO', 'buy', 25, 1);
      await resting(a, paused, 'YES', 'buy', 10, 1);
      // A close that left its order live (a pre-#120 leftover): (a) shows it.
      await closeWithoutExpiry(closed);
      await ledgerPause(heldMarket);
      // Closed on schedule before its recovery (end_kind closed_at_close) — CANCELLED, as nobody
      // filled (#20): still held, so the close's expiry skips it, (d) shows it and (a) leaves it
      // out (ADR-0113 결과 4 — it waits for #93's recovery).
      await ledgerPause(closedHeld);
      await closeNow(closedHeld);
      await createMarketPause(t.db, { marketId: paused, by: adminId });
      // What (a) is for: a live order in a PAUSED market not held (one from before #178, or a
      // pause whose cancel broke), which no flow leaves — a lock-less row only read here.
      const stray = await createOrder(t.db, { marketId: paused, userId: a, limitPriceCoin: 10 });
      // As buddha_app, which the operators' role reads like.
      const run = async (query: string) =>
        (await t.db.$client.query<Record<string, unknown>>(query)).rows;
      const [closedLeft, closedAccounts, restricted, awaiting] = await Promise.all(
        queries.map(run),
      );
      expect(closedLeft).toMatchObject([
        { id: stray.id, market_status: 'paused' },
        { id: left.id, market_status: 'closed' },
      ]);
      expect(closedAccounts).toEqual([]);
      expect(restricted).toEqual([]);
      // Ordered by market id, which is random here.
      expect(awaiting).toHaveLength(2);
      expect(awaiting).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            market_id: heldMarket,
            market_status: 'paused',
            end_kind: null,
            order_id: waiting.id,
            remaining_qty: 2,
            locked_coin: '40',
          }),
          expect.objectContaining({
            market_id: closedHeld,
            market_status: 'cancelled',
            end_kind: 'closed_at_close',
            order_id: closedWaiting.id,
            remaining_qty: 1,
            locked_coin: '25',
          }),
        ]),
      );
    });

    it('finds the live order a closure or a restriction left behind, the held markets’ excepted', async () => {
      // What (b) and (c) must catch, which no flow leaves: each state is written as only a test
      // can — a restriction's row with no approval's batch cancel, a closure with no `closeIn`.
      const [, checkClosed, checkRestricted] = queries as [string, string, string, string];
      const plain = await market();
      const heldMarket = await market();
      const closedHeld = await market();
      const r = await member();
      const ended = await member();
      const c = await member();
      const open = await member();
      const restrictedLeft = await resting(r, plain, 'YES', 'buy', 30, 1);
      await resting(r, heldMarket, 'YES', 'buy', 20, 1);
      await resting(r, closedHeld, 'NO', 'buy', 20, 1);
      await resting(ended, plain, 'NO', 'buy', 30, 1);
      const closedLeft = await resting(c, plain, 'YES', 'buy', 10, 1);
      await resting(open, plain, 'NO', 'buy', 20, 1);
      await ledgerPause(heldMarket);
      await ledgerPause(closedHeld);
      await closeNow(closedHeld);
      const approver = (await createUser(t.db, { role: 'admin' })).user.id;
      const restrict = (userId: string, ago?: number) =>
        createModerationAction(t.db, {
          userId,
          createdBy: adminId,
          approvedBy: approver,
          type: 'account_restriction',
          ...(ago === undefined
            ? {}
            : {
                createdAt: new Date(Date.now() - ago),
                endsAt: new Date(Date.now() - ago / 2),
              }),
        });
      await restrict(r);
      await restrict(ended, 2 * 86_400_000);
      const run = async (query: string) =>
        (await t.db.$client.query<Record<string, unknown>>(query)).rows;
      // (c): the member under a restriction, not the one whose restriction ended, nor the held
      // markets' orders (one still paused, one closed before its recovery), which wait for the
      // recovery (owner answer 2026-11-06).
      expect(await run(checkRestricted)).toMatchObject([
        { id: restrictedLeft.id, user_id: r, market_id: plain },
      ]);
      // (b): a closed account's order, read in a transaction that never commits.
      const sentinel = new Error('roll back');
      let found: Record<string, unknown>[] = [];
      await expect(
        t.db.transaction(async (tx) => {
          await tx
            .update(profiles)
            .set({ nickname: null, bio: null, imageId: null, closedAt: sql`now()` })
            .where(eq(profiles.userId, c));
          found = (await tx.execute<Record<string, unknown>>(sql.raw(checkClosed))).rows;
          throw sentinel;
        }),
      ).rejects.toBe(sentinel);
      expect(found).toMatchObject([{ id: closedLeft.id, user_id: c, market_id: plain }]);
      expect(await run(checkClosed)).toEqual([]);
    });
  });

  it('writes the cancel only where the rows are live', async () => {
    // The UPDATE guard: a row read before another writer changed it (no market lock — only a test
    // does that) is refused, and the transaction rolls back with its release.
    const m = await market();
    const a = await member();
    const row = await resting(a, m, 'YES', 'buy', 40, 1);
    await expect(
      t.db.transaction(async (tx) => {
        const locked = await lockMarketOrders(tx, m);
        await tx
          .update(orders)
          .set({ status: 'cancelled', cancelReason: 'by_owner', endedAt: sql`now()` })
          .where(and(eq(orders.id, row.id), inArray(orders.status, ['open'])));
        await cancelLockedOrders(tx, locked, { reason: 'paused', at: await clockTimestamp(tx) });
      }),
    ).rejects.toThrow(`order ${row.id} changed outside its market's lock`);
    expect(await orderRow(row.id)).toEqual(row);
    await expectSound();
  });

  it('writes the cancel only where the filled qty is as read, the status unchanged', async () => {
    // The guard's filled-qty half: a fill that leaves the order 부분 체결 (1/3 → 2/3) keeps the
    // status, so only the filled qty tells the stale row apart. Without it the cancel would give
    // back the old rest (2 × 40) from a lock that holds 1 × 40.
    const m = await market();
    const a = await member();
    const b = await member();
    const row = await resting(a, m, 'NO', 'buy', 40, 3);
    await order(b, m, 'YES', 'buy', 'ioc', 65, 1);
    const partial = await orderRow(row.id);
    expect(partial).toMatchObject({ status: 'partially_filled', filledQty: 1 });
    const before = await written();
    await expect(
      t.db.transaction(async (tx) => {
        const locked = await lockMarketOrders(tx, m);
        await tx
          .update(orders)
          .set({
            filledQty: 2,
            filledAmountCoin: partial.filledAmountCoin * 2n,
          })
          .where(and(eq(orders.id, row.id), eq(orders.status, 'partially_filled')));
        await cancelLockedOrders(tx, locked, { reason: 'paused', at: await clockTimestamp(tx) });
      }),
    ).rejects.toThrow(`order ${row.id} changed outside its market's lock`);
    expect(await orderRow(row.id)).toEqual(partial);
    expect(await written()).toEqual(before);
    await expectSound();
  });
});
