import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_ACCEPTING_SETTING } from '@buddha/shared';
import { marketMakerAccountId } from './account-types.js';
import { runMarketMakerCycle } from './market-maker-cycle.js';
import { burnAvailableMarketMakerPairs } from './market-maker-burn.js';
import * as runtime from './market-maker-runtime.js';
import * as orderIntake from './orders.js';
import { lockForOrder } from './contracts.js';
import { balances, ledgerEntries, marketMakerRuns, orders, positions } from './schema/index.js';
import {
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { contractBook, positionOf } from './test/contracts.js';
import { ledgerAccountBalance, ledgerSupply, mintTestPairs } from './test/ledger.js';
import { createOrder, openOrderIntake, passMarketClose, placeTestOrder } from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { lockMarket } from './tx-helpers.js';

const SETTINGS = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
describe.skipIf(!hasTestDb())('operating market maker cycle (#129)', () => {
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
  const opened = async () =>
    (await createOpenedMarket(t.db, { liquiditySettings: SETTINGS })).market;
  const run = (marketId: string) => t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
  const refresh = (marketId: string) =>
    t.db.transaction((tx) => runtime.requestMarketMakerRefresh(tx, marketId));
  const live = async (marketId: string) =>
    (await orderIntake.readLiveBook(t.db, marketId)).filter((row) => !row.owner.human);
  async function setting(key: string, value: number | boolean | null) {
    await setReleaseSetting(t.db, {
      adminId,
      key,
      value,
      status: value === null ? 'undecided' : 'test',
    });
  }
  async function people() {
    return [
      (await createUser(t.db, { balanceCoin: 4_000n })).user.id,
      (await createUser(t.db, { balanceCoin: 4_000n })).user.id,
    ] as const;
  }

  it('posts the inventory ladder and keeps unchanged price-time priority on refresh', async () => {
    const market = await opened();
    const result = await run(market.id);
    expect(result).toMatchObject({
      outcome: 'ready',
      generation: 1n,
      cancelledOrderIds: [],
      burnedQty: 0,
      bookChanged: true,
    });
    const first = await live(market.id);
    expect(
      first.map((o) => ({
        outcome: o.outcome,
        side: o.side,
        price: o.priceCoin,
        qty: o.remainingQty,
      })),
    ).toEqual([
      { outcome: 'YES', side: 'buy', price: 48, qty: 10 },
      { outcome: 'NO', side: 'buy', price: 48, qty: 10 },
    ]);
    expect(await t.db.select().from(positions)).toEqual([]);
    await refresh(market.id);
    expect(await run(market.id)).toMatchObject({
      outcome: 'ready',
      orders: [],
      cancelledOrderIds: [],
      bookChanged: false,
    });
    expect(await live(market.id)).toEqual(first);
    expect(await run(market.id)).toMatchObject({ outcome: 'skipped', reason: 'already_completed' });
  });

  it('whole-cancels a 10-contract order and reposts exactly 5 when the stage halves the target', async () => {
    const market = await opened();
    await run(market.id);
    const first = await live(market.id);
    await setting('market_maker.reduce_at_bp', 0);
    await refresh(market.id);
    const result = await run(market.id);
    expect(result).toMatchObject({
      outcome: 'ready',
      bookChanged: true,
    });
    expect('cancelledOrderIds' in result && result.cancelledOrderIds).toEqual(
      expect.arrayContaining(first.map((o) => o.id)),
    );
    const after = await live(market.id);
    expect(after).toHaveLength(2);
    for (const order of after) {
      expect(order.priceCoin).toBe(48);
      expect(order.remainingQty).toBe(5);
      expect(first.map((o) => o.id)).not.toContain(order.id);
    }
    const funds = await ledgerAccountBalance(t.db, {
      kind: 'market_maker_funds',
      marketId: market.id,
    });
    expect(funds).toMatchObject({ availableCoin: 9_520n, lockedCoin: 480n, ledgerCoin: 10_000n });
  });

  it.each(['missing', 'invalid'] as const)(
    'cancels its quotes and waits on %s stage settings',
    async (kind) => {
      const market = await opened();
      await run(market.id);
      await setting('market_maker.reduce_at_bp', kind === 'missing' ? null : 9500);
      await refresh(market.id);
      expect(await run(market.id)).toMatchObject({
        outcome: 'waiting',
        reason: `risk_settings_${kind}`,
        bookChanged: true,
      });
      expect(await live(market.id)).toEqual([]);
      expect(await runtime.readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        completedGeneration: 1n,
        generation: 2n,
        desiredEnabled: true,
      });
      expect(
        (await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: market.id }))
          ?.lockedCoin,
      ).toBe(0n);
    },
  );

  it('preserves resting quotes when order intake is closed and posts no new quote', async () => {
    const market = await opened();
    await run(market.id);
    const first = await live(market.id);
    await setting(ORDER_ACCEPTING_SETTING.key, false);
    await refresh(market.id);
    expect(await run(market.id)).toMatchObject({
      outcome: 'waiting',
      reason: 'intake_closed',
      orders: [],
      cancelledOrderIds: [],
    });
    expect(await live(market.id)).toEqual(first);
  });

  it('does not touch held order locks or burn held pairs, and stops after the close', async () => {
    const market = await opened();
    await run(market.id);
    const first = await live(market.id);
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
    await refresh(market.id);
    const before = await t.db.select().from(balances);
    expect(await run(market.id)).toMatchObject({
      outcome: 'waiting',
      reason: 'ledger_hold',
      burnedQty: 0,
      orders: [],
      cancelledOrderIds: [],
    });
    expect(await live(market.id)).toEqual(first);
    expect(await t.db.select().from(balances)).toEqual(before);
    const other = await opened();
    await run(other.id);
    const otherQuotes = await live(other.id);
    await passMarketClose(t.db, other.id);
    await refresh(other.id);
    expect(await run(other.id)).toMatchObject({
      outcome: 'waiting',
      reason: 'close_passed',
      orders: [],
      cancelledOrderIds: [],
    });
    expect(await live(other.id)).toEqual(otherQuotes);
  });

  it('burns available pairs while PAUSED, without posting new quotes or changing net inventory', async () => {
    const market = await opened();
    const owner = (await marketMakerAccountId(t.db))!;
    const [a, b] = await people();
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: owner, noHolderId: a, qty: 3 });
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: b, noHolderId: owner, qty: 2 });
    await createMarketPause(t.db, { marketId: market.id, reason: 'basis_change', by: adminId });
    const supply = await ledgerSupply(t.db);
    expect(await run(market.id)).toMatchObject({
      outcome: 'waiting',
      reason: 'paused',
      burnedQty: 2,
      orders: [],
    });
    expect(await positionOf(t.db, owner, market.id, 'YES')).toMatchObject({ qty: 1, lockedQty: 0 });
    expect(await positionOf(t.db, owner, market.id, 'NO')).toMatchObject({ qty: 0, lockedQty: 0 });
    expect(await ledgerSupply(t.db)).toEqual(supply);
    expect(await contractBook(t.db, market.id)).toMatchObject({
      yes: 3,
      no: 3,
      collateralCoin: 300n,
    });
  });

  it('burns only unlocked pairs, and a repeated burn id never pays again', async () => {
    const market = await opened();
    const owner = (await marketMakerAccountId(t.db))!;
    const [a, b] = await people();
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: owner, noHolderId: a, qty: 3 });
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: b, noHolderId: owner, qty: 3 });
    await createOrder(t.db, {
      marketId: market.id,
      userId: owner,
      outcome: 'YES',
      side: 'sell',
      qty: 2,
      limitPriceCoin: 99,
    });
    await t.db.transaction((tx) =>
      lockForOrder(tx, {
        marketId: market.id,
        ownerId: owner,
        lock: { kind: 'contracts', outcome: 'YES', qty: 2 },
      }),
    );
    const burn = () =>
      t.db.transaction((tx) => burnAvailableMarketMakerPairs(tx, market.id, 'unlocked-once'));
    expect(await burn()).toBe(1);
    expect(await burn()).toBe(0);
    expect(await positionOf(t.db, owner, market.id, 'YES')).toMatchObject({ qty: 2, lockedQty: 2 });
    expect(await positionOf(t.db, owner, market.id, 'NO')).toMatchObject({ qty: 2, lockedQty: 0 });
    expect(
      (await t.db.select().from(ledgerEntries)).filter((e) => e.type === 'PAIR_BURN_RETURN'),
    ).toHaveLength(1);
  });

  it('stops the old ladder after an actual immediate fill and leaves a newer dirty generation', async () => {
    const market = await opened();
    const [a, b] = await people();
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: a, noHolderId: b, qty: 1 });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: a,
      outcome: 'YES',
      side: 'sell',
      limitPriceCoin: 1,
      qty: 1,
    });
    const result = await run(market.id);
    expect(result).toMatchObject({ outcome: 'ready', generation: 1n, nextGeneration: 2n });
    if (result.outcome !== 'ready') throw new Error('expected cycle');
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.fills).toHaveLength(1);
    expect((await live(market.id)).some((o) => o.outcome === 'NO')).toBe(false);
    expect(await runtime.readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      generation: 2n,
      completedGeneration: 1n,
    });
  });

  it('the real human intake burns a newly completed MM pair before it commits', async () => {
    const market = await opened();
    const owner = (await marketMakerAccountId(t.db))!;
    const [a] = await people();
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: owner, noHolderId: a, qty: 1 });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: owner,
      outcome: 'NO',
      limitPriceCoin: 48,
      qty: 1,
    });
    const supply = await ledgerSupply(t.db);
    const result = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: a,
      outcome: 'NO',
      side: 'sell',
      limitPriceCoin: 48,
      qty: 1,
    });
    expect(result.kind).toBe('placed');
    expect(await positionOf(t.db, owner, market.id, 'YES')).toMatchObject({ qty: 0 });
    expect(await positionOf(t.db, owner, market.id, 'NO')).toMatchObject({ qty: 0 });
    expect(await contractBook(t.db, market.id)).toMatchObject({
      yes: 0,
      no: 0,
      collateralCoin: 0n,
    });
    expect(await ledgerSupply(t.db)).toEqual(supply);
    expect(
      (await t.db.select().from(ledgerEntries)).filter((e) => e.type === 'PAIR_BURN_RETURN'),
    ).toHaveLength(1);
    expect(await runtime.readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      generation: 2n,
      completedGeneration: 0n,
    });
  });

  it('rolls every placement and lock back on a later cycle error', async () => {
    const market = await opened();
    const before = await t.db.select().from(balances);
    const original = orderIntake.placeOrder;
    vi.spyOn(orderIntake, 'placeOrder')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('second placement failed'));
    await expect(run(market.id)).rejects.toMatchObject({
      name: 'MarketMakerCycleError',
      context: { marketId: market.id, generation: 1n },
      cause: { message: 'second placement failed' },
    });
    expect(await t.db.select().from(orders)).toEqual([]);
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await t.db.select().from(marketMakerRuns)).toEqual([]);
    expect(await runtime.readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      completedGeneration: 0n,
      generation: 1n,
    });
  });

  it('serializes two cycles for one generation and never duplicates a quote', async () => {
    const market = await opened();
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      locked();
      await unblock;
      return runMarketMakerCycle(tx, { marketId: market.id });
    });
    await acquired;
    const second = run(market.id);
    try {
      await waitForLockWaiter(t.db.$client, 'the second cycle waits for the market');
    } finally {
      release();
    }
    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ outcome: 'ready' });
    expect(results[1]).toMatchObject({ outcome: 'skipped', reason: 'already_completed' });
    expect(await live(market.id)).toHaveLength(2);
  });

  it('prelocks shared people across markets before either cycle starts filling', async () => {
    const m1 = await opened();
    const m2 = await opened();
    const [a, b] = await people();
    for (const [market, yes, no] of [
      [m1, a, b],
      [m2, b, a],
    ] as const) {
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 1 });
      await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: yes,
        outcome: 'YES',
        side: 'sell',
        limitPriceCoin: 1,
        qty: 1,
      });
      await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: no,
        outcome: 'NO',
        side: 'sell',
        limitPriceCoin: 1,
        qty: 1,
      });
    }
    const before = await ledgerSupply(t.db);
    const results = await Promise.all([run(m1.id), run(m2.id)]);
    expect(results.map((r) => r.outcome)).toEqual(['ready', 'ready']);
    expect(await ledgerSupply(t.db)).toEqual(before);
    for (const result of results) {
      if (result.outcome !== 'ready') throw new Error('expected cycle');
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0]!.fills).toHaveLength(1);
    }
  });

  it('keeps legacy OPEN markets without a runtime unchanged', async () => {
    const market = await createMarket(t.db);
    expect(await run(market.id)).toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'no_runtime',
    });
    expect(await t.db.select().from(orders)).toEqual([]);
  });

  it('treats an explicitly stopped runtime as a wait and cancels only its quotes', async () => {
    const market = await opened();
    await run(market.id);
    await refresh(market.id);
    const current = (await runtime.readMarketMakerRuntime(t.db, market.id))!;
    // The #130 stop writer is not implemented yet and 0069 deliberately disallows a raw policy
    // change. Feed its future read state to this consumer without pretending a DB stop occurred.
    vi.spyOn(runtime, 'readMarketMakerRuntime').mockResolvedValue({
      ...current,
      desiredEnabled: false,
    });
    expect(await run(market.id)).toMatchObject({
      outcome: 'waiting',
      reason: 'stopped',
      bookChanged: true,
    });
    expect(await live(market.id)).toEqual([]);
  });
});
