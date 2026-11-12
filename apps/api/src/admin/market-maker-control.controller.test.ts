import { schema, runMarketMakerCycle, requestMarketMakerRefresh } from '@buddha/db';
import {
  completeOnboarding,
  createOpenedMarket,
  createMarketPause,
  fundTestTreasury,
  ledgerSupply,
  openOrderIntake,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import { marketMakerControlWriteSchema, type MarketMakerControlChange } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';

const origin = 'http://localhost:3000';
const settings = {
  budgetCoin: 10_000n,
  maxLossCoin: 5000n,
  b: 100000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
describe.skipIf(!hasTestInfra)('market maker controls (integration)', () => {
  let t: TestApp;
  let asker: TestUser;
  let decider: TestUser;
  let marketId: string;
  let bookSpy: MockInstance<MarketPublisher['publishBook']>;
  let refreshSpy: MockInstance<MarketJobs['refreshMarketMaker']>;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    asker = await admin();
    decider = await admin();
    await openOrderIntake(t.db, { adminId: asker.id });
    marketId = (await createOpenedMarket(t.db, { liquiditySettings: settings })).market.id;
    refreshSpy = vi.spyOn(t.app.get(MarketJobs), 'refreshMarketMaker').mockResolvedValue();
    bookSpy = vi.spyOn(t.app.get(MarketPublisher), 'publishBook').mockResolvedValue();
  });
  async function admin() {
    const who = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await completeOnboarding(t.db, { userId: who.id });
    await t.app.get(AdminGuard).invalidate(who.id);
    return who;
  }
  const path = (suffix = '') =>
    `/api/v1/admin/markets/${marketId}/market-maker/control-requests${suffix}`;
  const post = (suffix: string, who = asker, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: path(suffix),
      headers: { origin, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...body },
    });
  const get = (suffix = '', who = asker) =>
    t.app.inject({ method: 'GET', url: path(suffix), headers: { cookie: who.cookie } });
  const data = (response: { json: <T>() => T }) =>
    marketMakerControlWriteSchema.parse(response.json<{ data: unknown }>().data);
  async function request(change: MarketMakerControlChange = { action: 'stop' }) {
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    const [runtime] = await t.db
      .select()
      .from(schema.marketMakerRuntime)
      .where(eq(schema.marketMakerRuntime.marketId, marketId));
    const response = await post('', asker, {
      reason: 'PRIVATE_CONTROL_REQUEST',
      baseVersion: market!.currentLiquidityVersion,
      baseControlGeneration: runtime!.controlGeneration.toString(),
      change,
    });
    expect(response.statusCode, response.body).toBe(200);
    return data(response);
  }
  const approve = (id: string, who = decider) =>
    post(`/${id}/approve`, who, { reason: 'PRIVATE_CONTROL_DECISION' });
  const increase: MarketMakerControlChange = {
    action: 'increase',
    additionalCoin: '1000',
    demand: {
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
      independentParticipants: 'PRIVATE_INDEPENDENT',
      bidirectionalTrading: 'PRIVATE_BIDIRECTIONAL',
      actualDemand: 'PRIVATE_DEMAND',
    },
  };

  it('fixes inputs, applies once after independent approval and publishes only committed book changes', async () => {
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
    const before = await ledgerSupply(t.db);
    const r = await request();
    expect(r.request.payload).toMatchObject({
      baseVersion: 1,
      baseControlGeneration: '1',
      beforeDesiredEnabled: true,
      demandSnapshot: null,
    });
    const book = bookSpy;
    book.mockImplementation(async () => {
      expect(await t.db.select().from(schema.marketMakerControls)).toHaveLength(
        book.mock.calls.length,
      );
    });
    const response = await approve(r.request.id);
    expect(response.statusCode, response.body).toBe(200);
    const saved = data(response);
    expect(saved.request).toMatchObject({
      status: 'approved',
      execution: { action: 'stop', beforeControlGeneration: '1', afterControlGeneration: '2' },
    });
    expect(saved.marketMaker.runtime).toMatchObject({
      desiredEnabled: false,
      controlGeneration: '2',
    });
    expect(book).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(await ledgerSupply(t.db)).toEqual(before);
    expect((await approve(r.request.id)).statusCode).toBe(409);
    expect(book).toHaveBeenCalledTimes(1);
    const resume = await request({ action: 'resume' });
    const resumed = await approve(resume.request.id);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(book).toHaveBeenCalledTimes(2);
    expect(data(resumed).marketMaker.runtime?.state).toBe('waiting');
  });
  it('keeps request reads, global lists and actual execution history private and keyset paginated', async () => {
    const a = await request();
    const b = await request();
    const first = await get('?status=all&limit=1');
    expect(first.statusCode).toBe(200);
    const p = first.json<{ data: { id: string }[]; meta: { nextCursor: string } }>();
    expect(p.data.map((r) => r.id)).toEqual([b.request.id]);
    const second = await get(`?status=all&limit=1&cursor=${encodeURIComponent(p.meta.nextCursor)}`);
    expect(second.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([a.request.id]);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/admin/market-maker/control-requests?status=all',
          headers: { cookie: asker.cookie },
        })
      ).json<{ data: unknown[] }>().data,
    ).toHaveLength(2);
    await approve(a.request.id);
    const history = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/markets/${marketId}/market-maker/control-history`,
      headers: { cookie: asker.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json<{ data: { approvalId: string }[] }>().data.map((r) => r.approvalId),
    ).toEqual([a.request.id]);
    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${marketId}` });
    expect(pub.statusCode).toBe(200);
    for (const value of [
      'PRIVATE_CONTROL_REQUEST',
      'PRIVATE_CONTROL_DECISION',
      a.request.id,
      'controlGeneration',
      'beforeConfig',
      'demandSnapshot',
    ])
      expect(pub.body).not.toContain(value);
  });
  it('requires admin onboarding and an explicitly matching account on every write', async () => {
    expect((await t.app.inject({ method: 'GET', url: path() })).statusCode).toBe(401);
    const member = await signUpTestUser(t);
    expect((await get('', member)).statusCode).toBe(403);
    const incomplete = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, incomplete.id));
    await t.app.get(AdminGuard).invalidate(incomplete.id);
    expect((await get('', incomplete)).statusCode).toBe(409);
    const r = await request();
    for (const action of ['approve', 'reject', 'retract']) {
      const response = await post(`/${r.request.id}/${action}`, decider, {
        expectedAccountId: asker.id,
        reason: 'different account',
      });
      expect(response.statusCode).toBe(403);
    }
    expect(await t.db.select().from(schema.marketMakerControls)).toEqual([]);
  });
  it('rejects self approval/rejection and another admin retraction, permitting own cleanup', async () => {
    const r = await request();
    expect((await approve(r.request.id, asker)).statusCode).toBe(409);
    expect((await post(`/${r.request.id}/reject`, asker, { reason: 'self' })).statusCode).toBe(409);
    expect((await post(`/${r.request.id}/retract`, decider)).statusCode).toBe(409);
    const ended = await post(`/${r.request.id}/retract`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(data(ended).request.status).toBe('retracted');
  });
  it('preserves treasury-insufficient requests pending then transfers the fixed delta after real issuance', async () => {
    const r = await request(increase);
    const before = await ledgerSupply(t.db);
    const fail = await approve(r.request.id);
    expect(fail.statusCode, fail.body).toBe(409);
    expect(fail.json()).toMatchObject({
      error: {
        code: 'MARKET_MAKER_CONTROL_NOT_ALLOWED',
        details: { reason: 'insufficient_treasury' },
      },
    });
    expect(data(await get(`/${r.request.id}`)).request.status).toBe('pending');
    expect(await ledgerSupply(t.db)).toEqual(before);
    expect(refreshSpy).not.toHaveBeenCalled();
    await fundTestTreasury(t.db, 1000n);
    const supply = await ledgerSupply(t.db);
    const success = await approve(r.request.id);
    expect(success.statusCode, success.body).toBe(200);
    expect(data(success).request.execution).toMatchObject({
      additionalCoin: '1000',
      afterVersion: 2,
    });
    expect(await ledgerSupply(t.db)).toEqual(supply);
  });
  it('does not stale a request on ordinary worker generations but does on another control', async () => {
    const a = await request();
    const b = await request();
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, marketId));
    expect((await approve(a.request.id)).statusCode).toBe(200);
    const stale = await approve(b.request.id);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { details: { reason: 'stale' } } });
    const rejected = await post(`/${b.request.id}/reject`, decider, { reason: 'stale cleanup' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(data(rejected).request.status).toBe('rejected');
  });
  it('rejects revoked requester approval while a different current admin can reject', async () => {
    const r = await request();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, asker.id));
    const response = await approve(r.request.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { details: { reason: 'requester' } } });
    expect(
      (await post(`/${r.request.id}/reject`, decider, { reason: 'requester unavailable' }))
        .statusCode,
    ).toBe(200);
  });
  it('cleans up on a broken allocated balance with no asset checks or economic events', async () => {
    const a = await request();
    const b = await request();
    const [funds] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(eq(schema.ledgerAccounts.marketId, marketId));
    await withLedgerGuardsOff(async (client) => {
      await client.query('DELETE FROM balances WHERE account_id=$1', [funds!.id]);
    });
    const before = await t.db.select().from(schema.ledgerEntries);
    expect((await get(`/${a.request.id}`)).statusCode).toBe(200);
    const reject = await post(`/${a.request.id}/reject`, decider, {
      reason: 'broken asset cleanup',
    });
    expect(reject.statusCode, reject.body).toBe(200);
    const retract = await post(`/${b.request.id}/retract`);
    expect(retract.statusCode, retract.body).toBe(200);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(before);
    expect(await t.db.select().from(schema.marketMakerControls)).toEqual([]);
    expect(bookSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
  it('refuses a now-held market atomically without changing pending requests, orders or capital', async () => {
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
    const r = await request();
    await createMarketPause(t.db, { marketId, by: asker.id, reason: 'ledger_failure' });
    const before = await t.db.select().from(schema.balances);
    const response = await approve(r.request.id);
    expect(response.statusCode).toBe(409);
    expect(await t.db.select().from(schema.balances)).toEqual(before);
    expect(await t.db.select().from(schema.marketMakerControls)).toEqual([]);
    expect(bookSpy).not.toHaveBeenCalled();
  });
  it('rejects malformed/extra inputs and invalid cross-field settings without creating a request', async () => {
    for (const change of [
      {
        action: 'settings',
        settings: { maxLossCoin: '10001', levels: 1, quantity: 1, safetyTicks: 0 },
      },
      {
        action: 'increase',
        additionalCoin: '0',
        demand: increase.action === 'increase' ? increase.demand : {},
      },
      { action: 'stop', desiredEnabled: false },
    ]) {
      const response = await post('', asker, {
        reason: 'invalid',
        baseVersion: 1,
        baseControlGeneration: '1',
        change,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
    expect(
      await t.db
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.kind, 'market_maker_control')),
    ).toEqual([]);
  });
  it('rolls approval and execution back if a later audit write fails and emits no event', async () => {
    const r = await request();
    const publisher = bookSpy;
    // A later mandatory audit failure aborts the whole approval transaction.
    const service = t.app.get(
      (await import('./market-maker-control.service.js')).MarketMakerControlService,
    );
    const spy = vi
      .spyOn(service as unknown as { audit: () => Promise<void> }, 'audit')
      .mockRejectedValue(new Error('audit unavailable'));
    const before = await ledgerSupply(t.db);
    const failed = await approve(r.request.id);
    expect(failed.statusCode).toBe(500);
    spy.mockRestore();
    expect(data(await get(`/${r.request.id}`)).request.status).toBe('pending');
    expect(await ledgerSupply(t.db)).toEqual(before);
    expect(await t.db.select().from(schema.marketMakerControls)).toEqual([]);
    expect(publisher).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
