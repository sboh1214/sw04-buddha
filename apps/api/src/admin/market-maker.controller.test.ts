import {
  lockMarket,
  openScheduledMarket,
  recallMarketMakerFunds,
  recordMarketMakerOpenAttempt,
  recordMarketMakerRun,
  requestMarketMakerRefresh,
  schema,
} from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createMarketMakerAccount,
  createOpenedMarket,
  createScheduledMarket,
  setReleaseSetting,
  closeTestMarket,
  passMarketClose,
} from '@buddha/db/test';
import { adminMarketMakerSchema, treasuryIssueWriteSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const origin = 'http://localhost:3000';
describe.skipIf(!hasTestInfra)('private market maker observations (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let approver: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await makeAdmin();
    approver = await makeAdmin();
  });
  async function makeAdmin() {
    const who = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await completeOnboarding(t.db, { userId: who.id });
    await t.app.get(AdminGuard).invalidate(who.id);
    return who;
  }
  const get = (id: string, who = admin) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/markets/${id}/market-maker`,
      headers: { cookie: who.cookie },
    });
  const detail = (response: { json: <T>() => T }) =>
    adminMarketMakerSchema.parse(response.json<{ data: unknown }>().data);
  async function stages(reduce = 6_000, halt = 8_000) {
    for (const [key, value, status] of [
      ['market_maker.reduce_at_bp', reduce, 'proposal'],
      ['market_maker.halt_at_bp', halt, 'test'],
      ['market_maker.reduce_ratio_bp', 2_500, 'approved'],
      ['order.accepting', true, 'test'],
    ] as const)
      await setReleaseSetting(t.db, { adminId: admin.id, key, value, status });
  }
  async function fundTreasury() {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/treasury/issue-requests',
      headers: { origin, cookie: admin.cookie },
      payload: {
        expectedAccountId: admin.id,
        amountCoin: 10_000n.toString(),
        reason: 'Explicit runtime fixture treasury',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const request = treasuryIssueWriteSchema.parse(response.json<{ data: unknown }>().data).request;
    const approved = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/treasury/issue-requests/${request.id}/approve`,
      headers: { origin, cookie: approver.cookie },
      payload: { expectedAccountId: approver.id, reason: 'Independent fixture approval' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
  }

  it('reads a legacy OPEN market without backfilling money, config or runtime', async () => {
    const market = await createMarket(t.db, { status: 'open' });
    const accounts = await t.db.select().from(schema.ledgerAccounts);
    const response = await get(market.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(detail(response)).toMatchObject({
      marketId: market.id,
      config: null,
      openedVersion: null,
      runtime: null,
      lastOpenAttempt: null,
      recall: { status: 'not_due' },
      stageSettings: { status: 'undecided' },
    });
    expect(detail(response).readiness.blockers).toEqual([
      'liquidity_missing',
      'risk_settings_missing',
      'intake_closed',
      'not_allocated',
    ]);
    expect(await t.db.select().from(schema.ledgerAccounts)).toEqual(accounts);
    expect(await t.db.select().from(schema.marketMakerRuntime)).toEqual([]);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual([]);
  });

  it('reads a terminal pending recall without performing it, then reports the immutable transfer', async () => {
    const { market } = await createOpenedMarket(t.db);
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    const entries = await t.db.select().from(schema.ledgerEntries);
    expect(detail(await get(market.id)).recall).toEqual({ status: 'pending' });
    expect(await t.db.select().from(schema.marketMakerRecalls)).toEqual([]);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(entries);

    const result = await t.db.transaction((tx) =>
      recallMarketMakerFunds(tx, { marketId: market.id }),
    );
    if (result.outcome !== 'recalled') throw new Error('Expected a real terminal transfer');
    const beforeRead = await t.db.select().from(schema.ledgerEntries);
    const observed = detail(await get(market.id));
    expect(observed.recall).toEqual({
      status: 'completed',
      outcome: 'transferred',
      terminalStatus: 'cancelled',
      amountCoin: result.recall.amountCoin.toString(),
      ledgerEntryId: String(result.recall.ledgerEntryId),
      completedAt: result.recall.completedAt.toISOString(),
    });
    expect(observed.recall).not.toHaveProperty('appliedTxid');
    expect(observed.recall).not.toHaveProperty('fundsAccountId');
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(beforeRead);
    const publicMarket = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
    expect(publicMarket.statusCode, publicMarket.body).toBe(200);
    expect(publicMarket.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty(
      'recall',
    );
  });

  it('reports a never-allocated completion without inventing a zero-valued ledger entry', async () => {
    const market = await createMarket(t.db, { status: 'cancelled' });
    const result = await t.db.transaction((tx) =>
      recallMarketMakerFunds(tx, { marketId: market.id }),
    );
    expect(result.outcome).toBe('recalled');
    expect(detail(await get(market.id)).recall).toMatchObject({
      status: 'completed',
      outcome: 'not_allocated',
      terminalStatus: 'cancelled',
      amountCoin: '0',
      ledgerEntryId: null,
    });
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual([]);
  });

  it('separates historical opening shortage from the current settings and treasury', async () => {
    const { market } = await createScheduledMarket(t.db, {
      liquidityReason: 'PRIVATE_LIQUIDITY_REASON',
    });
    const at = new Date();
    await t.db.transaction((tx) =>
      recordMarketMakerOpenAttempt(tx, {
        marketId: market.id,
        reason: 'treasury_insufficient',
        requiredCoin: 10_000n,
        availableCoin: 1n,
        liquidityVersion: 1,
        at,
      }),
    );
    await stages();
    await fundTreasury();
    const response = await get(market.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(detail(response)).toMatchObject({
      config: { version: 1, reason: 'PRIVATE_LIQUIDITY_REASON' },
      runtime: null,
      stageSettings: {
        status: 'ready',
        reduceAtBp: { status: 'proposal', value: 6_000 },
        haltAtBp: { status: 'test', value: 8_000 },
      },
      readiness: { blockers: ['market_not_open', 'not_allocated'] },
      lastOpenAttempt: {
        reason: 'treasury_insufficient',
        availableCoin: '1',
        lastAttemptAt: at.toISOString(),
        succeededAt: null,
      },
    });
    expect(await t.db.select().from(schema.marketMakerAllocations)).toEqual([]);
    const publicMarket = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
    expect(publicMarket.statusCode, publicMarket.body).toBe(200);
    for (const privatePart of [
      'PRIVATE_LIQUIDITY_REASON',
      'treasury_insufficient',
      'marketMaker',
      'desiredEnabled',
      'stageSettings',
      'lastOpenAttempt',
      'budgetCoin',
      'maxLossCoin',
    ])
      expect(publicMarket.body).not.toContain(privatePart);
  });

  it('reports incompatible stage values as unavailable without replacing them or allocating', async () => {
    const market = await createMarket(t.db);
    await stages(8_001, 8_000);
    const response = await get(market.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(detail(response).stageSettings).toMatchObject({
      status: 'invalid',
      reduceAtBp: { value: 8_001 },
      haltAtBp: { value: 8_000 },
    });
    expect(detail(response).readiness.blockers).toContain('risk_settings_invalid');
    expect(await t.db.select().from(schema.marketMakerRuntime)).toEqual([]);
  });

  it('serializes allocated runtime generations exactly and keeps errors private without changing desired state', async () => {
    await stages();
    await createMarketMakerAccount(t.db);
    await fundTreasury();
    const { market } = await createScheduledMarket(t.db);
    const opened = await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const [current] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id))
        .for('update');
      return openScheduledMarket(tx, {
        market: current!,
        now: new Date(),
        actorId: null,
        source: 'job',
      });
    });
    expect(opened.opened).toBe(true);
    const refreshed = await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    expect(refreshed).not.toBeNull();
    const generation = refreshed!.generation;
    await t.db.transaction((tx) =>
      recordMarketMakerRun(tx, {
        marketId: market.id,
        generation,
        outcome: 'error',
        reason: 'runtime_error',
        error: 'PRIVATE_RUNTIME_ERROR',
        startedAt: new Date(),
      }),
    );
    const response = await get(market.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(detail(response)).toMatchObject({
      openedVersion: 1,
      runtime: {
        desiredEnabled: true,
        generation: String(generation),
        completedGeneration: '0',
        state: 'error',
        reason: 'runtime_error',
        lastError: 'PRIVATE_RUNTIME_ERROR',
        consecutiveFailures: 1,
      },
    });
    const publicMarket = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
    expect(publicMarket.statusCode, publicMarket.body).toBe(200);
    expect(publicMarket.body).not.toContain('PRIVATE_RUNTIME_ERROR');
    expect(publicMarket.body).not.toContain('completedGeneration');
  });

  it('requires admin onboarding and leaves the public route shape unchanged', async () => {
    const market = await createMarket(t.db);
    const member = await signUpTestUser(t);
    expect((await get(market.id, member)).statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/admin/markets/${market.id}/market-maker`,
        })
      ).statusCode,
    ).toBe(401);
    const incomplete = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, incomplete.id));
    await t.app.get(AdminGuard).invalidate(incomplete.id);
    expect((await get(market.id, incomplete)).statusCode).toBe(409);
    expect((await get('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
