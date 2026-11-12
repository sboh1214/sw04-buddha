import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createStartGrant,
  openOrderIntake,
  placeTestOrder,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import { adminClassifiableFillSchema, fillClassificationWriteSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { FillClassificationService } from './fill-classification.service.js';

const origin = 'http://localhost:3000';
const reason = 'CLASSIFICATION_PRIVATE_REQUEST_SENTINEL';
const decision = 'CLASSIFICATION_PRIVATE_APPROVAL_SENTINEL';
describe.skipIf(!hasTestInfra)('fixed fill classification API (#132)', () => {
  let t: TestApp;
  let asker: TestUser, decider: TestUser, third: TestUser, member: TestUser, other: TestUser;
  let market: typeof schema.markets.$inferSelect;
  let fillId: string;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    asker = await person(true);
    decider = await person(true);
    third = await person(true);
    member = await person();
    other = await person();
    await createStartGrant(t.db, { userId: member.id, amountCoin: 10000n });
    await createStartGrant(t.db, { userId: other.id, amountCoin: 10000n });
    await openOrderIntake(t.db, { adminId: asker.id });
    market = await createMarket(t.db, { createdBy: asker.id });
    fillId = await pair();
  });
  async function person(admin = false) {
    const who = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: who.id });
    if (admin) {
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, who.id));
      await t.app.get(AdminGuard).invalidate(who.id);
    }
    return who;
  }
  async function pair() {
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: other.id,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 40,
      qty: 1,
      timeInForce: 'gtc',
    });
    const done = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: member.id,
      outcome: 'YES',
      side: 'buy',
      limitPriceCoin: 60,
      qty: 1,
      timeInForce: 'gtc',
    });
    if (done.kind !== 'placed' || done.fills.length !== 1) throw new Error('actual fill required');
    return String(done.fills[0]!.id);
  }
  const base = () => `/api/v1/admin/fills/${fillId}`;
  const get = (path = '', who: TestUser | undefined = asker) =>
    t.app.inject({
      method: 'GET',
      url: `${base()}${path}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const post = (path: string, who = asker, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `${base()}${path}`,
      headers: { origin, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...body },
    });
  const parse = (r: { json: <T>() => T }) =>
    fillClassificationWriteSchema.parse(r.json<{ data: unknown }>().data);
  async function request(action: 'mark' | 'clear' = 'mark', by = asker) {
    const fill = adminClassifiableFillSchema.parse(
      (await get('', by)).json<{ data: unknown }>().data,
    );
    const response = await post('/classification-requests', by, {
      action,
      baseRevision: fill.classificationRevision,
      reason,
    });
    expect(response.statusCode, response.body).toBe(200);
    return parse(response);
  }
  const approve = (id: string, by = decider) =>
    post(`/classification-requests/${id}/approve`, by, { reason: decision });
  async function economics() {
    return {
      fills: await t.db.select().from(schema.fills).orderBy(schema.fills.id),
      orders: await t.db.select().from(schema.orders).orderBy(schema.orders.id),
      ledger: await t.db.select().from(schema.ledgerEntries).orderBy(schema.ledgerEntries.id),
      balances: await t.db.select().from(schema.balances).orderBy(schema.balances.accountId),
      positions: await t.db
        .select()
        .from(schema.positions)
        .orderBy(schema.positions.userId, schema.positions.marketId, schema.positions.outcome),
    };
  }
  async function row() {
    return (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]!;
  }

  it('commits a fixed mark once, emits only generic statistics after COMMIT, and clears via another immutable approval', async () => {
    const before = await economics();
    const original = await row();
    const requested = await request();
    const publish = vi
      .spyOn(t.app.get(MarketPublisher), 'publishMarket')
      .mockImplementation(async (id, event) => {
        expect(id).toBe(market.id);
        expect(event.type).toBe('market:stats');
        expect(await t.db.select().from(schema.fillClassifications)).toHaveLength(
          publish.mock.calls.length,
        );
        expect(event).not.toHaveProperty('reason');
        expect(event).not.toHaveProperty('classificationRevision');
      });
    const response = await approve(requested.request.id);
    expect(response.statusCode, response.body).toBe(200);
    const marked = parse(response);
    expect(marked.fill).toMatchObject({ excluded: true, classificationRevision: '1' });
    expect(await row()).toMatchObject({
      traderCount: 0,
      tradeCount: original.tradeCount,
      volumeCoin: original.volumeCoin,
      lastPrice: original.lastPrice,
      lastFillAt: original.lastFillAt,
    });
    expect(await economics()).toEqual(before);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await approve(requested.request.id, third)).statusCode).toBe(409);
    expect(publish).toHaveBeenCalledTimes(1);
    const clearing = await request('clear');
    const cleared = await approve(clearing.request.id);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(parse(cleared).fill).toMatchObject({ excluded: false, classificationRevision: '2' });
    expect((await row()).traderCount).toBe(2);
    expect(await economics()).toEqual(before);
    expect(publish).toHaveBeenCalledTimes(2);
    const history = await get('/classification-history?limit=1');
    expect(history.statusCode).toBe(200);
    const first = history.json<{ data: { action: string }[]; meta: { nextCursor: string } }>();
    expect(first.data[0]?.action).toBe('clear');
    const last = await get(
      `/classification-history?limit=1&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
    );
    expect(last.json<{ data: { action: string }[] }>().data[0]?.action).toBe('mark');
  });
  it('keeps identities, private evidence and classifications off every public market projection', async () => {
    const requested = await request();
    expect((await approve(requested.request.id)).statusCode).toBe(200);
    for (const url of [
      `/api/v1/markets/${market.slug}`,
      '/api/v1/markets?sort=recommended',
      '/api/v1/markets?sort=volume',
      `/api/v1/markets/${market.id}/fills`,
      `/api/v1/markets/${market.id}/ticks`,
    ]) {
      const response = await t.app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      for (const forbidden of [
        reason,
        decision,
        asker.id,
        decider.id,
        requested.request.id,
        'classificationRevision',
        'classificationCutoff',
        'excluded',
        'fillClassifications',
      ])
        expect(response.body, `${url}: ${forbidden}`).not.toContain(forbidden);
    }
    const detail = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.slug}` });
    expect(
      detail.json<{ data: { traderCount: number; tradeCount: number; volumeCoin: string } }>().data,
    ).toMatchObject({ traderCount: 0, tradeCount: 1, volumeCoin: '60' });
  });
  it('blocks self approval, replacement payload, stale account and malformed path before any write', async () => {
    const requested = await request();
    const before = await economics();
    expect((await approve(requested.request.id, asker)).statusCode).toBe(409);
    expect(
      (
        await post(`/classification-requests/${requested.request.id}/approve`, decider, {
          reason: decision,
          action: 'clear',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/classification-requests', asker, {
          action: 'mark',
          baseRevision: '0',
          reason,
          expectedAccountId: decider.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/admin/fills/9007199254740992',
          headers: { cookie: asker.cookie },
        })
      ).statusCode,
    ).toBe(400);
    expect((await get('/classification-requests/not-a-uuid')).statusCode).toBe(400);
    expect(await t.db.select().from(schema.fillClassifications)).toEqual([]);
    expect(await economics()).toEqual(before);
  });
  it('requires a current independent requester and approver even after the session guard cached admin status', async () => {
    const first = await request();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, asker.id));
    expect((await approve(first.request.id)).statusCode).toBe(409);
    const pending = await request('mark', third);
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, decider.id));
    expect((await approve(pending.request.id)).statusCode).toBe(403);
    expect(await t.db.select().from(schema.fillClassifications)).toEqual([]);
  });
  it('allows cleanup of stale requests without asking for healthy assets or changing their records', async () => {
    const left = await request(),
      right = await request();
    expect((await approve(left.request.id)).statusCode).toBe(200);
    await withLedgerGuardsOff(async (owner) => {
      await owner.query('DELETE FROM balances WHERE user_id=$1', [member.id]);
    });
    const before = await economics();
    const publish = vi
      .spyOn(t.app.get(MarketPublisher), 'publishMarket')
      .mockResolvedValue(undefined);
    expect(
      (
        await post(`/classification-requests/${right.request.id}/reject`, third, {
          reason: '더 이상 유효하지 않은 요청',
        })
      ).statusCode,
    ).toBe(200);
    const clearing = await request('clear');
    expect(
      (await post(`/classification-requests/${clearing.request.id}/retract`, asker)).statusCode,
    ).toBe(200);
    expect(await economics()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });
  it('rolls back approval, execution, stats and audit without an event when the response snapshot fails', async () => {
    const requested = await request();
    const before = await row();
    const economicsBefore = await economics();
    const publish = vi
      .spyOn(t.app.get(MarketPublisher), 'publishMarket')
      .mockResolvedValue(undefined);
    const service: FillClassificationService = t.app.get(FillClassificationService);
    vi.spyOn(
      service as unknown as { snapshot: () => Promise<unknown> },
      'snapshot',
    ).mockRejectedValueOnce(new Error('fixture projection failure'));
    expect((await approve(requested.request.id)).statusCode).toBe(500);
    expect(await row()).toEqual(before);
    expect(await economics()).toEqual(economicsBefore);
    expect(await t.db.select().from(schema.fillClassifications)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(
      (
        await t.db
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.id, requested.request.id))
      )[0]?.status,
    ).toBe('pending');
  });
  it('lets only one competing fixed request approve and keeps the loser pending', async () => {
    const a = await request(),
      b = await request();
    const responses = await Promise.all([
      approve(a.request.id, decider),
      approve(b.request.id, third),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await t.db.select().from(schema.fillClassifications)).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.kind, 'fill_classification'));
    expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'pending']);
  });
  it.each(['recommended', 'volume'])(
    'pins the internal exclusion prefix through public %s pagination without exposing it',
    async (sort) => {
      const firstMarket = market;
      market = await createMarket(t.db, { createdBy: asker.id });
      const otherMarket = market;
      const one = await pair(),
        two = await pair();
      const list = (cursor?: string) =>
        t.app.inject({
          method: 'GET',
          url: `/api/v1/markets?sort=${sort}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
      const before = await list();
      expect(before.statusCode, before.body).toBe(200);
      const first = before.json<{ data: { id: string }[]; meta: { nextCursor: string } }>();
      expect(first.data[0]?.id).toBe(otherMarket.id);
      for (const target of [one, two]) {
        fillId = target;
        const requested = await request();
        expect((await approve(requested.request.id)).statusCode).toBe(200);
      }
      const second = await list(first.meta.nextCursor);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([
        firstMarket.id,
      ]);
      expect((await list()).json<{ data: { id: string }[] }>().data[0]?.id).toBe(firstMarket.id);
      expect(Buffer.from(first.meta.nextCursor, 'base64url').toString()).not.toContain(
        otherMarket.id,
      );
      const malformed = await list(first.meta.nextCursor.slice(0, -4) + 'AAAA');
      expect(malformed.statusCode, malformed.body).toBe(200);
    },
  );
  it('allows only admins and requires onboarding for every read/write surface', async () => {
    for (const path of ['', '/classification-requests', '/classification-history']) {
      expect((await t.app.inject({ method: 'GET', url: `${base()}${path}` })).statusCode).toBe(401);
      expect((await get(path, member)).statusCode).toBe(403);
    }
    const fresh = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, fresh.id));
    await t.app.get(AdminGuard).invalidate(fresh.id);
    const unonboarded = await get('', fresh);
    expect(unonboarded.statusCode).toBe(409);
    expect(unonboarded.json()).toMatchObject({ error: { code: 'ONBOARDING_REQUIRED' } });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/admin/fill-classifications/requests',
          headers: { cookie: member.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });
});
