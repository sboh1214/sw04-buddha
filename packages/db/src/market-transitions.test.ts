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
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const market = await createMarket(t.db, { status: 'closed' });
    const at = new Date('2026-11-02T03:04:05.678Z');
    const eventId = await t.db.transaction((tx) =>
      transitionMarket(tx, {
        marketId: market.id,
        from: 'closed',
        to: 'resolved',
        type: 'resolved',
        actorId: admin.id,
        payload: { result: 'YES' },
        at,
        set: { resolvedResult: 'YES', resolvedAt: at },
      }),
    );
    expect(await eventsOf(market.id)).toEqual([
      expect.objectContaining({
        id: eventId,
        type: 'resolved',
        actorId: admin.id,
        fromStatus: 'closed',
        toStatus: 'resolved',
        payload: { result: 'YES' },
        createdAt: at,
      }),
    ]);
    const [row] = await t.db.select().from(markets).where(eq(markets.id, market.id));
    expect(row).toMatchObject({
      status: 'resolved',
      statusEventId: eventId,
      updatedAt: at,
      resolvedResult: 'YES',
      resolvedAt: at,
    });
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
