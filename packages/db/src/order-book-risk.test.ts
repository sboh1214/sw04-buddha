import { bookDepth, quoteOrder, sellableOf, type QuoteTerms } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { lockForOrder } from './contracts.js';
import { findLedgerAccount, lockLedgerAccounts } from './ledger.js';
import { lockMarket } from './tx-helpers.js';
import { readHoldings, readMarketTradingFacts, readPublicBookSnapshot } from './order-book.js';
import { balances, ledgerEntries, orders } from './schema/index.js';
import { createConfiguredOpenMarket, createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { damageActualCoinForTest, fundMarketMakerFunds, mintTestPairs } from './test/ledger.js';
import { createOrder, openOrderIntake, placeTestOrder } from './test/orders.js';

const SETTINGS = {
  budgetCoin: 1000n,
  maxLossCoin: 100n,
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const TERMS: QuoteTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 10,
  budgetCoin: null,
};

describe.skipIf(!hasTestDb())('public MM risk snapshot (#128)', () => {
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
  const snapshot = <T>(read: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>) =>
    t.db.transaction(read, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  async function setup(legacy = false) {
    const market = legacy
      ? await createMarket(t.db, { createdBy: adminId, priceProtectionTicks: 98 })
      : await createConfiguredOpenMarket(t.db, {
          createdBy: adminId,
          priceProtectionTicks: 98,
          liquiditySettings: SETTINGS,
        });
    const ownerId = await fundMarketMakerFunds(t.db, market.id, 1000n);
    for (const price of [50, 40])
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        expect(
          await lockForOrder(tx, {
            marketId: market.id,
            ownerId,
            lock: { kind: 'coin', amountCoin: BigInt(price) * 10n },
          }),
        ).toMatchObject({ locked: true });
        await createOrder(tx as unknown as Db, {
          marketId: market.id,
          userId: ownerId,
          outcome: 'NO',
          side: 'buy',
          limitPriceCoin: price,
          qty: 10,
        });
      });
    return { marketId: market.id, ownerId };
  }
  const written = async () => ({
    orders: await t.db.select().from(orders).orderBy(orders.id),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
    ledger: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
  });

  it('keeps a repeatable-read risk snapshot across a separately committed intake without writing', async () => {
    const { marketId } = await setup();
    const human = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await snapshot(async (tx) => {
      const facts = (await readMarketTradingFacts(tx, marketId))!;
      const first = await readPublicBookSnapshot(tx, marketId);
      const before = await written();
      const quote = quoteOrder(first.book, facts, TERMS, null, first.risk);
      expect(quote).toMatchObject({
        kind: 'quoted',
        figures: { filledQty: 2, filledAmountCoin: 120n },
      });
      expect(await written()).toEqual(before);
      const placed = await placeTestOrder(t.db, {
        ownerId: human,
        marketId,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty: 10,
      });
      expect(placed).toMatchObject({
        kind: 'placed',
        order: { filledQty: 2, filledAmountCoin: 120n },
      });
      expect(await readPublicBookSnapshot(tx, marketId)).toEqual(first);
    });
    expect(await snapshot((tx) => readPublicBookSnapshot(tx, marketId))).toEqual({
      book: [],
      risk: null,
    });
  });

  it('does not wait on the market or funds writer and leaves its rows untouched', async () => {
    const { marketId } = await setup();
    const before = await written();
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      await lockLedgerAccounts(tx, [{ kind: 'market_maker_funds', marketId }]);
      await snapshot(async (reader) => {
        await reader.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
        const data = await readPublicBookSnapshot(reader, marketId);
        expect(bookDepth(data.book, data.risk)[0]!.asks).toEqual([{ priceCoin: 60, qty: 2 }]);
      });
    });
    expect(await written()).toEqual(before);
  });

  it('omits only legacy unconfigured MM liquidity while preserving human orders', async () => {
    const { marketId } = await setup(true);
    const human = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const result = await placeTestOrder(t.db, {
      marketId,
      ownerId: human,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 30,
      qty: 2,
    });
    expect(result.kind).toBe('placed');
    const before = await written();
    const data = await snapshot((tx) => readPublicBookSnapshot(tx, marketId));
    expect(data.risk).toBeNull();
    expect(data.book).toHaveLength(1);
    expect(data.book[0]!.owner).toEqual({ id: human, human: true });
    expect(bookDepth(data.book, data.risk)[0]!.asks).toEqual([{ priceCoin: 70, qty: 2 }]);
    expect(await written()).toEqual(before);
  });

  it('refuses damaged live MM assets without hiding them as zero or changing rows', async () => {
    const { marketId } = await setup();
    const account = (await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId }))!;
    await damageActualCoinForTest(account.id, -1n);
    const before = await written();
    await expect(snapshot((tx) => readPublicBookSnapshot(tx, marketId))).rejects.toThrow(
      'Market maker risk snapshot is inconsistent',
    );
    expect(await written()).toEqual(before);
  });

  it('quotes only unlocked holdings and uses the same capped sell as intake', async () => {
    const { marketId } = await setup();
    const holder = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const other = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    // Establish both human holdings with the real pair-mint processing before measuring this
    // read, without changing the legacy MM orders whose reservations are under test.
    await mintTestPairs(t.db, { marketId, yesHolderId: other, noHolderId: holder, qty: 5 });
    const before = await written();
    const value = await snapshot(async (tx) => {
      const facts = (await readMarketTradingFacts(tx, marketId))!;
      const { book, risk } = await readPublicBookSnapshot(tx, marketId);
      const holding = (await readHoldings(tx, holder, marketId)).find(
        (row) => row.outcome === 'NO',
      )!;
      return sellableOf(book, facts, holding, { id: holder, human: true }, risk);
    });
    expect(value.quote).toMatchObject({ filledQty: 2, filledAmountCoin: 80n });
    expect(await written()).toEqual(before);
    const result = await placeTestOrder(t.db, {
      marketId,
      ownerId: holder,
      outcome: 'NO',
      side: 'sell',
      timeInForce: 'ioc',
      limitPriceCoin: value.quote!.protectedLimitPriceCoin,
      qty: value.unlockedQty,
    });
    expect(result).toMatchObject({
      kind: 'placed',
      order: { filledQty: value.quote!.filledQty, filledAmountCoin: value.quote!.filledAmountCoin },
    });
  });
});
