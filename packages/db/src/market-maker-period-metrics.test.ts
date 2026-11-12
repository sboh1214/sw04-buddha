import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketMakerPeriodMetricsSchema } from '@buddha/shared';
import { closeDb, createDb } from './client.js';
import { runMarketMakerCycle } from './market-maker-cycle.js';
import { readMarketMakerPeriodMetrics } from './market-maker-period-metrics.js';
import { requestMarketMakerRefresh } from './market-maker-runtime.js';
import { marketMakerSupplyIntervals, marketMakerSupplyStates, markets } from './schema/index.js';
import {
  closeMarketEarly,
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { openOrderIntake, placeTestOrder } from './test/orders.js';
import { clockTimestamp } from './tx-helpers.js';

describe.skipIf(!hasTestDb())('opening-to-observation maker metrics (#182)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    await openOrderIntake(t.db, { adminId: (await createUser(t.db, { role: 'admin' })).user.id });
  });
  const read = (id: string) =>
    t.db.transaction(
      async (tx) => {
        const [market] = await tx.select().from(markets).where(eq(markets.id, id));
        const result = await readMarketMakerPeriodMetrics(tx, market!, await clockTimestamp(tx));
        expect(marketMakerPeriodMetricsSchema.parse(result)).toEqual(result);
        return result;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  const opened = async () =>
    (
      await createOpenedMarket(t.db, {
        liquiditySettings: {
          budgetCoin: 10_000n,
          maxLossCoin: 5_000n,
          b: 100_000,
          levels: 3,
          quantity: 10,
          safetyTicks: 1,
        },
      })
    ).market;
  const cycle = (id: string) => t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId: id }));
  const human = async () => (await createUser(t.db, { balanceCoin: 10_000n })).user.id;

  it('keeps unopened periods unavailable and an empty opened denominator null', async () => {
    const draft = await createMarket(t.db, { status: 'draft' });
    expect(await read(draft.id)).toMatchObject({
      window: { from: null },
      activity: { coverage: 'unavailable', bot: null, humanIoc: null },
      supply: { coverage: 'unavailable', openMs: null, botGapMs: null, combinedGapMs: null },
    });
    const market = await opened();
    expect((await read(market.id)).activity).toEqual({
      basis: 'recorded_orders',
      coverage: 'complete',
      bot: { postedQty: '0', filledQty: '0', fillBp: null },
      humanIoc: { orders: '0', filledOrders: '0', fillBp: null },
    });
  });

  it('counts actual resting bot quantity once, and budget remainder exhaustion as a full IOC', async () => {
    const market = await opened();
    await cycle(market.id);
    const ownerId = await human();
    const first = await placeTestOrder(t.db, {
      ownerId,
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
      qty: 4,
    });
    expect(first.kind === 'placed' && first.order.status).toBe('filled');
    const budget = await placeTestOrder(t.db, {
      ownerId,
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
      qty: null,
      budgetCoin: 53n,
    });
    expect(budget.kind === 'placed' && budget.order.status).toBe('filled');
    expect(budget.kind === 'placed' && budget.order.unspentCoin).toBe(1n);
    expect((await read(market.id)).activity).toEqual({
      basis: 'recorded_orders',
      coverage: 'complete',
      bot: { postedQty: '20', filledQty: '5', fillBp: '2500' },
      humanIoc: { orders: '2', filledOrders: '2', fillBp: '10000' },
    });
  });

  it('counts replacement orders as new posted quantity, without recounting existing orders on refresh', async () => {
    const market = await opened();
    await cycle(market.id);
    await placeTestOrder(t.db, {
      ownerId: await human(),
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
      qty: 10,
    });
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    await cycle(market.id);
    const after = await read(market.id);
    expect(after.activity.bot).toEqual({ postedQty: '40', filledQty: '10', fillBp: '2500' });
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    await cycle(market.id);
    expect((await read(market.id)).activity).toEqual(after.activity);
  });

  it('keeps missing legacy supply unknown and read-only, while recorded activity is explicitly partial', async () => {
    const legacy = await createMarket(t.db);
    // Only this isolated test DB owner removes the observer seed to model a pre-0072 row.
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await owner
        .delete(marketMakerSupplyStates)
        .where(eq(marketMakerSupplyStates.marketId, legacy.id));
    } finally {
      await closeDb(owner);
    }
    const result = await read(legacy.id);
    expect(result.activity.coverage).toBe('partial');
    expect(result.supply).toEqual({
      basis: 'posted_book',
      coverage: 'unavailable',
      observedFrom: null,
      observedTo: null,
      openMs: null,
      botGapMs: null,
      combinedGapMs: null,
    });
    expect(await t.db.select().from(marketMakerSupplyStates)).toEqual([]);
    expect(await t.db.select().from(marketMakerSupplyIntervals)).toEqual([]);
  });

  it('clips recorded open time at closeAt and excludes the unobserved legacy prefix', async () => {
    const now = await clockTimestamp(t.db);
    const market = await createMarket(t.db, {
      openAt: new Date(now.getTime() - 60_000),
      closeAt: new Date(now.getTime() + 5_000),
    });
    const [state] = await t.db
      .select()
      .from(marketMakerSupplyStates)
      .where(eq(marketMakerSupplyStates.marketId, market.id));
    const result = await t.db.transaction(
      (tx) => readMarketMakerPeriodMetrics(tx, market, new Date(now.getTime() + 60_000)),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const known = String(market.closeAt.getTime() - state!.firstObservedAt.getTime());
    expect(result.window.to).toBe(market.closeAt.toISOString());
    expect(result.supply).toEqual({
      basis: 'posted_book',
      coverage: 'partial',
      observedFrom: state!.firstObservedAt.toISOString(),
      observedTo: market.closeAt.toISOString(),
      openMs: known,
      botGapMs: known,
      combinedGapMs: known,
    });
  });

  it('excludes paused time and preserves posted quantity and intervals after a real no-trade cancellation', async () => {
    const market = await opened();
    await cycle(market.id);
    const { market: paused } = await createMarketPause(t.db, { marketId: market.id });
    const before = await read(market.id);
    const later = new Date((await clockTimestamp(t.db)).getTime() + 60_000);
    const stillPaused = await t.db.transaction(
      (tx) => readMarketMakerPeriodMetrics(tx, paused, later),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(stillPaused.supply.openMs).toBe(before.supply.openMs);
    expect(stillPaused.supply.botGapMs).toBe(before.supply.botGapMs);
    const history = await t.db
      .select()
      .from(marketMakerSupplyIntervals)
      .where(eq(marketMakerSupplyIntervals.marketId, market.id));
    const { market: cancelled } = await closeMarketEarly(t.db, market.id, { humanFill: false });
    expect(cancelled.status).toBe('cancelled');
    const after = await read(market.id);
    expect(after.activity.bot).toEqual(before.activity.bot);
    expect(after.activity.bot?.postedQty).toBe('20');
    expect(after.supply.openMs).toBe(before.supply.openMs);
    expect(
      await t.db
        .select()
        .from(marketMakerSupplyIntervals)
        .where(eq(marketMakerSupplyIntervals.marketId, market.id)),
    ).toEqual(expect.arrayContaining(history));
  });
});
