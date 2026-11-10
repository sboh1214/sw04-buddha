import { randomUUID } from 'node:crypto';
import { ORDER_ACCEPTING_SETTING, type Outcome } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import * as contracts from './contracts.js';
import { setMarketLiquidity } from './market-liquidity.js';
import {
  placeOrder,
  placeOrderChangedBook,
  readLiveBook,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from './orders.js';
import {
  balances,
  fills,
  ledgerAccounts,
  ledgerEntries,
  markets,
  orders,
  positions,
} from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import { createMarket, createUser, setReleaseSetting } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds, ledgerAccountBalance, ledgerSupply } from './test/ledger.js';
import {
  cancelTestOrder,
  checkMarketStats,
  checkOrderInvariants,
  createOrder,
  openOrderIntake,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/**
 * #128 at the real intake: a market's cumulative reservation, per-fill clipping and remainder
 * cancellation, replay precedence, market-lock serialization, and atomic asset writes. The
 * unsafe resting orders below model reservations made before the risk gate: their assets are
 * fully locked, but their risk is too large. No immutable configuration is lowered or rewritten.
 * These are explicit test settings, not release defaults or a decision on public depth.
 */
describe.skipIf(!hasTestDb())('market maker risk at order intake (#128)', () => {
  let t: TestDb;
  let adminId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  const member = async () => (await createUser(t.db, { balanceCoin: 1_000n })).user.id;

  async function riskMarket(maxLoss = 100n) {
    const draft = await createMarket(t.db, {
      createdBy: adminId,
      status: 'draft',
      priceProtectionTicks: 98,
    });
    await t.db.transaction(async (tx) => {
      const config = await setMarketLiquidity(tx, {
        marketId: draft.id,
        actorId: adminId,
        baseVersion: null,
        reason: '주문 위험 통합 시험의 초기 설정',
        settings: {
          budgetCoin: 1_000n,
          maxLossCoin: maxLoss,
          b: 100,
          levels: 3,
          quantity: 10,
          safetyTicks: 1,
        },
      });
      // The fixture enters OPEN with the same pointer that a scheduled opening pins (#72).
      // Review/approval permissions are tested by that feature's own routes, not bypassed by a
      // product helper here. Both state writes remain under setMarketLiquidity's market lock.
      await tx.update(markets).set({ status: 'scheduled' }).where(eq(markets.id, draft.id));
      await tx
        .update(markets)
        .set({
          status: 'open',
          openAt: await clockTimestamp(tx),
          openedLiquidityVersion: config.version,
        })
        .where(eq(markets.id, draft.id));
    });
    const mm = await fundMarketMakerFunds(t.db, draft.id, 1_000n);
    return { id: draft.id, mm };
  }
  type RiskMarket = Awaited<ReturnType<typeof riskMarket>>;

  const input = (
    ownerId: string,
    marketId: string,
    extra: Partial<PlaceOrderInput> = {},
  ): PlaceOrderInput => ({
    ownerId,
    marketId,
    requestId: randomUUID(),
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 99,
    qty: 1,
    budgetCoin: null,
    ...extra,
  });

  function placedResult(result: PlaceOrderResult) {
    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error(`expected placed, got ${result.kind}`);
    return result;
  }
  const placed = async (terms: PlaceTestOrderInput) =>
    placedResult(await placeTestOrder(t.db, terms));
  const row = async (id: string) => (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const funds = async (m: RiskMarket) =>
    (await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: m.id }))!;
  const marketStats = async (marketId: string) =>
    (
      await t.db
        .select({
          lastPrice: markets.lastPrice,
          lastFillAt: markets.lastFillAt,
          volumeCoin: markets.volumeCoin,
          tradeCount: markets.tradeCount,
          traderCount: markets.traderCount,
        })
        .from(markets)
        .where(eq(markets.id, marketId))
    )[0]!;

  /** All durable intake effects, including accounts first created by a rolled-back fill. */
  const written = async () => ({
    orders: await t.db.select().from(orders).orderBy(orders.arrivalSeq),
    fills: await t.db.select().from(fills).orderBy(fills.id),
    entries: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
    accounts: await t.db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
    positions: await t.db
      .select()
      .from(positions)
      .orderBy(positions.marketId, positions.userId, positions.outcome),
    markets: await t.db.select().from(markets).orderBy(markets.id),
  });

  async function conserved(m: RiskMarket) {
    expect(await checkOrderInvariants(t.db)).toEqual([]);
    expect(await checkMarketStats(t.db)).toEqual([]);
    const supply = await ledgerSupply(t.db);
    expect(supply.heldCoin).toBe(supply.mintedCoin - supply.burnedCoin);
    expect(supply.carriedCoin).toBe(supply.heldCoin);
    const book = await contractBook(t.db, m.id);
    expect(book.yes).toBe(book.no);
    expect(book.collateralCoin).toBe(BigInt(book.yes) * 100n);
  }

  /**
   * An asset-backed legacy bid, deliberately bypassing only the new admission gate. Reuse the
   * public fixture's order checks/arrival key and the real contract lock, in one market-locked
   * transaction. createOrder starts a nested savepoint on this transaction handle.
   */
  async function legacyBid(m: RiskMarket, price: number, qty: number, outcome: Outcome = 'NO') {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, m.id);
      const locked = await contracts.lockForOrder(tx, {
        marketId: m.id,
        ownerId: m.mm,
        lock: { kind: 'coin', amountCoin: BigInt(price) * BigInt(qty) },
      });
      if (!locked.locked) throw new Error(`legacy bid has no assets: ${locked.reason}`);
      return createOrder(tx as unknown as Db, {
        marketId: m.id,
        userId: m.mm,
        outcome,
        side: 'buy',
        limitPriceCoin: price,
        qty,
      });
    });
  }

  /** Hold the first actual intake uncommitted until the second demonstrably waits on its lock. */
  async function race(firstInput: PlaceOrderInput, secondInput: PlaceOrderInput) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    let failed!: (reason: unknown) => void;
    const inside = new Promise<void>((resolve, reject) => {
      entered = resolve;
      failed = reject;
    });
    const first = t.db.transaction(async (tx) => {
      const result = await placeOrder(tx, firstInput);
      entered();
      await held;
      return result;
    });
    void first.catch(failed);
    let second: Promise<PlaceOrderResult> | undefined;
    try {
      await inside;
      second = t.db.transaction((tx) => placeOrder(tx, secondInput));
      await waitForLockWaiter(t.db.$client, 'second risk intake waits on the market lock');
    } finally {
      release();
      // Drain both operations even if the bounded waiter assertion fails; do not leave a
      // transaction running into the next reset or the harness shutdown.
      await Promise.allSettled(second ? [first, second] : [first]);
    }
    if (!second) throw new Error('second intake did not start');
    return Promise.all([first, second]);
  }

  it('refuses a new bot reservation over L without an order, asset write or book event', async () => {
    const m = await riskMarket();
    const before = await written();
    const result = await placeTestOrder(t.db, {
      ownerId: m.mm,
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 40,
      qty: 3,
    });
    expect(result).toEqual({ kind: 'bot_risk_rejected', reason: 'loss_limit' });
    expect(placeOrderChangedBook(result)).toBe(false);
    expect(await written()).toEqual(before);
    await conserved(m);
  });

  it('keeps asset refusals as rejected rows rather than reporting them as risk refusals', async () => {
    const m = await riskMarket();
    const before = await funds(m);
    const buy = await placed({
      ownerId: m.mm,
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 40,
      qty: 30,
    });
    expect(buy.order).toMatchObject({ status: 'rejected', rejectReason: 'insufficient_coin' });
    const sell = await placed({
      ownerId: m.mm,
      marketId: m.id,
      side: 'sell',
      limitPriceCoin: 60,
      qty: 1,
    });
    expect(sell.order).toMatchObject({
      status: 'rejected',
      rejectReason: 'insufficient_contracts',
    });
    expect(await funds(m)).toEqual(before);
    expect(buy.fills).toEqual([]);
    expect(sell.fills).toEqual([]);
    await conserved(m);
  });

  it('reevaluates an unrecorded risk refusal with the same key after another reservation ends', async () => {
    const m = await riskMarket();
    const old = await placed({
      ownerId: m.mm,
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 40,
      qty: 2,
    });
    const retry = input(m.mm, m.id, {
      outcome: 'NO',
      timeInForce: 'gtc',
      limitPriceCoin: 10,
      qty: 3,
    });
    const before = await written();
    expect(await placeTestOrder(t.db, retry)).toEqual({
      kind: 'bot_risk_rejected',
      reason: 'loss_limit',
    });
    expect(await written()).toEqual(before);
    await cancelTestOrder(t.db, { ownerId: m.mm, orderId: old.order.id });
    const accepted = await placed(retry);
    expect(accepted.order).toMatchObject({ status: 'open', idempotencyKey: retry.requestId });
    expect(await funds(m)).toMatchObject({ availableCoin: 970n, lockedCoin: 30n });
    const after = await written();
    expect(await placeTestOrder(t.db, retry)).toMatchObject({
      kind: 'replayed',
      order: { id: accepted.order.id },
    });
    expect(await written()).toEqual(after);
    await conserved(m);
  });

  it('replays or conflicts before intake, market and risk gates; a fresh request still meets them', async () => {
    const m = await riskMarket();
    const original = input(m.mm, m.id, {
      outcome: 'NO',
      timeInForce: 'gtc',
      limitPriceCoin: 40,
      qty: 2,
    });
    const accepted = await placed(original);
    await legacyBid(m, 40, 10);
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, m.id);
      await tx.update(markets).set({ status: 'paused' }).where(eq(markets.id, m.id));
    });
    await setReleaseSetting(t.db, {
      adminId,
      key: ORDER_ACCEPTING_SETTING.key,
      status: 'test',
      value: false,
    });
    const before = await written();
    expect(await placeTestOrder(t.db, original)).toMatchObject({
      kind: 'replayed',
      order: { id: accepted.order.id },
    });
    expect(await placeTestOrder(t.db, { ...original, qty: 1 })).toEqual({ kind: 'conflict' });
    expect(await placeTestOrder(t.db, { ...original, requestId: randomUUID() })).toEqual({
      kind: 'closed',
      why: 'intake',
    });
    expect(await written()).toEqual(before);
    await openOrderIntake(t.db, { adminId });
    const paused = await placed({ ...original, requestId: randomUUID() });
    expect(paused.order).toMatchObject({ status: 'rejected', rejectReason: 'paused' });
    expect(placeOrderChangedBook(paused)).toBe(false);
    await conserved(m);
  });

  it('caps a bot fill, cancels only its unsafe remainder, then fills the next human and bot quotes', async () => {
    const m = await riskMarket(140n);
    const first = await legacyBid(m, 40, 10);
    const last = await legacyBid(m, 20, 2);
    const human = await placed({
      ownerId: await member(),
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 30,
      qty: 1,
    });
    const buyer = await member();
    const beforeSupply = await ledgerSupply(t.db);
    const done = await placed(input(buyer, m.id, { qty: 5 }));
    expect(done.fills.map((fill) => [fill.restingOrderId, fill.qty, fill.priceCoin])).toEqual([
      [first.id, 2, 60],
      [human.order.id, 1, 70],
      [last.id, 2, 80],
    ]);
    expect(done.cancelledBotOrderIds).toEqual([first.id]);
    expect(done.order).toMatchObject({ status: 'filled', filledQty: 5, filledAmountCoin: 350n });
    expect(await row(first.id)).toMatchObject({ status: 'cancelled', filledQty: 2, qty: 10 });
    expect(await row(human.order.id)).toMatchObject({ status: 'filled', filledQty: 1 });
    expect(await row(last.id)).toMatchObject({ status: 'filled', filledQty: 2 });
    expect(await funds(m)).toMatchObject({ availableCoin: 880n, lockedCoin: 0n, ledgerCoin: 880n });
    expect(await positionOf(t.db, m.mm, m.id, 'NO')).toMatchObject({ qty: 4, lockedQty: 0 });
    expect(await ledgerSupply(t.db)).toEqual(beforeSupply);
    expect(placeOrderChangedBook(done)).toBe(true);
    await conserved(m);
  });

  it('checks the full resting allowance even when the incoming order asks for only one contract', async () => {
    const m = await riskMarket();
    const unsafe = await legacyBid(m, 40, 10);
    const done = await placed(input(await member(), m.id));
    expect(done.order).toMatchObject({ status: 'filled', filledQty: 1 });
    expect(done.cancelledBotOrderIds).toEqual([unsafe.id]);
    expect(await row(unsafe.id)).toMatchObject({ status: 'cancelled', qty: 10, filledQty: 1 });
    expect(await funds(m)).toMatchObject({ availableCoin: 960n, lockedCoin: 0n });
    expect(await positionOf(t.db, m.mm, m.id, 'NO')).toMatchObject({ qty: 1 });
    await conserved(m);
  });

  it('retains an ordinary partially filled bot remainder when its full reservation is safe', async () => {
    const m = await riskMarket();
    const safe = await placed({
      ownerId: m.mm,
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 40,
      qty: 2,
    });
    const done = await placed(input(await member(), m.id));
    expect(done.cancelledBotOrderIds).toEqual([]);
    expect(await row(safe.order.id)).toMatchObject({ status: 'partially_filled', filledQty: 1 });
    expect(await funds(m)).toMatchObject({ availableCoin: 920n, lockedCoin: 40n });
    await conserved(m);
  });

  it('advances after a zero-risk allowance and fills a later bot order on the updated reservation', async () => {
    const m = await riskMarket();
    const zero = await legacyBid(m, 50, 10);
    const next = await legacyBid(m, 40, 10);
    const done = await placed(input(await member(), m.id, { qty: 2, limitPriceCoin: 60 }));
    expect(done.fills.map((fill) => [fill.restingOrderId, fill.qty, fill.priceCoin])).toEqual([
      [next.id, 2, 60],
    ]);
    expect(done.cancelledBotOrderIds).toEqual([zero.id, next.id]);
    expect(await row(zero.id)).toMatchObject({ status: 'cancelled', filledQty: 0 });
    expect(await row(next.id)).toMatchObject({ status: 'cancelled', filledQty: 2 });
    expect(await funds(m)).toMatchObject({ availableCoin: 920n, lockedCoin: 0n });
    await conserved(m);
  });

  it('reports a zero-fill cancellation as a book change with no trade, tick or ledger movement', async () => {
    const m = await riskMarket();
    const zero = await legacyBid(m, 50, 10);
    const beyond = await legacyBid(m, 40, 10);
    const buyer = await member();
    const before = await written();
    const stats = await marketStats(m.id);
    const done = await placed(input(buyer, m.id, { limitPriceCoin: 50 }));
    expect(done.order).toMatchObject({
      status: 'rejected',
      rejectReason: 'price_limit',
      filledQty: 0,
    });
    expect(done.cancelledBotOrderIds).toEqual([zero.id]);
    expect(placeOrderChangedBook(done)).toBe(true);
    expect(done.fills).toEqual([]);
    expect(done.stats).toBeNull();
    expect(done.touched).toEqual({ balances: [], positions: [] });
    expect(await marketStats(m.id)).toEqual(stats);
    expect(await row(beyond.id)).toEqual(before.orders.find((order) => order.id === beyond.id));
    expect(await funds(m)).toMatchObject({ availableCoin: 600n, lockedCoin: 400n });
    const after = await written();
    expect(after.entries).toEqual(before.entries);
    expect(after.fills).toEqual(before.fills);
    expect(after.positions).toEqual(before.positions);
    const replay = await placeTestOrder(t.db, {
      ...input(buyer, m.id, { limitPriceCoin: 50 }),
      requestId: done.order.idempotencyKey,
    });
    expect(replay.kind).toBe('replayed');
    expect(placeOrderChangedBook(replay)).toBe(false);
    expect(await written()).toEqual(after);
    await conserved(m);
  });

  it.each(['price_limit', 'budget_too_small'] as const)(
    'does not persist reference-probe cancellations when the actual walk stops at %s',
    async (reason) => {
      const m = await riskMarket();
      await legacyBid(m, 50, 10);
      await legacyBid(m, 40, 10);
      const buyer = await member();
      const beforeBook = await readLiveBook(t.db, m.id);
      const beforeFunds = await funds(m);
      const done = await placed(
        input(
          buyer,
          m.id,
          reason === 'price_limit' ? { limitPriceCoin: 40 } : { qty: null, budgetCoin: 49n },
        ),
      );
      expect(done.order).toMatchObject({ status: 'rejected', rejectReason: reason });
      expect(done.cancelledBotOrderIds).toEqual([]);
      expect(placeOrderChangedBook(done)).toBe(false);
      expect(done.fills).toEqual([]);
      expect(await readLiveBook(t.db, m.id)).toEqual(beforeBook);
      expect(await funds(m)).toEqual(beforeFunds);
      await conserved(m);
    },
  );

  it('does not cancel a later unsafe bot quote after the incoming person meets their own order', async () => {
    const m = await riskMarket();
    const buyer = await member();
    await placed({ ownerId: buyer, marketId: m.id, outcome: 'NO', limitPriceCoin: 50 });
    await legacyBid(m, 40, 10);
    const beforeBook = await readLiveBook(t.db, m.id);
    const done = await placed(input(buyer, m.id));
    expect(done.order).toMatchObject({ status: 'rejected', rejectReason: 'self_trade' });
    expect(done.cancelledBotOrderIds).toEqual([]);
    expect(await readLiveBook(t.db, m.id)).toEqual(beforeBook);
    expect(placeOrderChangedBook(done)).toBe(false);
    await conserved(m);
  });

  it('serializes two bot admissions so only one can reserve the remaining loss room', async () => {
    const m = await riskMarket();
    const terms = { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 40, qty: 2 } as const;
    const [first, second] = await race(input(m.mm, m.id, terms), input(m.mm, m.id, terms));
    expect(placedResult(first).order.status).toBe('open');
    expect(second).toEqual({ kind: 'bot_risk_rejected', reason: 'loss_limit' });
    expect(await t.db.select().from(orders)).toHaveLength(1);
    expect(await funds(m)).toMatchObject({ availableCoin: 920n, lockedCoin: 80n });
    await conserved(m);
  });

  it('makes a second taker reread the first committed fill instead of spending the same reservation twice', async () => {
    const m = await riskMarket();
    const resting = await placed({
      ownerId: m.mm,
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 40,
      qty: 2,
    });
    const a = await member();
    const b = await member();
    const [first, second] = await race(input(a, m.id), input(b, m.id, { qty: 2 }));
    expect(placedResult(first).order).toMatchObject({ status: 'filled', filledQty: 1 });
    expect(placedResult(second).order).toMatchObject({ status: 'cancelled', filledQty: 1 });
    expect(await row(resting.order.id)).toMatchObject({ status: 'filled', filledQty: 2 });
    expect(await positionOf(t.db, m.mm, m.id, 'NO')).toMatchObject({ qty: 2 });
    expect(await funds(m)).toMatchObject({ availableCoin: 920n, lockedCoin: 0n });
    await conserved(m);
  });

  it('rolls back fills, risk cancellations and releases together when the caller fails', async () => {
    const m = await riskMarket();
    const zero = await legacyBid(m, 50, 10);
    const capped = await legacyBid(m, 40, 10);
    const buyer = await member();
    const request = input(buyer, m.id, { qty: 2 });
    const before = await written();
    await expect(
      t.db.transaction(async (tx) => {
        const done = placedResult(await placeOrder(tx, request));
        expect(done.fills).toHaveLength(1);
        expect(done.cancelledBotOrderIds).toEqual([zero.id, capped.id]);
        throw new Error('caller failed after all intake writes');
      }),
    ).rejects.toThrow('caller failed after all intake writes');
    expect(await written()).toEqual(before);
    const retry = await placed(request);
    expect(retry.order).toMatchObject({ status: 'filled', filledQty: 2 });
    expect(retry.cancelledBotOrderIds).toEqual([zero.id, capped.id]);
    await conserved(m);
  });

  it('rolls back the first fill and pending risk releases when a later actual fill throws', async () => {
    const m = await riskMarket();
    await legacyBid(m, 40, 10);
    await placed({
      ownerId: await member(),
      marketId: m.id,
      outcome: 'NO',
      limitPriceCoin: 30,
      qty: 1,
    });
    const buyer = await member();
    const request = input(buyer, m.id, { qty: 3 });
    const before = await written();
    const realFill = contracts.applyPairMintFill;
    let calls = 0;
    const failure = vi
      .spyOn(contracts, 'applyPairMintFill')
      .mockImplementation(async (tx, args) => {
        calls += 1;
        if (calls === 2) throw new Error('second pair mint failed');
        return realFill(tx, args);
      });
    try {
      await expect(placeTestOrder(t.db, request)).rejects.toThrow('second pair mint failed');
      expect(calls).toBe(2);
      expect(await written()).toEqual(before);
    } finally {
      failure.mockRestore();
    }
    const retry = await placed(request);
    expect(retry.order).toMatchObject({ status: 'filled', filledQty: 3 });
    expect(retry.fills).toHaveLength(2);
    await conserved(m);
  });
});
