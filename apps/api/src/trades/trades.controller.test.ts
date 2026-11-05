/**
 * The caller's positions (PLAN 7.2; M3 design 3.5) against the docker `test` profile. Skips when
 * TEST_* are unset (fails under CI=true, see the harness). The orders and fills are
 * orders.controller.test.ts's (#119).
 *
 * Every row is written straight to its table, with the instants spelled out: the route sorts by
 * them, and back-to-back inserts may share a millisecond.
 */
import { schema } from '@buddha/db';
import { createMarket } from '@buddha/db/test';
import { type Outcome, type Position } from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

type MarketRow = typeof schema.markets.$inferSelect;

describe.skipIf(!hasTestInfra)('positions (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** Open, never traded: no price (N02 §5). */
  let market: MarketRow;
  /** One instant per test the rows below are stamped relative to. */
  let base: number;
  const at = (seconds: number) => new Date(base + seconds * 1_000);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
    market = await createMarket(t.db);
    base = Date.now() - 60_000;
  });

  async function insertPosition(input: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    qty: number;
    costBasisCoin?: bigint;
    realizedPnlCoin?: bigint;
    settled?: boolean;
    updatedAt: Date;
  }) {
    await t.db.insert(schema.positions).values({
      costBasisCoin: 0n,
      realizedPnlCoin: 0n,
      settled: false,
      ...input,
    });
  }

  it('GET /me/positions filters by status, newest change first, with the market price', async () => {
    const traded = await createMarket(t.db, { lastPrice: 62, tradeCount: 3 });
    const settledMarket = await createMarket(t.db, {
      status: 'settled',
      lastPrice: 80,
      resolvedResult: 'YES',
    });
    // A row outlives its contracts: qty 0 after a full sell, realised PnL kept.
    await insertPosition({
      userId: user.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      realizedPnlCoin: -40n,
      updatedAt: at(1),
    });
    await insertPosition({
      userId: user.id,
      marketId: traded.id,
      outcome: 'NO',
      qty: 5,
      costBasisCoin: 190n,
      updatedAt: at(2),
    });
    await insertPosition({
      userId: user.id,
      marketId: settledMarket.id,
      outcome: 'YES',
      qty: 0,
      realizedPnlCoin: 700n,
      settled: true,
      updatedAt: at(3),
    });
    // Somebody else's row never shows.
    const stranger = await signUpTestUser(t);
    await insertPosition({
      userId: stranger.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 3,
      updatedAt: at(4),
    });

    const list = async (query = '') => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/positions${query}`,
        headers: { cookie: user.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: Position[] }>().data;
    };

    const open = await list('?status=open');
    expect(open.map((row) => [row.marketId, row.outcome, row.qty])).toEqual([
      [traded.id, 'NO', 5],
      [market.id, 'YES', 0],
    ]);
    expect(open[0]).toMatchObject({ marketLastPrice: 62, costBasisCoin: '190', settled: false });
    // Never traded: no price to mark the row to, not a made-up one.
    expect(open[1]).toMatchObject({
      marketSlug: market.slug,
      marketTitle: market.title,
      marketStatus: 'open',
      marketLastPrice: null,
      resolvedResult: null,
      costBasisCoin: '0',
      realizedPnlCoin: '-40',
      settled: false,
    });

    const settled = await list('?status=settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      marketId: settledMarket.id,
      marketStatus: 'settled',
      marketLastPrice: 80,
      resolvedResult: 'YES',
      qty: 0,
      realizedPnlCoin: '700',
      settled: true,
    });

    const all = await list();
    expect(all.map((row) => row.marketId)).toEqual([settledMarket.id, traded.id, market.id]);

    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=closed',
      headers: { cookie: user.cookie },
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/positions' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('GET /me/positions carries the market’s status and result as stored, a VOID result included (#174)', async () => {
    // The result is not a contract side: a NO position on a market judged VOID says so.
    const provisional = await createMarket(t.db, { status: 'provisional', resolvedResult: 'VOID' });
    const cancelled = await createMarket(t.db, { status: 'cancelled' });
    await insertPosition({
      userId: user.id,
      marketId: provisional.id,
      outcome: 'NO',
      qty: 4,
      updatedAt: at(1),
    });
    await insertPosition({
      userId: user.id,
      marketId: cancelled.id,
      outcome: 'YES',
      qty: 2,
      updatedAt: at(2),
    });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=open',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json<{ data: Position[] }>()
        .data.map((row) => [row.marketId, row.outcome, row.marketStatus, row.resolvedResult]),
    ).toEqual([
      [cancelled.id, 'YES', 'cancelled', null],
      [provisional.id, 'NO', 'provisional', 'VOID'],
    ]);
  });
});
