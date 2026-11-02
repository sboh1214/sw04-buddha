import { MARKET_STATUSES, canTransitionMarket } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketTransitionError, transitionMarket } from './market-transitions.js';
import { marketEvents, markets } from './schema/index.js';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

describe.skipIf(!hasTestDb())('transitionMarket (#174, docker test profile)', () => {
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

  const eventsOf = (marketId: string) =>
    t.db.select().from(marketEvents).where(eq(marketEvents.marketId, marketId));

  it('writes who, when, from and to, and keys the market on that event', async () => {
    // The judgement's publication (#152) as the shape of an admin's transition with columns set
    // beside the status; `approveMarketJudgement` (market-judgement.test.ts) is the real one.
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const market = await createMarket(t.db, { status: 'closed' });
    const at = new Date('2026-11-02T03:04:05.678Z');
    const disputeDeadline = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    const eventId = await t.db.transaction((tx) =>
      transitionMarket(tx, {
        marketId: market.id,
        from: 'closed',
        to: 'provisional',
        type: 'provisional',
        actorId: admin.id,
        payload: { version: 1, result: 'YES' },
        at,
        set: { resolvedResult: 'YES', judgementVersion: 1, disputeDeadline },
      }),
    );
    expect(await eventsOf(market.id)).toEqual([
      expect.objectContaining({
        id: eventId,
        type: 'provisional',
        actorId: admin.id,
        fromStatus: 'closed',
        toStatus: 'provisional',
        payload: { version: 1, result: 'YES' },
        createdAt: at,
      }),
    ]);
    const [row] = await t.db.select().from(markets).where(eq(markets.id, market.id));
    expect(row).toMatchObject({
      status: 'provisional',
      statusEventId: eventId,
      updatedAt: at,
      resolvedResult: 'YES',
      judgementVersion: 1,
      disputeDeadline,
      resolvedAt: null,
    });
  });

  it('refuses the interim closed → resolved edge since #152 (ADR-0103)', async () => {
    // ADR-0046's immediate judgement by one admin is gone: a CLOSED market goes PROVISIONAL first,
    // and only the worker confirms it at its dispute deadline.
    expect(canTransitionMarket('closed', 'resolved')).toBe(false);
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const market = await createMarket(t.db, { status: 'closed' });
    await expect(
      t.db.transaction((tx) =>
        transitionMarket(tx, {
          marketId: market.id,
          from: 'closed',
          to: 'resolved',
          type: 'resolved',
          actorId: admin.id,
          payload: { result: 'YES' },
          at: new Date(),
          set: { resolvedResult: 'YES', resolvedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(new MarketTransitionError('closed', 'resolved'));
    expect(await eventsOf(market.id)).toEqual([]);
    const [row] = await t.db.select().from(markets).where(eq(markets.id, market.id));
    expect(row).toMatchObject({ status: 'closed', resolvedResult: null, resolvedAt: null });
  });

  it('records the worker as a null actor', async () => {
    const market = await createMarket(t.db, { status: 'resolved', resolvedResult: 'NO' });
    await t.db.transaction((tx) =>
      transitionMarket(tx, {
        marketId: market.id,
        from: 'resolved',
        to: 'settling',
        type: 'settling',
        actorId: null,
        at: new Date(),
      }),
    );
    expect(await eventsOf(market.id)).toEqual([
      expect.objectContaining({ actorId: null, fromStatus: 'resolved', toStatus: 'settling' }),
    ]);
  });

  it('refuses every pair the lifecycle does not allow, writing nothing', async () => {
    const refused = MARKET_STATUSES.flatMap((from) =>
      MARKET_STATUSES.filter((to) => !canTransitionMarket(from, to)).map((to) => [from, to]),
    );
    expect(refused.length).toBeGreaterThan(0);
    for (const [from, to] of refused) {
      const market = await createMarket(t.db, { status: from! });
      await expect(
        t.db.transaction((tx) =>
          transitionMarket(tx, {
            marketId: market.id,
            from: from!,
            to: to!,
            type: 'closed',
            actorId: null,
            at: new Date(),
          }),
        ),
      ).rejects.toBeInstanceOf(MarketTransitionError);
      expect(await eventsOf(market.id)).toEqual([]);
      const [row] = await t.db.select().from(markets).where(eq(markets.id, market.id));
      expect(row!.status).toBe(from);
    }
  });

  it('fails loudly, and rolls the event back, when the row is no longer in `from`', async () => {
    const market = await createMarket(t.db, { status: 'closed' });
    await expect(
      t.db.transaction((tx) =>
        transitionMarket(tx, {
          marketId: market.id,
          from: 'open',
          to: 'closed',
          type: 'closed',
          actorId: null,
          at: new Date(),
        }),
      ),
    ).rejects.toThrow(/no longer open/);
    expect(await eventsOf(market.id)).toEqual([]);
  });
});
