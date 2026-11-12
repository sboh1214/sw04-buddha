import { randomUUID } from 'node:crypto';
import {
  adminMarketMakerMetricsSchema,
  adminMarketMakerMetricsOverviewSchema,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockForOrder } from './contracts.js';
import { ensureLedgerAccount, findLedgerAccount } from './ledger.js';
import { setMarketLiquidity } from './market-liquidity.js';
import {
  readMarketMakerMetrics,
  readMarketMakerMetricsOverview,
  readMarketMakerMetricsPage,
} from './market-maker-metrics.js';
import { settleMarketPositions } from './market-settlement.js';
import {
  balances,
  ledgerAccounts,
  ledgerEntries,
  markets,
  marketSettlementSteps,
  positions,
  profiles,
} from './schema/index.js';
import {
  createMarket,
  createMarketMakerAccount,
  createPosition,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  damageActualCoinForTest,
  fundMarketMakerFunds,
  mintTestPairs,
  recordLegacyMarketMakerCapitalForTest,
} from './test/ledger.js';
import { createOrder } from './test/orders.js';
import { clockTimestamp } from './tx-helpers.js';

const SETTINGS = {
  budgetCoin: 10_000n,
  maxLossCoin: 1_000n,
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

describe.skipIf(!hasTestDb())('current market maker metrics (#182)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });
  const detail = (id: string) =>
    t.db.transaction((tx) => readMarketMakerMetrics(tx, id), READ_ONLY);
  const overview = () => t.db.transaction((tx) => readMarketMakerMetricsOverview(tx), READ_ONLY);
  const page = (cursor?: string, limit = 1) =>
    t.db.transaction((tx) => readMarketMakerMetricsPage(tx, { cursor, limit }), READ_ONLY);
  const funds = (marketId: string) => ({ kind: 'market_maker_funds' as const, marketId });
  async function configured() {
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    const market = await createMarket(t.db, { createdBy: adminId, status: 'draft' });
    await t.db.transaction((tx) =>
      setMarketLiquidity(tx, {
        marketId: market.id,
        actorId: adminId,
        baseVersion: null,
        settings: SETTINGS,
        reason: 'metrics current facts',
      }),
    );
    return { market, adminId };
  }
  async function ready(id: string) {
    const result = await detail(id);
    expect(result?.risk.kind).toBe('ready');
    if (!result || result.risk.kind !== 'ready') throw new Error('Expected ready metrics');
    expect(adminMarketMakerMetricsSchema.parse(result)).toEqual(result);
    return { ...result, risk: result.risk };
  }
  async function recallLegacyCapital(marketId: string, amountCoin: bigint) {
    // Explicit pre-0070 capital: test historical reader inputs, not the current recall executor.
    // Preserve the chain and balances through the existing owner-only legacy fixture.
    return recordLegacyMarketMakerCapitalForTest({
      type: 'BOT_RECALL',
      from: funds(marketId),
      to: { kind: 'treasury' },
      marketId,
      amountCoin,
      refType: 'market',
      refId: marketId,
      idempotencyKey: randomUUID(),
    });
  }
  async function economicRows() {
    return {
      accounts: await t.db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id),
      money: await t.db.select().from(balances).orderBy(balances.accountId),
      entries: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
      holdings: await t.db
        .select()
        .from(positions)
        .orderBy(positions.marketId, positions.userId, positions.outcome),
    };
  }
  async function paid(result: 'YES' | 'NO' | 'VOID') {
    const fixture = await configured();
    const owner = await fundMarketMakerFunds(t.db, fixture.market.id, 1_000n);
    const human = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: fixture.market.id,
      yesHolderId: owner,
      noHolderId: human,
      qty: 2,
      yesPriceCoin: 40,
    });
    await t.db
      .update(markets)
      .set({ status: 'settling', resolvedResult: result })
      .where(eq(markets.id, fixture.market.id));
    return { ...fixture, owner, human };
  }

  it('does not invent configuration, accounts, stages or top N during a read', async () => {
    const market = await createMarket(t.db);
    const before = await economicRows();
    expect(await detail(randomUUID())).toBeNull();
    expect(await detail(market.id)).toMatchObject({
      risk: { kind: 'unavailable', reason: 'missing_config' },
      concentration: {
        setting: { status: 'undecided', value: null },
        YES: { totalQty: '0', topQty: null, topShareBp: null, holders: null },
      },
    });
    expect(await overview()).toMatchObject({
      marketCount: '0',
      readyCount: '0',
      complete: true,
      treasury: { status: 'uninitialized' },
      totals: { investedCoin: '0', fundsCoin: '0' },
    });
    expect(await economicRows()).toEqual(before);
  });

  it('shows locked assets once, adversarial reservations and every converted bot/human depth level', async () => {
    const { market, adminId } = await configured();
    const owner = await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: owner,
      noHolderId: person,
      qty: 5,
      yesPriceCoin: 40,
    });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: person,
      noHolderId: owner,
      qty: 3,
      yesPriceCoin: 60,
    });
    await createOrder(t.db, {
      marketId: market.id,
      userId: owner,
      outcome: 'NO',
      qty: 4,
      filledQty: 1,
      status: 'partially_filled',
      limitPriceCoin: 20,
    });
    await createOrder(t.db, {
      marketId: market.id,
      userId: owner,
      side: 'sell',
      outcome: 'YES',
      qty: 2,
      limitPriceCoin: 80,
    });
    await t.db.transaction(async (tx) => {
      await lockForOrder(tx, {
        marketId: market.id,
        ownerId: owner,
        lock: { kind: 'coin', amountCoin: 60n },
      });
      await lockForOrder(tx, {
        marketId: market.id,
        ownerId: owner,
        lock: { kind: 'contracts', outcome: 'YES', qty: 2 },
      });
    });
    await createOrder(t.db, { marketId: market.id, userId: person, qty: 100, limitPriceCoin: 50 });
    await createOrder(t.db, { marketId: market.id, userId: person, qty: 11, limitPriceCoin: 1 });
    await createOrder(t.db, { marketId: market.id, userId: person, qty: 17, status: 'cancelled' });
    const before = await economicRows();
    const current = await ready(market.id);
    expect(current.risk).toMatchObject({
      assets: {
        coin: '680',
        availableCoin: '620',
        lockedCoin: '60',
        yesQty: '5',
        noQty: '3',
        yesLockedQty: '2',
      },
      capital: { investedCoin: '1000', recoveredCoin: '0' },
      pnl: {
        kind: 'scenarios',
        holdings: { YES: '180', NO: '-20', VOID: '80' },
        reserved: { YES: '80', NO: '-20', VOID: '80' },
      },
      worstLossCoin: '20',
      reservedWorstLossCoin: '20',
      utilizationBp: '200',
      stage: null,
      stageStatus: 'undecided',
    });
    expect(current.depth.bot.YES.asks).toEqual([{ priceCoin: 80, qty: '5' }]);
    expect(current.depth.bot.NO.bids).toEqual([{ priceCoin: 20, qty: '3' }]);
    expect(current.depth.human.YES.bids).toEqual([
      { priceCoin: 50, qty: '100' },
      { priceCoin: 1, qty: '11' },
    ]);
    expect(current.depth.human.NO.asks).toEqual([
      { priceCoin: 50, qty: '100' },
      { priceCoin: 99, qty: '11' },
    ]);
    expect(await economicRows()).toEqual(before);
    for (const [key, value] of [
      ['market_maker.reduce_at_bp', 100],
      ['market_maker.halt_at_bp', 200],
      ['market_maker.reduce_ratio_bp', 5000],
    ] as const)
      await setReleaseSetting(t.db, { adminId, key, status: 'test', value });
    expect((await ready(market.id)).risk).toMatchObject({ stage: 'halt', stageStatus: 'ready' });
    await setReleaseSetting(t.db, {
      adminId,
      key: 'market_maker.reduce_at_bp',
      status: 'test',
      value: 201,
    });
    expect((await ready(market.id)).risk).toMatchObject({
      stage: null,
      stageStatus: 'invalid',
      worstLossCoin: '20',
    });
  });

  it('keeps human locked holdings and nullable identities in concentration, excluding bot and retired quantities', async () => {
    const { market, adminId } = await configured();
    const owner = await fundMarketMakerFunds(t.db, market.id, 100n);
    const a = (await createUser(t.db)).user.id;
    const b = (await createUser(t.db)).user.id;
    const c = (await createUser(t.db)).user.id;
    await createPosition(t.db, {
      marketId: market.id,
      userId: a,
      outcome: 'YES',
      qty: 7,
      lockedQty: 3,
    });
    await createPosition(t.db, { marketId: market.id, userId: b, outcome: 'YES', qty: 3 });
    await createPosition(t.db, {
      marketId: market.id,
      userId: c,
      outcome: 'YES',
      qty: 20,
      settled: true,
    });
    await createPosition(t.db, { marketId: market.id, userId: owner, outcome: 'YES', qty: 99 });
    expect((await detail(market.id))!.concentration.YES).toEqual({
      totalQty: '10',
      topQty: null,
      topShareBp: null,
      holders: null,
    });
    await setReleaseSetting(t.db, {
      adminId,
      key: 'market_maker.concentration_top_n',
      status: 'test',
      value: 1,
    });
    const current = (await detail(market.id))!;
    expect(current.concentration.YES).toMatchObject({
      totalQty: '10',
      topQty: '7',
      topShareBp: '7000',
      holders: [{ userId: a, qty: '7', shareBp: '7000' }],
    });
    expect(Object.keys(current.concentration.YES.holders![0]!).sort()).toEqual([
      'nickname',
      'qty',
      'shareBp',
      'userId',
    ]);
    expect(current.concentration.NO).toEqual({
      totalQty: '0',
      topQty: '0',
      topShareBp: null,
      holders: [],
    });
    // Missing historical profile cannot silently remove its still-recorded holding.
    await t.db.delete(profiles).where(eq(profiles.userId, a));
    expect((await detail(market.id))!.concentration.YES.holders![0]).toMatchObject({
      userId: a,
      nickname: null,
      qty: '7',
    });
  });

  it.each(['YES', 'NO', 'VOID'] as const)(
    'uses the committed coin step for actual %s profit even before SETTLED',
    async (result) => {
      const { market } = await paid(result);
      expect((await ready(market.id)).risk.pnl.kind).toBe('scenarios');
      await t.db.transaction(async (tx) => {
        await settleMarketPositions(tx, market.id);
        await tx.insert(marketSettlementSteps).values({
          marketId: market.id,
          step: 'coin',
          status: 'done',
          completedAt: await clockTimestamp(tx),
        });
      });
      const current = await ready(market.id);
      expect(current.status).toBe('settling');
      expect(current.risk.assets.yesQty).toBe('0');
      expect(current.risk.pnl).toEqual({
        kind: 'actual',
        reason: 'paid',
        result,
        amountCoin: result === 'YES' ? '120' : result === 'NO' ? '-80' : '20',
      });
    },
  );

  it('does not call a broken done marker or cancelled leftover holdings actual profit', async () => {
    const { market } = await paid('YES');
    await t.db
      .insert(marketSettlementSteps)
      .values({ marketId: market.id, step: 'coin', status: 'done', completedAt: new Date() });
    expect((await detail(market.id))!.risk).toEqual({
      kind: 'inconsistent',
      reason: 'settlement_books',
    });
    const other = await configured();
    const owner = await fundMarketMakerFunds(t.db, other.market.id, 100n);
    await t.db.update(markets).set({ status: 'cancelled' }).where(eq(markets.id, other.market.id));
    expect((await ready(other.market.id)).risk.pnl).toEqual({
      kind: 'actual',
      reason: 'cancelled',
      result: null,
      amountCoin: '0',
    });
    await createPosition(t.db, {
      marketId: other.market.id,
      userId: owner,
      outcome: 'YES',
      qty: 1,
    });
    expect((await detail(other.market.id))!.risk).toEqual({
      kind: 'inconsistent',
      reason: 'cancelled_books',
    });
  });

  it('sums loss without offsetting gains and separates full-domain totals from paginated legacy/recall rows', async () => {
    const winning = await paid('YES');
    await t.db.transaction(async (tx) => {
      await settleMarketPositions(tx, winning.market.id);
      await tx.insert(marketSettlementSteps).values({
        marketId: winning.market.id,
        step: 'coin',
        status: 'done',
        completedAt: await clockTimestamp(tx),
      });
    });
    const losing = await paid('NO'); // unpaid: 80 Coin is at risk
    const legacy = await createMarket(t.db); // funded but missing configuration must remain visible
    await fundMarketMakerFunds(t.db, legacy.id, 40n);
    const empty = await configured();
    await createMarketMakerAccount(t.db);
    await t.db.transaction((tx) => ensureLedgerAccount(tx, funds(empty.market.id)));
    await recallLegacyCapital(winning.market.id, 1_120n);
    const all = await overview();
    expect(adminMarketMakerMetricsOverviewSchema.parse(all)).toEqual(all);
    expect(all).toMatchObject({
      marketCount: '3',
      readyCount: '2',
      complete: false,
      totals: {
        worstLossCoin: '80',
        maxLossCoin: '2000',
        investedCoin: '2000',
        recoveredCoin: '1120',
        fundsCoin: '920',
      },
      missing: [{ marketId: legacy.id, kind: 'unavailable', reason: 'missing_config' }],
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(cursor);
      expect(result.data).toHaveLength(1);
      seen.push(result.data[0]!.marketId);
      cursor = result.meta.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([winning.market.id, losing.market.id, legacy.id].sort());
    expect((await page('bad cursor')).data.map((x) => x.marketId)).toEqual(
      (await page()).data.map((x) => x.marketId),
    );
    expect((await ready(winning.market.id)).risk.pnl).toMatchObject({
      kind: 'actual',
      amountCoin: '120',
    });
  });

  it('keeps unavailable assets separate from damaged assets and never hides a bad market in a full total', async () => {
    const { market } = await configured();
    await fundMarketMakerFunds(t.db, market.id, 100n);
    const account = (await findLedgerAccount(t.db, funds(market.id)))!;
    await damageActualCoinForTest(account.id, 1n);
    expect((await detail(market.id))!.risk).toEqual({ kind: 'inconsistent', reason: 'coin_gap' });
    expect(await overview()).toMatchObject({
      marketCount: '1',
      readyCount: '0',
      complete: false,
      totals: { worstLossCoin: '0', fundsCoin: '0' },
      missing: [{ marketId: market.id, kind: 'inconsistent', reason: 'coin_gap' }],
    });
  });

  it('does not block a market writer and holds one read-only snapshot across a capital commit', async () => {
    const { market } = await configured();
    await fundMarketMakerFunds(t.db, market.id, 100n);
    const holder = await t.db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [market.id]);
      await t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
        expect((await readMarketMakerMetrics(tx, market.id))!.risk.kind).toBe('ready');
      }, READ_ONLY);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const [first, second] = await t.db.transaction(async (tx) => {
      const first = await readMarketMakerMetrics(tx, market.id);
      await fundMarketMakerFunds(t.db, market.id, 25n);
      return [first, await readMarketMakerMetrics(tx, market.id)];
    }, READ_ONLY);
    expect(second!.risk).toEqual(first!.risk);
    expect((await ready(market.id)).risk).toMatchObject({
      assets: { coin: '125' },
      capital: { investedCoin: '125' },
    });
  });

  it('keeps cumulative capital wire values exact above the JSON safe-integer range', async () => {
    const { market } = await configured();
    const part = 999_999_999_999_999n;
    for (let i = 0; i < 10; i++) {
      await fundMarketMakerFunds(t.db, market.id, part);
      await recallLegacyCapital(market.id, part);
    }
    const current = await ready(market.id);
    expect(current.risk.capital).toEqual({
      investedCoin: String(part * 10n),
      recoveredCoin: String(part * 10n),
    });
    expect((await overview()).totals).toMatchObject({
      investedCoin: String(part * 10n),
      recoveredCoin: String(part * 10n),
      fundsCoin: '0',
    });
  });
});
