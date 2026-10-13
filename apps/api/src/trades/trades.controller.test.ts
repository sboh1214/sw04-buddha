/**
 * The caller's positions and orders (PLAN 7.2; M3 design 3.5) against the docker `test`
 * profile. Skips when TEST_* are unset (fails under CI=true, see the harness).
 *
 * No route places an order until the CLOB (#119) — the direct AMM `POST /trades` is gone
 * (#125) — so every row is written straight to its table, with the instants spelled out: the
 * routes sort by them, and back-to-back inserts may share a millisecond.
 */
import { schema } from '@buddha/db';
import { createMarket, createUser } from '@buddha/db/test';
import { type Order, type OrderSide, type Outcome, type Position } from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

type MarketRow = typeof schema.markets.$inferSelect;

describe.skipIf(!hasTestInfra)('positions and orders (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** Open, never traded: no price (N02 §5). */
  let market: MarketRow;
  /** One instant per test the rows below are stamped relative to. */
  let base: number;
  const at = (seconds: number) => new Date(base + seconds * 1_000);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
    market = await createMarket(t.db);
    base = Date.now() - 60_000;
  });

  async function insertPosition(input: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    qty: number;
    costBasisP?: bigint;
    realizedPnlP?: bigint;
    settled?: boolean;
    updatedAt: Date;
  }) {
    await t.db.insert(schema.positions).values({
      costBasisP: 0n,
      realizedPnlP: 0n,
      settled: false,
      ...input,
    });
  }

  /**
   * A resting limit order of a separate account: what every fill below matched
   * (`fills_counterparty_check` wants the resting order named).
   */
  async function insertMakerOrder(marketId: string) {
    const maker = await createUser(t.db);
    const [row] = await t.db
      .insert(schema.orders)
      .values({
        userId: maker.user.id,
        marketId,
        outcome: 'YES',
        side: 'sell',
        type: 'limit',
        limitPrice: 50,
        qty: 1_000,
        status: 'open',
        timeInForce: 'gtc',
        idempotencyKey: randomUUID(),
        createdAt: at(0),
        updatedAt: at(0),
      })
      .returning();
    return row!;
  }

  /** One of the caller's orders, filled at once when `fill` is given, else left resting. */
  async function insertOrder(input: {
    userId: string;
    marketId: string;
    side: OrderSide;
    qty: number;
    createdAt: Date;
    fill?: { amountP: bigint; priceAvgBp: number; counterpartyOrderId: string };
  }) {
    const { fill } = input;
    const [order] = await t.db
      .insert(schema.orders)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        outcome: 'YES',
        side: input.side,
        type: fill ? 'market' : 'limit',
        limitPrice: fill ? null : 40,
        qty: input.qty,
        filledQty: fill ? input.qty : 0,
        status: fill ? 'filled' : 'open',
        timeInForce: fill ? 'ioc' : 'gtc',
        idempotencyKey: randomUUID(),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning();
    if (fill) {
      await t.db.insert(schema.fills).values({
        marketId: input.marketId,
        orderId: order!.id,
        counterpartyType: 'order',
        counterpartyOrderId: fill.counterpartyOrderId,
        outcome: 'YES',
        side: input.side,
        qty: input.qty,
        amountP: fill.amountP,
        priceAvgBp: fill.priceAvgBp,
        createdAt: input.createdAt,
      });
    }
    return order!;
  }

  it('GET /me/positions filters by status, newest change first, with the market price', async () => {
    const traded = await createMarket(t.db, { lastPrice: 62, tradeCount: 3 });
    const settledMarket = await createMarket(t.db, {
      status: 'settled',
      lastPrice: 80,
      resolvedResult: 'YES',
    });
    // A row outlives its contracts: qty 0 after a full sell, realised PnL kept.
    await insertPosition({
      userId: user.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      realizedPnlP: -40n,
      updatedAt: at(1),
    });
    await insertPosition({
      userId: user.id,
      marketId: traded.id,
      outcome: 'NO',
      qty: 5,
      costBasisP: 190n,
      updatedAt: at(2),
    });
    await insertPosition({
      userId: user.id,
      marketId: settledMarket.id,
      outcome: 'YES',
      qty: 0,
      realizedPnlP: 700n,
      settled: true,
      updatedAt: at(3),
    });
    // Somebody else's row never shows.
    const stranger = await signUpTestUser(t);
    await insertPosition({
      userId: stranger.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 3,
      updatedAt: at(4),
    });

    const list = async (query = '') => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/positions${query}`,
        headers: { cookie: user.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: Position[] }>().data;
    };

    const open = await list('?status=open');
    expect(open.map((row) => [row.marketId, row.outcome, row.qty])).toEqual([
      [traded.id, 'NO', 5],
      [market.id, 'YES', 0],
    ]);
    expect(open[0]).toMatchObject({ marketLastPrice: 62, costBasisP: '190', settled: false });
    // Never traded: no price to mark the row to, not a made-up one.
    expect(open[1]).toMatchObject({
      marketSlug: market.slug,
      marketTitle: market.title,
      marketStatus: 'open',
      marketLastPrice: null,
      resolvedResult: null,
      costBasisP: '0',
      realizedPnlP: '-40',
      settled: false,
    });

    const settled = await list('?status=settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      marketId: settledMarket.id,
      marketStatus: 'settled',
      marketLastPrice: 80,
      resolvedResult: 'YES',
      qty: 0,
      realizedPnlP: '700',
      settled: true,
    });

    const all = await list();
    expect(all.map((row) => row.marketId)).toEqual([settledMarket.id, traded.id, market.id]);

    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=closed',
      headers: { cookie: user.cookie },
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/positions' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('GET /me/orders pages newest first with the fill joined in', async () => {
    const second = await createMarket(t.db);
    const maker = await insertMakerOrder(market.id);
    const makerElsewhere = await insertMakerOrder(second.id);
    const resting = await insertOrder({
      userId: user.id,
      marketId: market.id,
      side: 'buy',
      qty: 3,
      createdAt: at(1),
    });
    const firstBuy = await insertOrder({
      userId: user.id,
      marketId: market.id,
      side: 'buy',
      qty: 10,
      createdAt: at(2),
      fill: { amountP: 500n, priceAvgBp: 5_000, counterpartyOrderId: maker.id },
    });
    await insertOrder({
      userId: user.id,
      marketId: second.id,
      side: 'buy',
      qty: 20,
      createdAt: at(3),
      fill: { amountP: 1_200n, priceAvgBp: 6_000, counterpartyOrderId: makerElsewhere.id },
    });
    await insertOrder({
      userId: user.id,
      marketId: market.id,
      side: 'sell',
      qty: 4,
      createdAt: at(4),
      fill: { amountP: 180n, priceAvgBp: 4_500, counterpartyOrderId: maker.id },
    });
    // Somebody else's order never shows.
    const other = await signUpTestUser(t);
    await insertOrder({
      userId: other.id,
      marketId: market.id,
      side: 'buy',
      qty: 7,
      createdAt: at(5),
      fill: { amountP: 350n, priceAvgBp: 5_000, counterpartyOrderId: maker.id },
    });

    const fetchPage = async (query: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/orders${query}`,
        headers: { cookie: user.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: Order[]; meta: { nextCursor: string | null } }>();
    };

    const first = await fetchPage('?limit=2');
    expect(first.data.map((order) => [order.marketId, order.side, order.qty])).toEqual([
      [market.id, 'sell', 4],
      [second.id, 'buy', 20],
    ]);
    expect(first.meta.nextCursor).toBeTypeOf('string');
    const [sellOrder, buyOrder] = first.data;
    expect(sellOrder).toMatchObject({
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      outcome: 'YES',
      side: 'sell',
      type: 'market',
      qty: 4,
      filledQty: 4,
      status: 'filled',
      amountP: '180',
      priceAvgBp: 4_500,
      createdAt: at(4).toISOString(),
    });
    // Nothing else: the direct AMM's slippage bounds (`maxCostP`, `minProceedsP`) are gone.
    expect(Object.keys(sellOrder!).sort()).toEqual(
      [
        'amountP',
        'createdAt',
        'filledQty',
        'id',
        'marketId',
        'marketSlug',
        'marketTitle',
        'outcome',
        'priceAvgBp',
        'qty',
        'side',
        'status',
        'type',
      ].sort(),
    );
    expect(buyOrder).toMatchObject({ marketSlug: second.slug, amountP: '1200', priceAvgBp: 6_000 });

    const rest = await fetchPage(`?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(rest.data.map((order) => order.id)).toEqual([firstBuy.id, resting.id]);
    // Nothing filled yet: no fill to join, so no amount and no price.
    expect(rest.data[1]).toMatchObject({
      type: 'limit',
      filledQty: 0,
      status: 'open',
      amountP: null,
      priceAvgBp: null,
    });
    expect(rest.meta.nextCursor).toBeNull();

    // A malformed cursor serves the first page rather than a 500 (uuid-shaped id half).
    const malformed = await fetchPage('?cursor=0_not-a-uuid');
    expect(malformed.data).toHaveLength(4);

    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/orders' });
    expect(anonymous.statusCode).toBe(401);
  });
});
