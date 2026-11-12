/**
 * #128 through the member HTTP intake: a risk cancellation changes the book even without a
 * fill; every market/user event follows COMMIT; no internal bot/configuration detail is public.
 * Uses inject() without a listening port. Public depth and quotes use the same sequential risk.
 */
import { randomUUID } from 'node:crypto';
import {
  clockTimestamp,
  lockForOrder,
  lockMarket,
  schema,
  setMarketLiquidity,
  type Db,
} from '@buddha/db';
import {
  checkMarketStats,
  checkOrderInvariants,
  completeOnboarding,
  createMarket,
  createOrder,
  createStartGrant,
  createUser,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  openOrderIntake,
} from '@buddha/db/test';
import {
  fillSchema,
  marketSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  orderBookSchema,
  orderQuoteSchema,
  placeOrderResultSchema,
  type OrderBook,
  type OrderQuote,
  type Fill,
  type Market,
  type MarketRealtimeEvent,
  type PlaceOrderResult,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { OrderService } from './order.service.js';

const ORIGIN = 'http://localhost:3000';
const START_COIN = 1_000n;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Response = { statusCode: number; body: string };

describe.skipIf(!hasTestInfra)('order risk publication and privacy (integration, #128)', () => {
  let t: TestApp;
  let adminId: string;
  let buyer: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    buyer = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: buyer.id });
    await createStartGrant(t.db, { userId: buyer.id, amountCoin: START_COIN });
    await openOrderIntake(t.db, { adminId });
  });

  /** Explicit initial test configuration, never a release default or an after-open edit. */
  async function riskMarket() {
    const reason = `PRIVATE_RISK_CONFIG_${randomUUID()}`;
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
        reason,
        settings: {
          budgetCoin: 1_000n,
          maxLossCoin: 100n,
          b: 100,
          levels: 3,
          quantity: 10,
          safetyTicks: 1,
        },
      });
      // Pin the same immutable configuration pointer that #72's scheduled opener pins. This
      // fixture is about intake; review/approval permissions have their own integration tests.
      await tx
        .update(schema.markets)
        .set({ status: 'scheduled' })
        .where(eq(schema.markets.id, draft.id));
      await tx
        .update(schema.markets)
        .set({
          status: 'open',
          openAt: await clockTimestamp(tx),
          openedLiquidityVersion: config.version,
        })
        .where(eq(schema.markets.id, draft.id));
    });
    const mm = await fundMarketMakerFunds(t.db, draft.id, 1_000n);
    return { id: draft.id, mm, reason };
  }
  type RiskMarket = Awaited<ReturnType<typeof riskMarket>>;

  /** Asset-backed reservations predating the risk gate: bypass admission, never asset locks. */
  async function legacyBid(market: RiskMarket, price: number) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const locked = await lockForOrder(tx, {
        marketId: market.id,
        ownerId: market.mm,
        lock: { kind: 'coin', amountCoin: BigInt(price) * 10n },
      });
      if (!locked.locked) throw new Error(`legacy bid lock refused: ${locked.reason}`);
      return createOrder(tx as unknown as Db, {
        marketId: market.id,
        userId: market.mm,
        outcome: 'NO',
        side: 'buy',
        limitPriceCoin: price,
        qty: 10,
      });
    });
  }

  async function overreserved() {
    const market = await riskMarket();
    const zero = await legacyBid(market, 50);
    const capped = await legacyBid(market, 40);
    return { market, zero, capped };
  }

  const send = (marketId: string, limitPriceCoin: number, qty: number, requestId = randomUUID()) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/orders`,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: buyer.cookie,
        'idempotency-key': requestId,
      },
      payload: JSON.stringify({
        expectedAccountId: buyer.id,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin,
        qty,
      }),
    });
  const read = (path: string) => t.app.inject({ method: 'GET', url: `/api/v1${path}` });
  const dataOf = <T>(response: Response): T => {
    expect(response.statusCode, response.body).toBe(200);
    return (JSON.parse(response.body) as { data: T }).data;
  };
  const placed = (response: Response) => {
    const raw = dataOf<PlaceOrderResult>(response);
    // Compare the actual wire object too: parsing alone would strip unexpected private keys.
    expect(raw).toEqual(placeOrderResultSchema.parse(raw));
    return raw;
  };
  const orderRow = async (id: string) =>
    (await t.db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]!;
  const funds = (marketId: string) =>
    ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId });

  const preview = (
    marketId: string,
    terms: { limitPriceCoin?: number; qty?: number; budgetCoin?: string },
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/quote`,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ outcome: 'YES', side: 'buy', timeInForce: 'ioc', ...terms }),
    });

  /** Durable state only; a rolled-back sequence allocation is intentionally not an asset. */
  const written = async () => ({
    orders: await t.db.select().from(schema.orders).orderBy(schema.orders.arrivalSeq),
    fills: await t.db.select().from(schema.fills).orderBy(schema.fills.id),
    entries: await t.db.select().from(schema.ledgerEntries).orderBy(schema.ledgerEntries.id),
    accounts: await t.db.select().from(schema.ledgerAccounts).orderBy(schema.ledgerAccounts.id),
    balances: await t.db.select().from(schema.balances).orderBy(schema.balances.accountId),
    positions: await t.db
      .select()
      .from(schema.positions)
      .orderBy(schema.positions.marketId, schema.positions.userId, schema.positions.outcome),
    markets: await t.db.select().from(schema.markets).orderBy(schema.markets.id),
  });

  function observePublication() {
    const events: MarketRealtimeEvent[] = [];
    const observed: Awaited<ReturnType<typeof written>>[] = [];
    const publisher = t.app.get(MarketPublisher);
    const toMarket = vi.spyOn(publisher, 'publishMarket').mockImplementation(async (_id, event) => {
      events.push(event);
      // This uses the app's pool, not the intake's transaction. An early publication would
      // observe the old committed orders/assets even if the HTTP request eventually committed.
      observed.push(await written());
    });
    const toUser = vi.spyOn(publisher, 'publishUser').mockResolvedValue(undefined);
    return { events, observed, toMarket, toUser };
  }

  /** The public wire shape excludes every internal order/configuration/risk identifier. */
  async function assertPrivacy(
    market: RiskMarket,
    botOrderIds: readonly string[],
    response: Response,
    events: readonly MarketRealtimeEvent[],
  ) {
    const detail = dataOf<Market>(await read(`/markets/${market.id}`));
    const book = dataOf<unknown>(await read(`/markets/${market.id}/book`));
    const fills = dataOf<Fill[]>(await read(`/markets/${market.id}/fills`));
    expect(detail).toEqual(marketSchema.parse(detail));
    expect(book).toEqual(orderBookSchema.parse(book));
    expect(fills).toEqual(fills.map((fill) => fillSchema.parse(fill)));
    const wire = JSON.stringify([JSON.parse(response.body), detail, book, fills, events]);
    for (const privateValue of [market.mm, adminId, buyer.id, market.reason, ...botOrderIds]) {
      expect(wire).not.toContain(privateValue);
    }
    for (const internal of [
      'market_maker',
      'bot_risk_rejected',
      'loss_limit',
      'botCancellations',
      'cancelledBotOrderIds',
      'projectedBook',
      'accountType',
      'ownerId',
      'isBot',
      'botRisk',
      'liquidityVersion',
      'currentLiquidityVersion',
      'openedLiquidityVersion',
      'liquiditySettings',
      'maxLossCoin',
      'referencePriceCoin',
      'protectionTicks',
      'safetyTicks',
      'invested',
      'recovered',
    ]) {
      expect(wire).not.toContain(internal);
    }
    return { detail, fills };
  }

  it('reads executable depth and anonymous quotes without changing any durable row or publishing', async () => {
    const { market, zero, capped } = await overreserved();
    const before = await written();
    const sent = observePublication();
    const depth = dataOf<OrderBook>(await read(`/markets/${market.id}/book`));
    expect(depth).toEqual(orderBookSchema.parse(depth));
    expect(depth.contracts).toEqual([
      {
        outcome: 'YES',
        asks: [{ priceCoin: 60, qty: 2 }],
        bids: [],
        bestAskCoin: 60,
        bestBidCoin: null,
      },
      {
        outcome: 'NO',
        asks: [],
        bids: [{ priceCoin: 40, qty: 2 }],
        bestAskCoin: null,
        bestBidCoin: 40,
      },
    ]);
    const response = await preview(market.id, { limitPriceCoin: 60, qty: 3 });
    const quote = dataOf<OrderQuote>(response);
    expect(quote).toEqual(orderQuoteSchema.parse(quote));
    expect(quote).toMatchObject({
      filledQty: 2,
      filledAmountCoin: '120',
      protectedLimitPriceCoin: 60,
    });
    await assertPrivacy(market, [zero.id, capped.id], response, sent.events);
    expect(await written()).toEqual(before);
    expect(sent.toMarket).not.toHaveBeenCalled();
    expect(sent.toUser).not.toHaveBeenCalled();
    const result = placed(await send(market.id, quote.protectedLimitPriceCoin, 3));
    expect(result.order).toMatchObject({
      filledQty: quote.filledQty,
      filledAmountCoin: quote.filledAmountCoin,
      status: quote.status,
      cancelReason: quote.cancelReason,
    });
  });

  it.each([40, 50, 60])('matches public quantity quote and intake at limit %s', async (limit) => {
    const { market } = await overreserved();
    const before = await written();
    const quote = dataOf<OrderQuote>(await preview(market.id, { limitPriceCoin: limit, qty: 3 }));
    expect(await written()).toEqual(before);
    const result = placed(await send(market.id, limit, 3));
    expect(result.order).toMatchObject({
      filledQty: quote.filledQty,
      filledAmountCoin: quote.filledAmountCoin,
      status: quote.status,
      rejectReason: quote.rejectReason,
      cancelReason: quote.cancelReason,
    });
  });

  it.each(['59', '119', '121'])(
    'matches public budget quote and intake for %s Coin',
    async (budgetCoin) => {
      const { market } = await overreserved();
      const before = await written();
      const quote = dataOf<OrderQuote>(await preview(market.id, { budgetCoin }));
      expect(await written()).toEqual(before);
      const result = placed(
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/markets/${market.id}/orders`,
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            cookie: buyer.cookie,
            'idempotency-key': randomUUID(),
          },
          payload: JSON.stringify({
            expectedAccountId: buyer.id,
            outcome: 'YES',
            side: 'buy',
            timeInForce: 'ioc',
            budgetCoin,
            limitPriceCoin: quote.protectedLimitPriceCoin,
          }),
        }),
      );
      expect(result.order).toMatchObject({
        filledQty: quote.filledQty,
        filledAmountCoin: quote.filledAmountCoin,
        unspentCoin: quote.unspentCoin,
        status: quote.status,
        rejectReason: quote.rejectReason,
        cancelReason: quote.cancelReason,
      });
    },
  );

  it('publishes exactly one book signal after a zero-fill cancellation commits, and none on replay', async () => {
    const { market, zero, capped } = await overreserved();
    const before = await written();
    const sent = observePublication();
    const requestId = randomUUID();
    const response = await send(market.id, 50, 1, requestId);
    const result = placed(response);
    expect(result).toMatchObject({
      replayed: false,
      order: { status: 'rejected', rejectReason: 'price_limit', filledQty: 0 },
    });
    expect(await orderRow(zero.id)).toMatchObject({ status: 'cancelled', filledQty: 0 });
    expect(await orderRow(capped.id)).toEqual(capped);
    expect(await funds(market.id)).toMatchObject({
      availableCoin: 600n,
      lockedCoin: 400n,
      ledgerCoin: 1_000n,
    });
    const committed = await written();
    expect(committed.entries).toEqual(before.entries);
    expect(committed.fills).toEqual(before.fills);
    expect(committed.positions).toEqual(before.positions);
    expect(committed.markets).toEqual(before.markets);
    expect(sent.events).toEqual([
      { type: 'market:book', marketId: market.id, ts: result.order.createdAt },
    ]);
    expect(sent.toMarket).toHaveBeenCalledTimes(1);
    expect(sent.toMarket.mock.calls[0]![0]).toBe(market.id);
    expect(sent.observed).toEqual([committed]);
    expect(sent.toUser).not.toHaveBeenCalled();
    await assertPrivacy(market, [zero.id, capped.id], response, sent.events);

    expect(placed(await send(market.id, 50, 1, requestId))).toEqual({
      order: result.order,
      replayed: true,
    });
    expect(sent.toMarket).toHaveBeenCalledTimes(1);
    expect(sent.toUser).not.toHaveBeenCalled();
    expect(await written()).toEqual(committed);
    expect(await checkOrderInvariants(t.db)).toEqual([]);
    expect(await checkMarketStats(t.db)).toEqual([]);
  });

  it('publishes one tick, book and anonymous trade after a capped fill and its cancellations commit', async () => {
    const { market, zero, capped } = await overreserved();
    const sent = observePublication();
    const requestId = randomUUID();
    const response = await send(market.id, 60, 3, requestId);
    const result = placed(response);
    expect(result).toMatchObject({
      replayed: false,
      order: {
        status: 'cancelled',
        cancelReason: 'ioc_remainder',
        filledQty: 2,
        filledAmountCoin: '120',
        cancelledQty: 1,
      },
    });
    expect(await orderRow(zero.id)).toMatchObject({ status: 'cancelled', filledQty: 0 });
    expect(await orderRow(capped.id)).toMatchObject({ status: 'cancelled', filledQty: 2, qty: 10 });
    expect(await funds(market.id)).toMatchObject({
      availableCoin: 920n,
      lockedCoin: 0n,
      ledgerCoin: 920n,
    });
    expect(sent.events.map((event) => event.type)).toEqual([
      'market:tick',
      'market:book',
      'market:trade',
    ]);
    expect(sent.toMarket.mock.calls.map(([marketId]) => marketId)).toEqual([
      market.id,
      market.id,
      market.id,
    ]);
    const committed = await written();
    expect(sent.observed).toEqual([committed, committed, committed]);
    const tick = marketTickEventSchema.parse(sent.events[0]);
    expect(sent.events[0]).toEqual(tick);
    expect(tick).toMatchObject({
      marketId: market.id,
      lastPrice: 60,
      volumeCoin: '120',
      tradeCount: 1,
      traderCount: 1,
    });
    const trade = marketTradeEventSchema.parse(sent.events[2]);
    expect(sent.events[2]).toEqual(trade);
    expect(trade).toMatchObject({
      marketId: market.id,
      outcome: 'YES',
      priceCoin: 60,
      yesPriceCoin: 60,
      qty: 2,
      amountCoin: '120',
    });
    expect(sent.toUser.mock.calls.map(([userId, event]) => [userId, event.type])).toEqual([
      [buyer.id, 'user:balance'],
      [buyer.id, 'user:position'],
    ]);
    const { detail, fills } = await assertPrivacy(
      market,
      [zero.id, capped.id],
      response,
      sent.events,
    );
    expect(detail).toMatchObject({
      lastPrice: 60,
      volumeCoin: '120',
      tradeCount: 1,
      traderCount: 1,
    });
    expect(fills).toEqual([
      {
        id: trade.fillId,
        outcome: 'YES',
        priceCoin: 60,
        yesPriceCoin: 60,
        qty: 2,
        amountCoin: '120',
        createdAt: trade.ts,
      },
    ]);
    expect(placed(await send(market.id, 60, 3, requestId)).replayed).toBe(true);
    expect(sent.toMarket).toHaveBeenCalledTimes(3);
    expect(sent.toUser).toHaveBeenCalledTimes(2);
    expect(await written()).toEqual(committed);
    expect(await checkOrderInvariants(t.db)).toEqual([]);
    expect(await checkMarketStats(t.db)).toEqual([]);
  });

  it.each([
    { label: 'zero-fill cancellation', limit: 50, qty: 1, filledQty: 0 },
    { label: 'capped fill and cancellations', limit: 60, qty: 3, filledQty: 2 },
  ])(
    'publishes nothing and restores every write when $label rolls back',
    async ({ limit, qty, filledQty }) => {
      const { market, zero, capped } = await overreserved();
      const before = await written();
      const sent = observePublication();
      let uncommittedOrders: typeof before.orders = [];
      const answerFailure = vi
        .spyOn(
          OrderService.prototype as unknown as { marketRef: (tx: Tx) => Promise<never> },
          'marketRef',
        )
        .mockImplementationOnce(async (tx) => {
          // This is after the real intake. Observe its writes before deliberately failing the
          // answer, so a 500 from an earlier gate cannot accidentally satisfy the rollback test.
          uncommittedOrders = await tx
            .select()
            .from(schema.orders)
            .orderBy(schema.orders.arrivalSeq);
          throw new Error('risk intake answer failed before commit');
        });
      const requestId = randomUUID();
      expect((await send(market.id, limit, qty, requestId)).statusCode).toBe(500);
      expect(answerFailure).toHaveBeenCalledTimes(1);
      expect(uncommittedOrders.find((order) => order.id === zero.id)).toMatchObject({
        status: 'cancelled',
        filledQty: 0,
      });
      expect(uncommittedOrders.find((order) => order.id === capped.id)).toMatchObject({
        status: filledQty === 0 ? 'open' : 'cancelled',
        filledQty,
      });
      expect(uncommittedOrders.find((order) => order.idempotencyKey === requestId)).toMatchObject({
        userId: buyer.id,
        filledQty,
      });
      expect(await written()).toEqual(before);
      expect(sent.toMarket).not.toHaveBeenCalled();
      expect(sent.toUser).not.toHaveBeenCalled();
      expect(sent.observed).toEqual([]);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
      expect(await checkMarketStats(t.db)).toEqual([]);
    },
  );
});
