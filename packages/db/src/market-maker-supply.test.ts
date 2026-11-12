import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from './client.js';
import { runMarketMakerCycle } from './market-maker-cycle.js';
import { requestMarketMakerRefresh } from './market-maker-runtime.js';
import { cancelOrder } from './order-cancel.js';
import { readLiveBook } from './orders.js';
import {
  marketMakerSupplyIntervals,
  marketMakerSupplyPending,
  marketMakerSupplyStates,
  markets,
} from './schema/index.js';
import {
  createMarket,
  createOpenedMarket,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { openOrderIntake } from './test/orders.js';

describe.skipIf(!hasTestDb())('deferred posted-book supply observations (#182)', () => {
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
  afterEach(async () => {
    expect(await t.db.select().from(marketMakerSupplyPending)).toEqual([]);
  });
  const state = async (id: string) =>
    (
      await t.db
        .select()
        .from(marketMakerSupplyStates)
        .where(eq(marketMakerSupplyStates.marketId, id))
    )[0]!;
  const intervals = (id: string) =>
    t.db
      .select()
      .from(marketMakerSupplyIntervals)
      .where(eq(marketMakerSupplyIntervals.marketId, id))
      .orderBy(marketMakerSupplyIntervals.id);
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

  it('scans a market book once per deferred flush and again after later writes', async () => {
    const market = await opened();
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    let definition: string | undefined;
    try {
      const { rows } = await owner.execute<{ definition: string }>(sql`
        SELECT pg_get_functiondef('market_maker_supply_observe()'::regprocedure) AS definition
      `);
      definition = rows[0]!.definition;
      const observation = 'observed_at := greatest(clock_timestamp(), previous.last_observed_at);';
      expect(definition.split(observation)).toHaveLength(2);
      // Count actual visits to the full-book observation, without a latency threshold or
      // changing its result. The isolated test DB owner restores the function in finally.
      await owner.execute(sql`CREATE SEQUENCE public.test_supply_scan_count`);
      await owner.execute(
        sql.raw(
          definition.replace(
            observation,
            `PERFORM nextval('public.test_supply_scan_count');\n  ${observation}`,
          ),
        ),
      );
      const scans = async () => {
        const { rows: counts } = await owner.execute<{ count: string }>(sql`
          SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS count
          FROM public.test_supply_scan_count
        `);
        return Number(counts[0]!.count);
      };
      await t.db.transaction(async (tx) => {
        expect((await runMarketMakerCycle(tx, { marketId: market.id })).outcome).toBe('ready');
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(await scans()).toBe(1);
        const book = await readLiveBook(tx, market.id);
        expect(book.length).toBeGreaterThan(1);
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        for (const row of book) {
          await cancelOrder(tx, { ownerId: row.owner.id, orderId: row.id, reason: 'by_owner' });
        }
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(await scans()).toBe(2);
      });
      expect(await scans()).toBe(2);
      expect(await state(market.id)).toMatchObject({ botYesBuy: false, botNoBuy: false });
    } finally {
      if (definition) await owner.execute(sql.raw(definition));
      await owner.execute(sql`DROP SEQUENCE IF EXISTS public.test_supply_scan_count`);
      await closeDb(owner);
    }
  });

  it('observes a new draft without inventing open time, and app reads cannot change the facts', async () => {
    const market = await createMarket(t.db, { createdBy: adminId, status: 'draft' });
    const before = await state(market.id);
    expect(before).toMatchObject({
      marketId: market.id,
      isOpen: false,
      botYesBuy: false,
      botNoBuy: false,
      yesAsk: false,
      noAsk: false,
    });
    expect(await intervals(market.id)).toEqual([]);
    await t.db.transaction(
      async (tx) => {
        expect(await tx.select().from(marketMakerSupplyStates)).toEqual([before]);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(await state(market.id)).toEqual(before);
    await expect(
      t.db.update(marketMakerSupplyStates).set({ botYesBuy: true }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(t.db.delete(marketMakerSupplyStates)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(
      t.db.insert(marketMakerSupplyPending).values({ marketId: market.id }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(t.db.delete(marketMakerSupplyPending)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('records both actual bot bids and their converted asks, with no atomic replacement gap', async () => {
    const market = await opened();
    await cycle(market.id);
    const before = await state(market.id);
    expect(before).toMatchObject({
      isOpen: true,
      botYesBuy: true,
      botNoBuy: true,
      yesAsk: true,
      noAsk: true,
    });
    expect(before.firstObservedAt.getTime()).toBeLessThanOrEqual(market.openAt!.getTime());
    const history = await intervals(market.id);
    const oldBook = await readLiveBook(t.db, market.id);
    await setReleaseSetting(t.db, {
      adminId,
      key: 'market_maker.reduce_at_bp',
      value: 0,
      status: 'test',
    });
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    const result = await cycle(market.id);
    expect(result.outcome).toBe('ready');
    expect((await readLiveBook(t.db, market.id)).map((row) => row.id)).not.toEqual(
      oldBook.map((row) => row.id),
    );
    expect(await intervals(market.id)).toEqual(history);
    expect(await state(market.id)).toMatchObject({
      startedAt: before.startedAt,
      botYesBuy: true,
      botNoBuy: true,
      yesAsk: true,
      noAsk: true,
    });
    await expect(
      t.db.update(marketMakerSupplyIntervals).set({ isOpen: false }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rolls back cancelled orders and observations together', async () => {
    const market = await opened();
    await cycle(market.id);
    const before = await state(market.id);
    const history = await intervals(market.id);
    const book = await readLiveBook(t.db, market.id);
    await expect(
      t.db.transaction(async (tx) => {
        await cancelOrder(tx, {
          ownerId: book[0]!.owner.id,
          orderId: book[0]!.id,
          reason: 'by_owner',
        });
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        throw new Error('rollback observation');
      }),
    ).rejects.toThrow('rollback observation');
    expect(await state(market.id)).toEqual(before);
    expect(await intervals(market.id)).toEqual(history);
    expect(await readLiveBook(t.db, market.id)).toEqual(book);
  });

  it('closes the prior state when a committed cancellation removes one actual bid and converted ask', async () => {
    const market = await opened();
    await cycle(market.id);
    const previous = await state(market.id);
    const bid = (await readLiveBook(t.db, market.id)).find((row) => row.outcome === 'YES')!;
    await t.db.transaction((tx) =>
      cancelOrder(tx, { ownerId: bid.owner.id, orderId: bid.id, reason: 'by_owner' }),
    );
    const current = await state(market.id);
    expect(current).toMatchObject({
      firstObservedAt: previous.firstObservedAt,
      botYesBuy: false,
      botNoBuy: true,
      yesAsk: true,
      noAsk: false,
    });
    expect((await intervals(market.id)).at(-1)).toMatchObject({
      startedAt: previous.startedAt,
      endedAt: current.startedAt,
      botYesBuy: true,
      botNoBuy: true,
      yesAsk: true,
      noAsk: true,
    });
  });

  it('serializes concurrent duplicate cycles without a second supply transition', async () => {
    const market = await opened();
    const answers = await Promise.all([cycle(market.id), cycle(market.id)]);
    expect(answers.map((answer) => answer.outcome).sort()).toEqual(['ready', 'skipped']);
    const history = await intervals(market.id);
    expect(history.filter((row) => row.isOpen && !row.botYesBuy && !row.botNoBuy)).toHaveLength(1);
    expect(await state(market.id)).toMatchObject({
      botYesBuy: true,
      botNoBuy: true,
      yesAsk: true,
      noAsk: true,
    });
  });

  it('observes the final book after a forced intermediate constraint flush', async () => {
    const market = await opened();
    await cycle(market.id);
    const book = await readLiveBook(t.db, market.id);
    const before = await intervals(market.id);
    await t.db.transaction(async (tx) => {
      await cancelOrder(tx, {
        ownerId: book[0]!.owner.id,
        orderId: book[0]!.id,
        reason: 'by_owner',
      });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await cancelOrder(tx, {
        ownerId: book[1]!.owner.id,
        orderId: book[1]!.id,
        reason: 'by_owner',
      });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    });
    expect(await readLiveBook(t.db, market.id)).toEqual([]);
    expect(await state(market.id)).toMatchObject({
      botYesBuy: false,
      botNoBuy: false,
      yesAsk: false,
      noAsk: false,
    });
    expect(await intervals(market.id)).toHaveLength(before.length + 1);
  });

  it('folds repeated flushed transitions back into the unchanged committed state', async () => {
    const market = await createMarket(t.db, { createdBy: adminId, status: 'draft' });
    const before = await state(market.id);
    const history = await intervals(market.id);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      for (const offset of [10_000, 20_000, 0]) {
        await tx
          .update(markets)
          .set({ closeAt: new Date(market.closeAt.getTime() + offset) })
          .where(eq(markets.id, market.id));
      }
    });
    expect(await state(market.id)).toMatchObject({
      startedAt: before.startedAt,
      firstObservedAt: before.firstObservedAt,
      closeAt: market.closeAt,
    });
    expect(await intervals(market.id)).toEqual(history);
  });

  it('keeps only the final first observation even when a new draft is flushed repeatedly', async () => {
    const market = await t.db.transaction(async (tx) => {
      const row = await createMarket(tx as unknown as Db, { createdBy: adminId, status: 'draft' });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      for (const offset of [10_000, 20_000, 0]) {
        await tx
          .update(markets)
          .set({ closeAt: new Date(row.closeAt.getTime() + offset) })
          .where(eq(markets.id, row.id));
      }
      return row;
    });
    const observed = await state(market.id);
    expect(observed).toMatchObject({ closeAt: market.closeAt, isOpen: false });
    expect(observed.firstObservedAt).toEqual(observed.startedAt);
    expect(observed.firstObservedTxid).toEqual(observed.lastObservedTxid);
    expect(await intervals(market.id)).toEqual([]);
  });

  it('restores flushed observation changes on a savepoint rollback', async () => {
    const market = await opened();
    await cycle(market.id);
    const book = await readLiveBook(t.db, market.id);
    const before = await state(market.id);
    const history = await intervals(market.id);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SAVEPOINT before_observation`);
      await cancelOrder(tx, {
        ownerId: book[0]!.owner.id,
        orderId: book[0]!.id,
        reason: 'by_owner',
      });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT before_observation`);
    });
    expect(await state(market.id)).toEqual(before);
    expect(await intervals(market.id)).toEqual(history);
    expect(await readLiveBook(t.db, market.id)).toEqual(book);
  });

  it('never lets an owner alter or remove a committed interval', async () => {
    const market = await opened();
    await cycle(market.id);
    const history = await intervals(market.id);
    expect(history.length).toBeGreaterThan(0);
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await expect(
        owner
          .update(marketMakerSupplyIntervals)
          .set({ endedAt: new Date() })
          .where(eq(marketMakerSupplyIntervals.id, history[0]!.id)),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        owner
          .delete(marketMakerSupplyIntervals)
          .where(eq(marketMakerSupplyIntervals.id, history[0]!.id)),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(await intervals(market.id)).toEqual(history);
    } finally {
      await closeDb(owner);
    }
  });

  it('restores pending work when a flush rolls back to its savepoint', async () => {
    const market = await opened();
    await cycle(market.id);
    const bid = (await readLiveBook(t.db, market.id)).find((row) => row.outcome === 'YES')!;
    const before = await intervals(market.id);
    await t.db.transaction(async (tx) => {
      await cancelOrder(tx, { ownerId: bid.owner.id, orderId: bid.id, reason: 'by_owner' });
      await tx.execute(sql`SAVEPOINT pending_observation`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT pending_observation`);
      expect(await tx.select().from(marketMakerSupplyPending)).toEqual([{ marketId: market.id }]);
    });
    expect(await state(market.id)).toMatchObject({ botYesBuy: false, botNoBuy: true });
    expect(await intervals(market.id)).toHaveLength(before.length + 1);
  });

  it('serializes the first observation of an existing market across canonical concurrent writers', async () => {
    const market = await opened();
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await owner
        .delete(marketMakerSupplyStates)
        .where(eq(marketMakerSupplyStates.marketId, market.id));
    } finally {
      await closeDb(owner);
    }
    const answers = await Promise.all([cycle(market.id), cycle(market.id)]);
    expect(answers.map((answer) => answer.outcome).sort()).toEqual(['ready', 'skipped']);
    expect(await state(market.id)).toMatchObject({ botYesBuy: true, botNoBuy: true });
  });
});
