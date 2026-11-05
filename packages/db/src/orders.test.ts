import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  isLiveOrderStatus,
  MARKET_STATUSES,
  ORDER_ACCEPTING_SETTING,
  orderRemainingLock,
  type MarketStatus,
  type OrderRejectReason,
  type OrderSide,
  type Outcome,
  type TimeInForce,
} from '@buddha/shared';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPairMintFill, applyTradeFill } from './contracts.js';
import { findLedgerAccount, LedgerEntryError } from './ledger.js';
import { hasMarketFill } from './market-dispute.js';
import { pauseMarket } from './market-pause.js';
import { transitionMarket } from './market-transitions.js';
import {
  orderLockFactsOf,
  placeOrder,
  readLiveBook,
  type OrderRow,
  type PlaceOrderResult,
} from './orders.js';
import { balances, fills, ledgerEntries, markets, orders, positions } from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import { createMarket, createUser, setReleaseSetting } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  mintTestPairs,
} from './test/ledger.js';
import {
  checkOrderInvariants,
  openOrderIntake,
  ORDER_LOCKS_CHECK_SQL,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';
import { waitForLockWaiter } from './test/wait.js';

/**
 * 주문 접수와 체결 (#119, ADR-0112): `placeOrder` against the test database — the refusals that
 * write nothing, the rejected rows, the four fill paths, 가격 보호, the remainders, the request id,
 * positions, races, the 운영 마켓메이커 as an owner, and the books after mixed sequences.
 */
describe.skipIf(!hasTestDb())('order intake (#119, docker test profile)', () => {
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
  const market = async (input: Parameters<typeof createMarket>[1] = {}) =>
    (await createMarket(t.db, { createdBy: adminId, ...input })).id;

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
    extra: Partial<PlaceTestOrderInput> = {},
  ) => placed({ ownerId, marketId, outcome, side, timeInForce, limitPriceCoin, qty, ...extra });
  const orderRow = async (id: string): Promise<OrderRow> =>
    (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  /** Rows of the tables an intake writes, and every balance: what a refusal must leave as is. */
  const written = async () => ({
    orders: (await t.db.select({ n: count() }).from(orders))[0]!.n,
    fills: (await t.db.select({ n: count() }).from(fills))[0]!.n,
    entries: (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n,
    positions: await t.db.select().from(positions).orderBy(positions.userId, positions.outcome),
    balances: (await t.db.select().from(balances).orderBy(balances.accountId)).map((row) => ({
      ...row,
      updatedAt: undefined,
    })),
  });
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
  /**
   * What one trade fill touched (ADR-0112 결정 8): both people's balances as they are now, keyed
   * by the fill's one TRADE_FILL entry, and both rows of the traded outcome.
   */
  const expectTradeTouched = async (
    done: Extract<PlaceOrderResult, { kind: 'placed' }>,
    people: string[],
    outcome: Outcome,
  ) => {
    expect(done.fills).toHaveLength(1);
    const fillId = String(done.fills[0]!.id);
    expect(done.touched.balances.map((row) => row.userId).sort()).toEqual([...people].sort());
    for (const row of done.touched.balances) {
      expect(row.entry).toMatchObject({ type: 'TRADE_FILL', refId: fillId });
      expect(row.balance).toEqual(await balanceOf(t.db, row.userId));
    }
    const marketId = done.order.marketId;
    const rows = await Promise.all(people.map((id) => positionOf(t.db, id, marketId, outcome)));
    const key = (row: { userId: string | null; outcome: string }) => `${row.userId}:${row.outcome}`;
    expect([...done.touched.positions].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
      rows.map((row) => row!).sort((x, y) => key(x).localeCompare(key(y))),
    );
  };

  describe('refusals that write nothing', () => {
    it('answers closed while order.accepting is not true — the 운영 마켓메이커 too', async () => {
      const m = await market();
      const a = await member();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const tries = [a, mm].map((ownerId) => ({ ownerId, marketId: m, requestId: randomUUID() }));
      for (const value of [null, false] as const) {
        await setReleaseSetting(t.db, {
          adminId,
          key: ORDER_ACCEPTING_SETTING.key,
          status: value === null ? 'undecided' : 'approved',
          value,
        });
        const before = await written();
        for (const input of tries) {
          expect(await placeTestOrder(t.db, input)).toEqual({ kind: 'closed', why: 'intake' });
        }
        expect(await written()).toEqual(before);
      }
      await setReleaseSetting(t.db, {
        adminId,
        key: ORDER_ACCEPTING_SETTING.key,
        status: 'approved',
        value: true,
      });
      // The refused request ids are free: the same ids now place.
      for (const input of tries) expect((await placeTestOrder(t.db, input)).kind).toBe('placed');
    });

    it('answers not_found for no market, a DRAFT and a REVIEW market', async () => {
      const a = await member();
      const before = await written();
      for (const marketId of [
        randomUUID(),
        await market({ status: 'draft' }),
        await market({ status: 'review' }),
      ]) {
        expect(await placeTestOrder(t.db, { ownerId: a, marketId })).toEqual({ kind: 'not_found' });
      }
      expect(await written()).toEqual(before);
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
    });

    it('answers closed for an immediate order on a market with no width; a GTC order rests', async () => {
      const m = await market({ priceProtectionTicks: null });
      const a = await member();
      const before = await written();
      expect(await placeTestOrder(t.db, { ownerId: a, marketId: m, timeInForce: 'ioc' })).toEqual({
        kind: 'closed',
        why: 'price_protection',
      });
      expect(await written()).toEqual(before);
      const gtc = await order(a, m, 'YES', 'buy', 'gtc', 40, 2);
      expect(gtc.order).toMatchObject({ status: 'open', protectionTicks: null });
      expect(await coin(a)).toEqual({ available: 920n, locked: 80n });
    });

    it('refuses terms no request carries (RangeError), and an admin’s order in the database', async () => {
      const m = await market();
      const a = await member();
      for (const bad of [
        { qty: 0 },
        { qty: 1_000_001 },
        { qty: null, budgetCoin: null },
        { qty: 1, budgetCoin: 10n },
        { qty: null, budgetCoin: 10n, timeInForce: 'gtc' as const },
        { qty: null, budgetCoin: 10n, side: 'sell' as const, timeInForce: 'ioc' as const },
        { limitPriceCoin: 100 },
        { requestId: 'short' },
      ]) {
        await expect(
          placeTestOrder(t.db, { ownerId: a, marketId: m, ...bad }),
        ).rejects.toBeInstanceOf(RangeError);
      }
      // The API answers FORBIDDEN first (ADR-0107 결정 5 '#119·#143'); any other writer meets the
      // trigger, and the transaction writes nothing.
      const admin = (await createUser(t.db, { role: 'admin', balanceCoin: 100n })).user.id;
      await expect(placeTestOrder(t.db, { ownerId: admin, marketId: m })).rejects.toThrow();
      expect((await written()).orders).toBe(0);
    });
  });

  describe('a market not OPEN', () => {
    it('rejects with 개장 전, 일시 중단 or 마감, nothing locked, the request id kept', async () => {
      const a = await member();
      const entries = (await written()).entries;
      const expected: Partial<Record<MarketStatus, OrderRejectReason>> = {
        scheduled: 'not_open_yet',
        paused: 'paused',
        closed: 'closed',
        provisional: 'closed',
        resolved: 'closed',
        settling: 'closed',
        settled: 'closed',
        cancelled: 'closed',
      };
      // The market's status is the first refusal: a market with no 가격 보호 폭 (submitted before
      // #119) rejects an immediate order for its status too, never 'closed' for the width.
      const cases = MARKET_STATUSES.flatMap((status) =>
        expected[status] === undefined
          ? []
          : ([undefined, null] as const).map((width) => ({ status, width })),
      );
      for (const { status, width } of cases) {
        const reason = expected[status]!;
        const m = await market(
          width === undefined ? { status } : { status, priceProtectionTicks: width },
        );
        for (const input of [
          { timeInForce: 'gtc' as const, qty: 2 },
          { timeInForce: 'ioc' as const, qty: 2 },
          { timeInForce: 'ioc' as const, qty: null, budgetCoin: 300n },
        ]) {
          const requestId = randomUUID();
          const done = await placed({ ownerId: a, marketId: m, requestId, ...input });
          expect(done.order, `${status} (${String(width)}) ${input.timeInForce}`).toMatchObject({
            status: 'rejected',
            rejectReason: reason,
            idempotencyKey: requestId,
            protectedLimitPrice: 50,
            referencePrice: null,
            protectionTicks: null,
            filledQty: 0,
            unspentCoin: input.budgetCoin ?? null,
          });
          expect(done.order.endedAt).toEqual(done.order.createdAt);
          expect(done.fills).toEqual([]);
        }
      }
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      expect((await written()).entries).toBe(entries);
    });
  });

  describe('assets at intake', () => {
    it('rejects 잔액 부족 and 보유량 부족 before matching decides, nothing filled or locked', async () => {
      const m = await market();
      const poor = await member(100n);
      // Asks beyond what is available, with a quote that would fill it.
      const seller = await yesHolder(m, 3);
      await order(seller, m, 'YES', 'sell', 'gtc', 40, 3);
      const before = await written();
      const qtyBuy = await order(poor, m, 'YES', 'buy', 'gtc', 60, 2);
      expect(qtyBuy.order).toMatchObject({ status: 'rejected', rejectReason: 'insufficient_coin' });
      const budget = await placed({
        ownerId: poor,
        marketId: m,
        budgetCoin: 150n,
        limitPriceCoin: 60,
      });
      expect(budget.order).toMatchObject({
        status: 'rejected',
        rejectReason: 'insufficient_coin',
        unspentCoin: 150n,
        referencePrice: 40,
        protectionTicks: 5,
        protectedLimitPrice: 45,
      });
      // No holding at all, and a holding its own resting sell has locked.
      const none = await order(poor, m, 'YES', 'sell', 'ioc', 30, 1);
      expect(none.order).toMatchObject({ rejectReason: 'insufficient_contracts' });
      const held = await order(seller, m, 'YES', 'sell', 'ioc', 30, 1);
      expect(held.order).toMatchObject({ rejectReason: 'insufficient_contracts' });
      const after = await written();
      expect(after.orders).toBe(before.orders + 4);
      expect({ ...after, orders: 0 }).toEqual({ ...before, orders: 0 });
    });

    it('says 잔액 부족 before 호가 부족: the lock is decided before the quote', async () => {
      const m = await market();
      const poor = await member(10n);
      const done = await order(poor, m, 'YES', 'buy', 'ioc', 50, 1);
      expect(done.order).toMatchObject({
        rejectReason: 'insufficient_coin',
        referencePrice: null,
        protectionTicks: 5,
        protectedLimitPrice: 50,
      });
    });
  });

  describe('the four paths', () => {
    it('mints the N01 §4 example: NO rests at 40, YES comes at 65 and fills one pair at 60', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const rest = await order(b, m, 'NO', 'buy', 'gtc', 40, 2);
      expect(rest.order).toMatchObject({
        status: 'open',
        protectedLimitPrice: 40,
        referencePrice: null,
        protectionTicks: null,
        endedAt: null,
      });
      expect(rest.touched).toEqual({ balances: [], positions: [] });
      expect(await positionOf(t.db, b, m, 'NO')).toBeUndefined();
      expect(await coin(b)).toEqual({ available: 920n, locked: 80n });

      const done = await order(a, m, 'YES', 'buy', 'ioc', 65, 1);
      expect(done.order).toMatchObject({
        status: 'filled',
        limitPrice: 65,
        protectedLimitPrice: 65,
        referencePrice: 60,
        protectionTicks: 5,
        filledQty: 1,
        filledAmountCoin: 60n,
        rejectReason: null,
        cancelReason: null,
      });
      expect(done.fills).toHaveLength(1);
      expect(done.fills[0]).toMatchObject({
        kind: 'pair_mint',
        incomingOrderId: done.order.id,
        restingOrderId: rest.order.id,
        incomingOwnerId: a,
        restingOwnerId: b,
        incomingAccountType: 'member',
        restingAccountType: 'member',
        outcome: 'YES',
        side: 'buy',
        qty: 1,
        priceCoin: 60,
        yesPriceCoin: 60,
        amountCoin: 60n,
        feeCoin: 0n,
      });
      expect(await orderRow(rest.order.id)).toMatchObject({
        status: 'partially_filled',
        filledQty: 1,
        filledAmountCoin: 40n,
        endedAt: null,
      });
      // 5 of A's 65 went back at the fill; B paid 40 out of its lock.
      expect(await coin(a)).toEqual({ available: 940n, locked: 0n });
      expect(await coin(b)).toEqual({ available: 920n, locked: 40n });
      expect(await positionOf(t.db, a, m, 'YES')).toMatchObject({ qty: 1, costBasisCoin: 60n });
      expect(await positionOf(t.db, b, m, 'NO')).toMatchObject({ qty: 1, costBasisCoin: 40n });
      expect(await contractBook(t.db, m)).toMatchObject({ yes: 1, no: 1, collateralCoin: 100n });
      // Both people's balances and positions, keyed by their last entry of this intake.
      expect(done.touched.balances.map((row) => row.userId).sort()).toEqual([a, b].sort());
      for (const row of done.touched.balances) {
        expect(row.entry).toMatchObject({
          type: 'PAIR_MINT_COLLATERAL',
          refId: String(done.fills[0]!.id),
        });
      }
      expect(done.touched.positions.map((row) => `${row.userId}:${row.outcome}`).sort()).toEqual(
        [`${a}:YES`, `${b}:NO`].sort(),
      );
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('trades a buy against a resting sell, at the sell’s price, within the protected limit', async () => {
      const m = await market();
      const s = await yesHolder(m, 3);
      const a = await member();
      const sell = await order(s, m, 'YES', 'sell', 'gtc', 55, 2);
      const locked = await positionOf(t.db, s, m, 'YES');
      expect(locked).toMatchObject({ qty: 3, lockedQty: 2 });
      // A sell that only rests locks its position row: that row is what it touched, with no
      // balance (no ledger entry), so `user:position` goes out for it (ADR-0112 결정 8).
      expect(sell.touched).toEqual({ balances: [], positions: [locked] });
      const sBefore = await coin(s);
      const done = await order(a, m, 'YES', 'buy', 'ioc', 70, 1);
      expect(done.order).toMatchObject({
        status: 'filled',
        protectedLimitPrice: 60,
        referencePrice: 55,
      });
      expect(done.fills[0]).toMatchObject({
        kind: 'trade',
        priceCoin: 55,
        yesPriceCoin: 55,
        amountCoin: 55n,
      });
      expect(await coin(a)).toEqual({ available: 945n, locked: 0n });
      expect(await coin(s)).toEqual({ available: sBefore.available + 55n, locked: 0n });
      expect(await positionOf(t.db, s, m, 'YES')).toMatchObject({
        qty: 2,
        lockedQty: 1,
        costBasisCoin: 100n,
        realizedPnlCoin: 5n,
      });
      expect(await orderRow(sell.order.id)).toMatchObject({
        status: 'partially_filled',
        filledAmountCoin: 55n,
      });
      // A trade touches both people: each balance keyed by the one TRADE_FILL entry, and both
      // YES rows — the resting seller's screen follows too (ADR-0112 결정 8).
      await expectTradeTouched(done, [a, s], 'YES');
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('trades a sell against a resting buy of its outcome, and records a NO trade by its YES price', async () => {
      const m = await market();
      const r = await member();
      const buy = await order(r, m, 'YES', 'buy', 'gtc', 45, 2);
      const s = await yesHolder(m, 3);
      const done = await order(s, m, 'YES', 'sell', 'ioc', 40, 2);
      expect(done.order).toMatchObject({
        status: 'filled',
        protectedLimitPrice: 40,
        referencePrice: 45,
        filledAmountCoin: 90n,
      });
      expect(done.fills.map((f) => [f.kind, f.priceCoin, f.qty])).toEqual([['trade', 45, 2]]);
      await expectTradeTouched(done, [r, s], 'YES');
      expect(await orderRow(buy.order.id)).toMatchObject({ status: 'filled', filledQty: 2 });
      expect((await orderRow(buy.order.id)).endedAt).toEqual(done.order.createdAt);
      expect(await coin(r)).toEqual({ available: 910n, locked: 0n });

      // NO: a holder of NO sells to a resting NO buy at 30 — the fill records YES 70.
      const noHolder = await member(1_000n);
      await mintTestPairs(t.db, {
        marketId: m,
        yesHolderId: await member(),
        noHolderId: noHolder,
        qty: 1,
      });
      await order(r, m, 'NO', 'buy', 'gtc', 30, 1);
      const no = await order(noHolder, m, 'NO', 'sell', 'ioc', 30, 1);
      expect(no.fills[0]).toMatchObject({
        kind: 'trade',
        outcome: 'NO',
        side: 'sell',
        priceCoin: 30,
        yesPriceCoin: 70,
      });
      await expectTradeTouched(no, [r, noHolder], 'NO');
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('fills a crossing GTC order at the resting prices and rests the rest at its limit', async () => {
      const m = await market();
      const s = await yesHolder(m, 1);
      const a = await member();
      await order(s, m, 'YES', 'sell', 'gtc', 55, 1);
      const done = await order(a, m, 'YES', 'buy', 'gtc', 60, 3);
      expect(done.order).toMatchObject({
        status: 'partially_filled',
        filledQty: 1,
        filledAmountCoin: 55n,
        protectedLimitPrice: 60,
        referencePrice: null,
        protectionTicks: null,
        endedAt: null,
      });
      expect(await coin(a)).toEqual({ available: 825n, locked: 120n });
      const book = await readLiveBook(t.db, m);
      expect(book).toEqual([
        {
          id: done.order.id,
          owner: { id: a, human: true },
          accountType: 'member',
          outcome: 'YES',
          side: 'buy',
          priceCoin: 60,
          remainingQty: 2,
          arrival: done.order.arrivalSeq,
        },
      ]);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });
  });

  describe('가격 보호 (#177 2항)', () => {
    it('narrows an immediate buy to the best ask + the market’s width, never past 99', async () => {
      const m = await market();
      const s = await yesHolder(m, 2);
      await order(s, m, 'YES', 'sell', 'gtc', 40, 1);
      await order(s, m, 'YES', 'sell', 'gtc', 46, 1);
      const a = await member();
      // An API limit of 99 is not a market order: 40 + 5 = 45 stops before 46.
      const done = await order(a, m, 'YES', 'buy', 'ioc', 99, 2);
      expect(done.order).toMatchObject({
        status: 'cancelled',
        cancelReason: 'ioc_remainder',
        limitPrice: 99,
        protectedLimitPrice: 45,
        referencePrice: 40,
        protectionTicks: 5,
        filledQty: 1,
      });
      expect(await coin(a)).toEqual({ available: 960n, locked: 0n });
      // Only narrows: a limit below the band stays, and nothing fills above it.
      const low = await order(a, m, 'YES', 'buy', 'ioc', 44, 1);
      expect(low.order).toMatchObject({
        protectedLimitPrice: 44,
        referencePrice: 46,
        rejectReason: 'price_limit',
      });
      // Up to 99 only: a quote at 97 with width 5.
      const m2 = await market();
      const s2 = await yesHolder(m2, 1);
      await order(s2, m2, 'YES', 'sell', 'gtc', 97, 1);
      const top = await order(a, m2, 'YES', 'buy', 'ioc', 99, 1);
      expect(top.order).toMatchObject({ protectedLimitPrice: 99, status: 'filled' });
    });

    it('narrows an immediate sell to the best bid − the width, never below 1', async () => {
      const m = await market();
      const r = await member();
      await order(r, m, 'YES', 'buy', 'gtc', 50, 1);
      await order(r, m, 'YES', 'buy', 'gtc', 44, 1);
      const s = await yesHolder(m, 2);
      const done = await order(s, m, 'YES', 'sell', 'ioc', 1, 2);
      expect(done.order).toMatchObject({
        protectedLimitPrice: 45,
        referencePrice: 50,
        filledQty: 1,
      });
      expect(done.fills.map((f) => f.priceCoin)).toEqual([50]);
      const m2 = await market();
      await order(r, m2, 'YES', 'buy', 'gtc', 3, 1);
      const s2 = await yesHolder(m2, 1);
      const floor = await order(s2, m2, 'YES', 'sell', 'ioc', 1, 1);
      expect(floor.order).toMatchObject({ protectedLimitPrice: 1, status: 'filled' });
    });

    it('reads the converted supply and the own resting order as the reference', async () => {
      const m = await market();
      const b = await member();
      await order(b, m, 'NO', 'buy', 'gtc', 30, 1); // YES 70
      const a = await yesHolder(m, 1);
      await order(a, m, 'YES', 'sell', 'gtc', 80, 1);
      const x = await member();
      expect((await order(x, m, 'YES', 'buy', 'ioc', 99, 1)).order).toMatchObject({
        referencePrice: 70,
        protectedLimitPrice: 75,
        status: 'filled',
      });
      // A's own resting sell at 80 is the best ask now: the reference, then the self-trade stop.
      const own = await order(a, m, 'YES', 'buy', 'ioc', 99, 1);
      expect(own.order).toMatchObject({
        referencePrice: 80,
        protectedLimitPrice: 85,
        status: 'rejected',
        rejectReason: 'self_trade',
      });
    });

    it('uses the market’s width, not the default, and a changed width for the next order only', async () => {
      const m = await market({ priceProtectionTicks: 2 });
      const s = await yesHolder(m, 3);
      const resting = await order(s, m, 'YES', 'sell', 'gtc', 40, 1);
      await order(s, m, 'YES', 'sell', 'gtc', 48, 1);
      const a = await member();
      const first = await order(a, m, 'YES', 'buy', 'ioc', 99, 2);
      expect(first.order).toMatchObject({
        protectedLimitPrice: 42,
        protectionTicks: 2,
        filledQty: 1,
      });
      // The after-open change (the admin route of stage 3 writes it the same way).
      await t.db.update(markets).set({ priceProtectionTicks: 10 }).where(eq(markets.id, m));
      const restingAfter = await orderRow(resting.order.id);
      expect(restingAfter.protectedLimitPrice).toBe(40);
      const next = await order(a, m, 'YES', 'buy', 'ioc', 99, 1);
      expect(next.order).toMatchObject({
        protectedLimitPrice: 58,
        protectionTicks: 10,
        status: 'filled',
      });
      // The first order's row keeps the width it used.
      expect((await orderRow(first.order.id)).protectionTicks).toBe(2);
    });

    it('fills nothing with no opposite quote: 거절 호가 부족, the limit as it came', async () => {
      const m = await market();
      const a = await member();
      const done = await order(a, m, 'YES', 'buy', 'ioc', 99, 1);
      expect(done.order).toMatchObject({
        status: 'rejected',
        rejectReason: 'no_quote',
        protectedLimitPrice: 99,
        referencePrice: null,
        protectionTicks: 5,
      });
      expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
    });
  });

  describe('remainders and end states (ADR-0111 결정 6)', () => {
    it('ends a GTC order meeting its own group like an IOC: no rest, its lock back', async () => {
      const m = await market();
      const a = await member();
      const c = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 45, 1); // YES 55
      const first = await order(a, m, 'YES', 'buy', 'gtc', 70, 2);
      expect(first.order).toMatchObject({
        status: 'rejected',
        rejectReason: 'self_trade',
        filledQty: 0,
      });
      expect(await coin(a)).toEqual({ available: 955n, locked: 45n });
      await order(c, m, 'NO', 'buy', 'gtc', 48, 1); // YES 52, before A's 55
      const second = await order(a, m, 'YES', 'buy', 'gtc', 70, 3);
      expect(second.order).toMatchObject({
        status: 'cancelled',
        cancelReason: 'self_trade',
        filledQty: 1,
        filledAmountCoin: 52n,
      });
      expect(await coin(a)).toEqual({ available: 903n, locked: 45n });
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('spends a budget until the next contract is beyond it, and gives the unspent Coin back', async () => {
      const m = await market({ priceProtectionTicks: 20 });
      const b = await member();
      await order(b, m, 'NO', 'buy', 'gtc', 40, 1); // YES 60
      await order(b, m, 'NO', 'buy', 'gtc', 30, 5); // YES 70
      const a = await member();
      const done = await placed({ ownerId: a, marketId: m, budgetCoin: 190n, limitPriceCoin: 99 });
      expect(done.order).toMatchObject({
        status: 'filled',
        qty: null,
        budgetCoin: 190n,
        filledQty: 2,
        filledAmountCoin: 130n,
        unspentCoin: 60n,
        protectedLimitPrice: 80,
        referencePrice: 60,
      });
      expect(done.fills.map((f) => [f.priceCoin, f.qty])).toEqual([
        [60, 1],
        [70, 1],
      ]);
      expect(await coin(a)).toEqual({ available: 870n, locked: 0n });
      expect(await hasMarketFill(t.db, a, m)).toBe(true);

      // 금액 부족: the best price within the limit is above the whole budget.
      const small = await member();
      const none = await placed({
        ownerId: small,
        marketId: m,
        budgetCoin: 50n,
        limitPriceCoin: 99,
      });
      expect(none.order).toMatchObject({
        status: 'rejected',
        rejectReason: 'budget_too_small',
        unspentCoin: 50n,
        filledQty: 0,
      });
      expect(await coin(small)).toEqual({ available: 1_000n, locked: 0n });
      expect(await hasMarketFill(t.db, small, m)).toBe(false);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });
  });

  describe('the request id', () => {
    it('answers a re-sent request with its order as it stands now, writing nothing', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const requestId = randomUUID();
      const first = await order(a, m, 'NO', 'buy', 'gtc', 40, 1, { requestId });
      await order(b, m, 'YES', 'buy', 'ioc', 99, 1);
      const before = await written();
      const again = await placeTestOrder(t.db, {
        ownerId: a,
        marketId: m,
        requestId,
        outcome: 'NO',
        limitPriceCoin: 40,
      });
      expect(again).toMatchObject({
        kind: 'replayed',
        order: { id: first.order.id, status: 'filled' },
      });
      // A rejected order replays too; the confirmed limit is what is compared, not the protected.
      const rejectedId = randomUUID();
      const rejected = await order(b, m, 'YES', 'buy', 'ioc', 99, 1, { requestId: rejectedId });
      expect(rejected.order.rejectReason).toBe('no_quote');
      expect(
        await placeTestOrder(t.db, {
          ownerId: b,
          marketId: m,
          requestId: rejectedId,
          timeInForce: 'ioc',
          limitPriceCoin: 99,
        }),
      ).toMatchObject({ kind: 'replayed', order: { id: rejected.order.id } });
      // Other terms: conflict, nothing written.
      for (const other of [
        { limitPriceCoin: 41 },
        { qty: 2 },
        { side: 'sell' as const },
        { timeInForce: 'ioc' as const },
        { marketId: await market() },
      ]) {
        expect(
          await placeTestOrder(t.db, {
            ownerId: a,
            marketId: m,
            requestId,
            outcome: 'NO',
            limitPriceCoin: 40,
            ...other,
          }),
        ).toEqual({ kind: 'conflict' });
      }
      expect((await written()).orders).toBe(before.orders + 1);
      // Another account's request id is its own.
      expect((await placeTestOrder(t.db, { ownerId: b, marketId: m, requestId })).kind).toBe(
        'placed',
      );
    });

    it('answers a re-sent request before it reads order.accepting: a closed intake replays', async () => {
      const m = await market();
      const a = await member();
      const requestId = randomUUID();
      const first = await order(a, m, 'NO', 'buy', 'gtc', 40, 2, { requestId });
      for (const value of [false, null] as const) {
        await setReleaseSetting(t.db, {
          adminId,
          key: ORDER_ACCEPTING_SETTING.key,
          status: value === null ? 'undecided' : 'approved',
          value,
        });
        const before = await written();
        const same = { ownerId: a, marketId: m, requestId, outcome: 'NO' as const, qty: 2 };
        expect(await placeTestOrder(t.db, { ...same, limitPriceCoin: 40 })).toEqual({
          kind: 'replayed',
          order: first.order,
        });
        expect(await placeTestOrder(t.db, { ...same, limitPriceCoin: 41 })).toEqual({
          kind: 'conflict',
        });
        // A fresh request id is what the closed intake refuses.
        expect(await placeTestOrder(t.db, { ownerId: a, marketId: m })).toEqual({
          kind: 'closed',
          why: 'intake',
        });
        expect(await written()).toEqual(before);
      }
    });

    it('takes one order when the same request comes twice at once, in one market or two', async () => {
      const m = await market();
      const m2 = await market();
      const a = await member();
      for (const [secondMarket, expected] of [
        [m, 'replayed'],
        [m2, 'conflict'],
      ] as const) {
        const requestId = randomUUID();
        let go!: () => void;
        const held = new Promise<void>((resolve) => (go = resolve));
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const first = t.db.transaction(async (tx) => {
          const done = await placeOrder(tx, {
            ownerId: a,
            marketId: m,
            requestId,
            outcome: 'YES',
            side: 'buy',
            timeInForce: 'gtc',
            limitPriceCoin: 10,
            qty: 1,
            budgetCoin: null,
          });
          entered();
          await held;
          return done;
        });
        await inside;
        const second = placeTestOrder(t.db, {
          ownerId: a,
          marketId: secondMarket,
          requestId,
          limitPriceCoin: 10,
        });
        await waitForLockWaiter(t.db.$client, 'the second request waits on the first');
        go();
        const one = await first;
        expect(one.kind).toBe('placed');
        const two: PlaceOrderResult = await second;
        expect(two.kind).toBe(expected);
        if (two.kind === 'replayed' && one.kind === 'placed')
          expect(two.order.id).toBe(one.order.id);
      }
      expect((await written()).orders).toBe(2);
      expect(await coin(a)).toEqual({ available: 980n, locked: 20n });
    });
  });

  describe('positions', () => {
    it('makes no row for a resting buy, a weighted cost on buys, and realized PnL on a sell', async () => {
      const m = await market({ priceProtectionTicks: 20 });
      const s = await yesHolder(m, 2);
      const a = await member();
      await order(a, m, 'YES', 'buy', 'gtc', 10, 1);
      expect(await positionOf(t.db, a, m, 'YES')).toBeUndefined();
      await order(s, m, 'YES', 'sell', 'gtc', 60, 1);
      await order(s, m, 'YES', 'sell', 'gtc', 70, 1);
      await order(a, m, 'YES', 'buy', 'ioc', 75, 2);
      expect(await positionOf(t.db, a, m, 'YES')).toMatchObject({ qty: 2, costBasisCoin: 130n });
      const r = await member();
      await order(r, m, 'YES', 'buy', 'gtc', 80, 1);
      const sold = await order(a, m, 'YES', 'sell', 'ioc', 1, 1);
      expect(sold.order).toMatchObject({
        protectedLimitPrice: 60,
        status: 'filled',
        filledAmountCoin: 80n,
      });
      expect(await positionOf(t.db, a, m, 'YES')).toMatchObject({
        qty: 1,
        lockedQty: 0,
        costBasisCoin: 65n,
        realizedPnlCoin: 15n,
      });
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });
  });

  describe('races', () => {
    it('never locks one account’s Coin twice across two markets', async () => {
      const m1 = await market();
      const m2 = await market();
      const a = await member();
      let go!: () => void;
      const held = new Promise<void>((resolve) => (go = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const first = t.db.transaction(async (tx) => {
        const done = await placeOrder(tx, {
          ownerId: a,
          marketId: m1,
          requestId: randomUUID(),
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: 60,
          qty: 10,
          budgetCoin: null,
        });
        entered();
        await held;
        return done;
      });
      await inside;
      const second = order(a, m2, 'YES', 'buy', 'gtc', 50, 10);
      await waitForLockWaiter(t.db.$client, 'the second market’s intake waits on the account');
      go();
      expect((await first).kind).toBe('placed');
      expect((await second).order).toMatchObject({ rejectReason: 'insufficient_coin' });
      expect(await coin(a)).toEqual({ available: 400n, locked: 600n });
    });

    it('meets two people crossing in two markets at once without a deadlock', async () => {
      for (let round = 0; round < 4; round += 1) {
        const m1 = await market();
        const m2 = await market();
        const a = await member();
        const b = await member();
        await order(a, m1, 'NO', 'buy', 'gtc', 40, 1);
        await order(b, m2, 'NO', 'buy', 'gtc', 40, 1);
        const [one, two] = await Promise.all([
          order(b, m1, 'YES', 'buy', 'ioc', 65, 1),
          order(a, m2, 'YES', 'buy', 'ioc', 65, 1),
        ]);
        expect([one.order.status, two.order.status]).toEqual(['filled', 'filled']);
      }
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('meets a pause and a close on the market lock: rejected after, resting before', async () => {
      for (const edge of ['pause', 'close'] as const) {
        const m = await market();
        const a = await member();
        let go!: () => void;
        const held = new Promise<void>((resolve) => (go = resolve));
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const changing = t.db.transaction(async (tx) => {
          await lockMarket(tx, m);
          const [row] = await tx.select().from(markets).where(eq(markets.id, m)).for('update');
          const now = await clockTimestamp(tx);
          if (edge === 'pause') {
            const done = await pauseMarket(tx, {
              market: row!,
              now,
              actorId: adminId,
              reason: 'basis_change',
              note: '시험',
              resultPublishedAt: null,
            });
            expect(done.paused).toBe(true);
          } else {
            await transitionMarket(tx, {
              marketId: m,
              from: 'open',
              to: 'closed',
              type: 'closed',
              actorId: null,
              at: now,
            });
          }
          entered();
          await held;
        });
        await inside;
        const ordering = order(a, m, 'YES', 'buy', 'gtc', 40, 1);
        await waitForLockWaiter(t.db.$client, `the order waits on the ${edge}`);
        go();
        await changing;
        expect((await ordering).order).toMatchObject({
          status: 'rejected',
          rejectReason: edge === 'pause' ? 'paused' : 'closed',
        });
        expect(await coin(a)).toEqual({ available: 1_000n, locked: 0n });
      }
      // An order that rested before the pause keeps resting with its lock (#178 cancels it).
      const m = await market();
      const a = await member();
      const rested = await order(a, m, 'YES', 'buy', 'gtc', 40, 1);
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, m);
        const [row] = await tx.select().from(markets).where(eq(markets.id, m)).for('update');
        await pauseMarket(tx, {
          market: row!,
          now: await clockTimestamp(tx),
          actorId: adminId,
          reason: 'basis_change',
          note: '시험',
          resultPublishedAt: null,
        });
      });
      expect((await orderRow(rested.order.id)).status).toBe('open');
      expect(await coin(a)).toEqual({ available: 960n, locked: 40n });
    });
  });

  describe('the 운영 마켓메이커 as an owner', () => {
    it('rests from its funds, fills people, never meets itself, and is left out of `touched`', async () => {
      const m = await market();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const funds = { kind: 'market_maker_funds', marketId: m } as const;
      const bid = await order(mm, m, 'NO', 'buy', 'gtc', 40, 3);
      expect(bid.order.status).toBe('open');
      expect(await ledgerAccountBalance(t.db, funds)).toMatchObject({
        availableCoin: 880n,
        lockedCoin: 120n,
      });
      const book = await readLiveBook(t.db, m);
      expect(book[0]).toMatchObject({
        owner: { id: mm, human: false },
        accountType: 'market_maker',
      });

      const a = await member();
      const done = await order(a, m, 'YES', 'buy', 'ioc', 65, 2);
      expect(done.fills.map((f) => [f.kind, f.qty, f.yesPriceCoin, f.restingAccountType])).toEqual([
        ['pair_mint', 2, 60, 'market_maker'],
      ]);
      expect(done.touched.balances.map((row) => row.userId)).toEqual([a]);
      expect(done.touched.positions.map((row) => row.userId)).toEqual([a]);
      expect(await ledgerAccountBalance(t.db, funds)).toMatchObject({
        availableCoin: 880n,
        lockedCoin: 40n,
      });

      const self = await order(mm, m, 'YES', 'buy', 'ioc', 99, 1);
      expect(self.order).toMatchObject({ status: 'rejected', rejectReason: 'self_trade' });
      expect(await ledgerAccountBalance(t.db, funds)).toMatchObject({
        availableCoin: 880n,
        lockedCoin: 40n,
      });

      // A market with no funds yet: 잔액 부족, and no funds account made by the refusal.
      const bare = await market();
      const none = await order(mm, bare, 'NO', 'buy', 'gtc', 40, 1);
      expect(none.order).toMatchObject({ rejectReason: 'insufficient_coin' });
      expect(
        await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: bare }),
      ).toBeNull();
      // With no bot quoting, people still trade with each other.
      const b = await member();
      await order(b, bare, 'NO', 'buy', 'gtc', 45, 1);
      expect((await order(a, bare, 'YES', 'buy', 'ioc', 60, 1)).order.status).toBe('filled');
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });
  });

  describe('fill replays (ADR-0110 10-25)', () => {
    it('answers duplicate for the fill as recorded and key_conflict for other terms of one amount', async () => {
      const m = await market();
      const s = await yesHolder(m, 2);
      await order(s, m, 'YES', 'sell', 'gtc', 30, 2);
      const a = await member();
      const done = await order(a, m, 'YES', 'buy', 'ioc', 35, 2);
      const fillId = String(done.fills[0]!.id);
      const replay = (qty: number, priceCoin: number, outcome: Outcome = 'YES') =>
        t.db.transaction((tx) =>
          applyTradeFill(tx, {
            marketId: m,
            fillId,
            outcome,
            qty,
            priceCoin,
            buyer: { ownerId: a, limitPriceCoin: priceCoin },
            sellerId: s,
          }),
        );
      expect(await replay(2, 30)).toEqual({ outcome: 'duplicate' });
      for (const [qty, price] of [
        [1, 60],
        [3, 20],
      ] as const) {
        const error = await replay(qty, price).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LedgerEntryError);
        expect((error as LedgerEntryError).code).toBe('key_conflict');
      }
      const no = await replay(2, 30, 'NO').catch((e: unknown) => e);
      expect((no as LedgerEntryError).code).toBe('key_conflict');

      // A pair mint's replay as recorded is a duplicate.
      const b = await member();
      await order(b, m, 'NO', 'buy', 'gtc', 40, 1);
      const mint = await order(a, m, 'YES', 'buy', 'ioc', 65, 1);
      expect(
        await t.db.transaction((tx) =>
          applyPairMintFill(tx, {
            marketId: m,
            fillId: String(mint.fills[0]!.id),
            qty: 1,
            yesPriceCoin: 60,
            yes: { ownerId: a, limitPriceCoin: 65 },
            no: { ownerId: b, limitPriceCoin: 40 },
          }),
        ),
      ).toEqual({ outcome: 'duplicate' });
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });
  });

  describe('the books after mixed sequences', () => {
    /** A small deterministic generator (mulberry32). */
    const generator = (seed: number) => {
      let state = seed >>> 0;
      return (n: number) => {
        state = (state + 0x6d2b79f5) >>> 0;
        let x = state;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) % n;
      };
    };

    it('keeps every lock an order’s, YES = NO, collateral = pairs × 100 and the supply', async () => {
      const seen = new Map<string, number>();
      for (const seed of [3, 119]) {
        await t.reset();
        adminId = (await createUser(t.db, { role: 'admin' })).user.id;
        await openOrderIntake(t.db, { adminId });
        const pick = generator(seed);
        const marketIds = [await market(), await market({ priceProtectionTicks: 15 })];
        const people = [await member(2_000n), await member(2_000n), await member(2_000n)];
        const mms = [];
        for (const m of marketIds) {
          mms.push(await fundMarketMakerFunds(t.db, m, 3_000n));
          await mintTestPairs(t.db, {
            marketId: m,
            yesHolderId: people[0]!,
            noHolderId: people[1]!,
            qty: 4,
          });
        }
        const owners = [...people, mms[0]!];
        for (let step = 0; step < 60; step += 1) {
          const budget = pick(6) === 0;
          const result = await placeTestOrder(t.db, {
            ownerId: owners[pick(owners.length)]!,
            marketId: marketIds[pick(2)]!,
            outcome: pick(2) === 0 ? 'YES' : 'NO',
            side: budget || pick(3) > 0 ? 'buy' : 'sell',
            timeInForce: budget || pick(2) === 0 ? 'ioc' : 'gtc',
            limitPriceCoin: 20 + pick(61),
            qty: budget ? null : 1 + pick(4),
            budgetCoin: budget ? BigInt(30 + pick(200)) : null,
          });
          expect(result.kind).toBe('placed');
          if (result.kind !== 'placed') continue;
          const key = result.order.rejectReason ?? result.order.cancelReason ?? result.order.status;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (result.fills.length > 0)
            seen.set('fill', (seen.get('fill') ?? 0) + result.fills.length);
        }
        expect(await checkOrderInvariants(t.db)).toEqual([]);
        // The operators' check (docs/OPERATIONS.md '주문 접수') as buddha_app: nothing to show.
        expect((await t.db.$client.query(ORDER_LOCKS_CHECK_SQL)).rows).toEqual([]);
        // The exported rule says the same: Σ `orderRemainingLock(orderLockFactsOf(row))` over
        // every order row — an ended one adds nothing — is each holder's lock (what #178·#120
        // release and #93 sums). The 운영 마켓메이커's Coin lock is per market (its fund).
        const coinLocks = new Map<string, bigint>();
        const qtyLocks = new Map<string, number>();
        for (const row of await t.db.select().from(orders)) {
          const lock = orderRemainingLock(orderLockFactsOf(row));
          const held = lock.kind === 'coin' ? lock.amountCoin > 0n : lock.qty > 0;
          if (!isLiveOrderStatus(row.status)) expect(held, row.status).toBe(false);
          if (!held) continue;
          if (lock.kind === 'coin') {
            const key = row.userId === mms[0] ? `${row.userId}:${row.marketId}` : row.userId;
            coinLocks.set(key, (coinLocks.get(key) ?? 0n) + lock.amountCoin);
          } else {
            const key = `${row.userId}:${row.marketId}:${lock.outcome}`;
            qtyLocks.set(key, (qtyLocks.get(key) ?? 0) + lock.qty);
          }
        }
        const { rows: lockedCoin } = await t.db.execute<{ key: string; locked: string }>(
          sql`SELECT CASE a.kind WHEN 'user' THEN a.owner_id ELSE a.owner_id || ':' || a.market_id
                     END AS key, b.locked_coin::text AS locked
                FROM ledger_accounts a JOIN balances b ON b.account_id = a.id
               WHERE a.kind IN ('user', 'market_maker_funds') AND b.locked_coin <> 0`,
        );
        expect(new Map(lockedCoin.map((row) => [row.key, BigInt(row.locked)]))).toEqual(coinLocks);
        const lockedQty = await t.db.select().from(positions);
        expect(
          new Map(
            lockedQty
              .filter((row) => row.lockedQty !== 0)
              .map((row) => [`${row.userId}:${row.marketId}:${row.outcome}`, row.lockedQty]),
          ),
        ).toEqual(qtyLocks);
        expect(coinLocks.size + qtyLocks.size, 'some lock is held').toBeGreaterThan(0);
      }
      for (const kind of ['fill', 'open', 'filled', 'no_quote']) {
        expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(0);
      }
    });

    it('is the check docs/OPERATIONS.md gives operators, word for word', () => {
      // docs/OPERATIONS.md '주문 접수 (#119, ADR-0112)': its first SQL block (a) is the helper's,
      // so what the tests run is what an operator runs (contracts.test.ts reads '계약과 담보').
      const doc = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
      const section = doc.slice(doc.indexOf('## 주문 접수 (#119, ADR-0112)'));
      const query = /```sql\n([\s\S]*?)```/.exec(section.slice(0, section.indexOf('\n## ')))?.[1];
      expect(query).toBe(ORDER_LOCKS_CHECK_SQL);
    });

    it('shows a lock no live order explains in the operators’ check', async () => {
      const m = await market();
      const a = await member();
      await order(a, m, 'YES', 'buy', 'gtc', 40, 2);
      // A lock taken around the intake (as only a test can): the check names the account.
      await t.db.execute(
        sql`UPDATE balances SET available_coin = available_coin - 7, locked_coin = locked_coin + 7 WHERE user_id = ${a}`,
      );
      expect((await t.db.$client.query(ORDER_LOCKS_CHECK_SQL)).rows).toEqual([
        { lock: 'coin', holder: 'user', owner_id: a, market_id: null, locked: '87', live: '80' },
      ]);
    });
  });

  // ADR-0109 결과 4 asked how the event-side checks cost an intake that sweeps the book; the
  // number goes into ADR-0112. Off by default (PERF=1 runs it).
  it.skipIf(process.env.PERF !== '1')(
    'times an immediate order that sweeps 50 resting orders',
    async () => {
      const m = await market({ priceProtectionTicks: 98 });
      const b = await member(100_000n);
      for (let i = 0; i < 50; i += 1) await order(b, m, 'NO', 'buy', 'gtc', 40, 1);
      const a = await member(100_000n);
      const started = performance.now();
      const done = await order(a, m, 'YES', 'buy', 'ioc', 99, 50);
      const ms = performance.now() - started;
      expect(done.fills).toHaveLength(50);
      console.info(`[perf] one intake, 50 pair-mint fills: ${ms.toFixed(0)} ms`);
    },
  );
});
