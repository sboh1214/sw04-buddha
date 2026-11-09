import { findLedgerAccount, schema, type Db } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createUser,
  fundMarketMakerFunds,
  hasTestDb,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  withLedgerGuardsOff,
  type TestDb,
} from '@buddha/db/test';
import { marketChannel, type MarketRealtimeEvent, type UserRealtimeEvent } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Publish } from '../realtime.js';
import {
  reconcileDueMarkets,
  reconcileLedger,
  reconcileTarget,
  reconciliationBatchSummary,
} from './reconciliation.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

describe.skipIf(!hasTestDb())('reconciliation jobs (#93, integration)', () => {
  let t: TestDb;
  let published: { channel: string; event: MarketRealtimeEvent | UserRealtimeEvent }[];
  let publish: Publish;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
    publish = (channel, event) => {
      published.push({ channel, event });
      return Promise.resolve();
    };
  });

  async function damagedMarket() {
    const market = await createMarket(t.db, { status: 'open' });
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 2,
      yesPriceCoin: 60,
    });
    const collateral = await findLedgerAccount(t.db, {
      kind: 'market_collateral',
      marketId: market.id,
    });
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin + 1 WHERE account_id = $1',
        [collateral!.id],
      ),
    );
    return { market, yes, collateralId: collateral!.id };
  }

  it('checks every unexamined market, skips unchanged clean markets and follows new ledger events', async () => {
    const first = await createMarket(t.db, { status: 'open' });
    await createMarket(t.db, { status: 'draft' });
    expect(await reconcileDueMarkets(t.db, publish)).toMatchObject({
      checked: 2,
      passed: 2,
      mismatched: 0,
      failed: 0,
      scopes: { market: 2, account: 0, supply: 0 },
    });
    expect((await reconcileDueMarkets(t.db, publish)).checked).toBe(0);
    await fundMarketMakerFunds(t.db, first.id, 100n);
    expect(await reconcileDueMarkets(t.db, publish)).toMatchObject({
      checked: 1,
      passed: 1,
      failed: 0,
    });
    expect(published).toEqual([]);
  });

  it('commits a system pause before publishing, preserves orders and retries failed facts without new events', async () => {
    const { market, yes } = await damagedMarket();
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    const placed = await placeTestOrder(t.db, {
      ownerId: yes,
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      qty: 1,
      limitPriceCoin: 30,
    });
    if (placed.kind !== 'placed') throw new Error('resting order required');
    const beforeOrder = placed.order;
    const [beforeBalance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, yes));
    const afterCommit: Publish = async (channel, event) => {
      const [stored] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id));
      expect(stored?.status).toBe('paused');
      expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
      await publish(channel, event);
    };
    const first = await reconcileDueMarkets(t.db, afterCommit);
    expect(first).toMatchObject({ checked: 1, mismatched: 1, held: 1, paused: 1, failed: 0 });
    expect(published).toEqual([
      {
        channel: marketChannel(market.id),
        event: expect.objectContaining({
          type: 'market:status',
          marketId: market.id,
          status: 'paused',
        }) as unknown,
      },
    ]);
    expect((await t.db.select().from(schema.marketPauses))[0]).toMatchObject({
      pausedBy: null,
      reason: 'ledger_failure',
    });
    expect(
      (await t.db.select().from(schema.orders).where(eq(schema.orders.id, beforeOrder.id)))[0],
    ).toEqual(beforeOrder);
    expect(
      (await t.db.select().from(schema.balances).where(eq(schema.balances.userId, yes)))[0],
    ).toEqual(beforeBalance);
    const again = await reconcileDueMarkets(t.db, publish);
    expect(again).toMatchObject({ checked: 1, mismatched: 1, held: 1, paused: 0, failed: 0 });
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(2);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('a clean manual recheck records success without releasing the hold or resuming the market', async () => {
    const { market, collateralId } = await damagedMarket();
    await reconcileTarget(t.db, { scope: 'market', marketId: market.id }, publish);
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin - 1 WHERE account_id = $1',
        [collateralId],
      ),
    );
    const done = await reconcileTarget(
      t.db,
      { scope: 'market', marketId: market.id },
      publish,
      'manual',
    );
    expect(done).toMatchObject({ passed: true, held: true, paused: false });
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]?.status,
    ).toBe('paused');
    expect(published).toHaveLength(1);
  });

  it('daily checks accounts and supply, records both failures and never makes a global hold', async () => {
    const { user } = await createUser(t.db, { balanceCoin: 100n });
    await createUser(t.db);
    await withLedgerGuardsOff((client) =>
      client.query('UPDATE balances SET available_coin = available_coin + 7 WHERE user_id = $1', [
        user.id,
      ]),
    );
    const result = await reconcileLedger(t.db, publish);
    expect(result).toMatchObject({
      checked: 3,
      passed: 1,
      mismatched: 2,
      held: 1,
      paused: 0,
      failed: 0,
      scopes: { account: 2, market: 0, supply: 1 },
    });
    expect(result.mismatches.map((row) => row.scope).sort()).toEqual(['account', 'supply']);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(1);
    expect(published).toEqual([]);
    expect(() => JSON.stringify(reconciliationBatchSummary(result))).not.toThrow();
  });

  it('manual all includes markets without ledger accounts and checks a market with funds once', async () => {
    await createMarket(t.db, { status: 'draft' });
    const funded = await createMarket(t.db, { status: 'open' });
    await fundMarketMakerFunds(t.db, funded.id, 100n);
    const result = await reconcileLedger(t.db, publish, { source: 'manual', allMarkets: true });
    expect(result).toMatchObject({ mismatched: 0, failed: 0, scopes: { market: 2, supply: 1 } });
    const records = await t.db.select().from(schema.reconciliationResults);
    expect(
      records.filter((row) => row.scope === 'market' && row.marketId === funded.id),
    ).toHaveLength(1);
    expect(records.every((row) => row.source === 'manual')).toBe(true);
  });

  it('publishes nothing from a rolled-back audit and continues the scan after that target fails', async () => {
    const { market } = await damagedMarket();
    await createMarket(t.db, { status: 'open' });
    const failing = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (run: (tx: Tx) => Promise<{ result: { marketId: string | null } }>) =>
            target.transaction(async (tx) => {
              const done = await run(tx);
              if (done.result.marketId === market.id) throw new Error('injected before commit');
              return done;
            });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = await reconcileDueMarkets(failing, publish);
    expect(result).toMatchObject({ checked: 1, passed: 1, failed: 1, paused: 0 });
    expect(result.failures[0]).toMatchObject({
      target: `market:${market.id}`,
      message: 'injected before commit',
    });
    expect(await t.db.select().from(schema.reconciliationHolds)).toEqual([]);
    expect(await t.db.select().from(schema.reconciliationResults)).toHaveLength(1);
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]?.status,
    ).toBe('open');
    expect(published).toEqual([]);
  });
});
