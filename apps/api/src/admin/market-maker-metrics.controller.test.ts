import { findLedgerAccount, runMarketMakerCycle, schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createOpenedMarket,
  createUser,
  damageActualCoinForTest,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  setReleaseSetting,
} from '@buddha/db/test';
import {
  adminMarketMakerMetricsListItemSchema,
  adminMarketMakerMetricsOverviewSchema,
  adminMarketMakerMetricsSchema,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const base = '/api/v1/admin/market-makers';
const detailPath = (id: string) => `/api/v1/admin/markets/${id}/market-maker/metrics`;

describe.skipIf(!hasTestInfra)('private current MM metrics (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    await completeOnboarding(t.db, { userId: admin.id });
    await t.app.get(AdminGuard).invalidate(admin.id);
  });
  const get = (url: string) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
  async function facts() {
    return {
      accounts: await t.db.select().from(schema.ledgerAccounts),
      ledger: await t.db.select().from(schema.ledgerEntries),
      allocations: await t.db.select().from(schema.marketMakerAllocations),
      runtime: await t.db.select().from(schema.marketMakerRuntime),
      settings: await t.db.select().from(schema.releaseSettings),
      holds: await t.db.select().from(schema.reconciliationHolds),
      results: await t.db.select().from(schema.reconciliationResults),
      audit: await t.db.select().from(schema.adminActions),
      supplyStates: await t.db
        .select()
        .from(schema.marketMakerSupplyStates)
        .orderBy(schema.marketMakerSupplyStates.marketId),
      supplyIntervals: await t.db
        .select()
        .from(schema.marketMakerSupplyIntervals)
        .orderBy(schema.marketMakerSupplyIntervals.id),
    };
  }

  it('reads an unprepared market and empty overview without allocating, repairing or defaulting N', async () => {
    const market = await createMarket(t.db);
    const before = await facts();
    const response = await get(detailPath(market.id));
    expect(response.statusCode, response.body).toBe(200);
    const detail = adminMarketMakerMetricsSchema.parse(response.json<{ data: unknown }>().data);
    expect(detail.risk.kind).toBe('unavailable');
    expect(detail.concentration.setting).toMatchObject({ status: 'undecided', value: null });
    expect(detail.concentration.YES.holders).toBeNull();
    expect(detail.concentration.YES.topShareBp).toBeNull();
    const list = await get(base);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
    const overviewResponse = await get(`${base}/overview`);
    expect(overviewResponse.statusCode, overviewResponse.body).toBe(200);
    const overview = adminMarketMakerMetricsOverviewSchema.parse(
      overviewResponse.json<{ data: unknown }>().data,
    );
    expect(overview).toMatchObject({
      marketCount: '0',
      readyCount: '0',
      complete: true,
      treasury: { status: 'uninitialized' },
    });
    expect(await facts()).toEqual(before);
  });

  it('pages funded markets without duplicates while the overview covers every funded market', async () => {
    const first = await createOpenedMarket(t.db);
    const second = await createOpenedMarket(t.db);
    await createMarket(t.db); // an unallocated draft does not enlarge funded totals
    const before = await facts();
    const response = await get(`${base}?limit=1`);
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<{ data: unknown[]; meta: { nextCursor: string | null } }>();
    const item = adminMarketMakerMetricsListItemSchema.parse(page.data[0]);
    expect(page.data).toHaveLength(1);
    expect(page.meta.nextCursor).not.toBeNull();
    const nextResponse = await get(
      `${base}?limit=1&cursor=${encodeURIComponent(page.meta.nextCursor!)}`,
    );
    expect(nextResponse.statusCode, nextResponse.body).toBe(200);
    const next = nextResponse.json<{ data: unknown[]; meta: { nextCursor: string | null } }>();
    expect(next.data).toHaveLength(1);
    const nextItem = adminMarketMakerMetricsListItemSchema.parse(next.data[0]);
    expect([item.marketId, nextItem.marketId].sort()).toEqual(
      [first.market.id, second.market.id].sort(),
    );
    expect(next.meta.nextCursor).toBeNull();
    const overviewResponse = await get(`${base}/overview`);
    const overview = adminMarketMakerMetricsOverviewSchema.parse(
      overviewResponse.json<{ data: unknown }>().data,
    );
    expect(overview).toMatchObject({
      marketCount: '2',
      readyCount: '2',
      complete: true,
      missing: [],
    });
    expect(await facts()).toEqual(before);
  });

  it('returns only current nicknames and admin account identifiers for configured human concentration', async () => {
    const { market } = await createOpenedMarket(t.db);
    const a = (await createUser(t.db, { balanceCoin: 1_000n })).user;
    const b = (await createUser(t.db, { balanceCoin: 1_000n })).user;
    const c = (await createUser(t.db, { balanceCoin: 1_000n })).user;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: a.id,
      noHolderId: c.id,
      qty: 3,
      yesPriceCoin: 50,
    });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: b.id,
      noHolderId: c.id,
      qty: 1,
      yesPriceCoin: 50,
    });
    await setReleaseSetting(t.db, {
      adminId: admin.id,
      key: 'market_maker.concentration_top_n',
      value: 1,
      status: 'test',
    });
    const response = await get(detailPath(market.id));
    expect(response.statusCode, response.body).toBe(200);
    const detail = adminMarketMakerMetricsSchema.parse(response.json<{ data: unknown }>().data);
    expect(detail.concentration.YES).toMatchObject({
      totalQty: '4',
      topQty: '3',
      topShareBp: '7500',
      holders: [{ userId: a.id, qty: '3', shareBp: '7500' }],
    });
    expect(Object.keys(detail.concentration.YES.holders![0]!).sort()).toEqual([
      'nickname',
      'qty',
      'shareBp',
      'userId',
    ]);
    for (const person of [a, b, c]) expect(response.body).not.toContain(person.email);
    const publicResponse = await t.app.inject({
      method: 'GET',
      url: `/api/v1/markets/${market.id}`,
    });
    expect(publicResponse.statusCode, publicResponse.body).toBe(200);
    for (const key of ['concentration', 'risk', 'capital', 'investedCoin', 'reservedWorstLossCoin'])
      expect(publicResponse.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty(key);
  });

  it('reports a damaged market as incomplete without writing an audit or hiding it as zero risk', async () => {
    const { market } = await createOpenedMarket(t.db);
    const funds = await findLedgerAccount(t.db, {
      kind: 'market_maker_funds',
      marketId: market.id,
    });
    await damageActualCoinForTest(funds!.id, 1n);
    const before = await facts();
    const response = await get(detailPath(market.id));
    expect(response.statusCode, response.body).toBe(200);
    const detail = adminMarketMakerMetricsSchema.parse(response.json<{ data: unknown }>().data);
    expect(detail.risk.kind).toBe('inconsistent');
    const overviewResponse = await get(`${base}/overview`);
    const overview = adminMarketMakerMetricsOverviewSchema.parse(
      overviewResponse.json<{ data: unknown }>().data,
    );
    expect(overview.complete).toBe(false);
    expect(overview.missing).toEqual([
      expect.objectContaining({ marketId: market.id, kind: 'inconsistent' }),
    ]);
    expect(await facts()).toEqual(before);
  });

  it('returns cumulative posted facts only to admins and leaves the supply history unchanged on GET', async () => {
    await openOrderIntake(t.db, { adminId: admin.id });
    const { market } = await createOpenedMarket(t.db, {
      liquiditySettings: {
        budgetCoin: 10_000n,
        maxLossCoin: 5_000n,
        b: 100_000,
        levels: 3,
        quantity: 10,
        safetyTicks: 1,
      },
    });
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId: market.id }));
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user;
    await placeTestOrder(t.db, {
      ownerId: person.id,
      marketId: market.id,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
      qty: 4,
    });
    const before = await facts();
    const response = await get(detailPath(market.id));
    expect(response.statusCode, response.body).toBe(200);
    const detail = adminMarketMakerMetricsSchema.parse(response.json<{ data: unknown }>().data);
    expect(detail.period.activity).toEqual({
      basis: 'recorded_orders',
      coverage: 'complete',
      bot: { postedQty: '20', filledQty: '4', fillBp: '2000' },
      humanIoc: { orders: '1', filledOrders: '1', fillBp: '10000' },
    });
    expect(detail.period.supply.coverage).toBe('complete');
    expect(detail.period.supply.openMs).not.toBeNull();
    expect(await facts()).toEqual(before);
    for (const hidden of [person.id, person.email, 'lastObservedTxid', 'supplyIntervals'])
      expect(response.body).not.toContain(hidden);
    const publicResponse = await t.app.inject({
      method: 'GET',
      url: `/api/v1/markets/${market.id}`,
    });
    expect(publicResponse.statusCode).toBe(200);
    const publicData = publicResponse.json<{ data: Record<string, unknown> }>().data;
    for (const key of [
      'period',
      'activity',
      'supply',
      'postedQty',
      'fillBp',
      'botGapMs',
      'combinedGapMs',
    ])
      expect(publicData).not.toHaveProperty(key);
  });

  it('guards all three routes before reading private state and validates ids and page size', async () => {
    const market = await createMarket(t.db);
    const member = await signUpTestUser(t);
    for (const url of [base, `${base}/overview`, detailPath(market.id)]) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await t.app.inject({ method: 'GET', url, headers: { cookie: member.cookie } })).statusCode,
      ).toBe(403);
    }
    expect((await get(`${base}?limit=0`)).statusCode).toBe(400);
    expect((await get(detailPath('not-a-uuid'))).statusCode).toBe(400);
    expect((await get(detailPath('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
  });
});
