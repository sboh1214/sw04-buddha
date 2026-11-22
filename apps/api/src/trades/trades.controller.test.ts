/**
 * The caller's positions (PLAN 7.2; M3 design 3.5) and settlement records (#124, ADR-0143)
 * against the docker `test` profile. Skips when TEST_* are unset (fails under CI=true, see the
 * harness). The orders and fills are orders.controller.test.ts's (#119).
 *
 * Every position row is written straight to its table, with the instants spelled out: the route
 * sorts by them, and back-to-back inserts may share a millisecond. The settlement records are
 * the real settlement's (`settleMarketPositions`) where a payout is read, and
 * `createSettlementRecord`'s zero-payout ones where the instant must be chosen. Every 알림 off
 * leaves the records as they read (#56, ADR-0162; 52-23).
 */
import { randomUUID } from 'node:crypto';
import { schema, settleMarketPositions } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createMarketMakerAccount,
  createSettlementRecord,
  createStartGrant,
  createUser,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  type PlaceTestOrderInput,
} from '@buddha/db/test';
import {
  mySettlementSchema,
  type MyFill,
  type MySettlement,
  type Outcome,
  type Position,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { turnOff } from '../test/notification-settings.js';
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

  it('GET /me/positions carries the market’s last fill time, fill count and status key (#67)', async () => {
    // Public market values beside the price (ADR-0142): what a holding row shows as '최근 체결
    // <시각>' and the two keys it is ordered on against a live market row.
    const lastFillAt = new Date(base + 30_000);
    const traded = await createMarket(t.db, {
      lastPrice: 33,
      lastFillAt,
      tradeCount: 4,
      statusEventId: 77,
    });
    await insertPosition({
      userId: user.id,
      marketId: traded.id,
      outcome: 'YES',
      qty: 3,
      costBasisCoin: 100n,
      updatedAt: at(2),
    });
    // Never traded: the time is null with the price and the count is 0 (N02 §5).
    await insertPosition({
      userId: user.id,
      marketId: market.id,
      outcome: 'NO',
      qty: 1,
      costBasisCoin: 40n,
      updatedAt: at(1),
    });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=open',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const [withFill, withoutFill] = res.json<{ data: Position[] }>().data;
    expect(withFill).toMatchObject({
      marketId: traded.id,
      marketLastPrice: 33,
      marketLastFillAt: lastFillAt.toISOString(),
      marketTradeCount: 4,
      marketStatusEventId: '77',
    });
    expect(withoutFill).toMatchObject({
      marketId: market.id,
      marketLastPrice: null,
      marketLastFillAt: null,
      marketTradeCount: 0,
      marketStatusEventId: null,
    });
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

  // ---- GET /me/settlements (#124, ADR-0143) ------------------------------------------------

  type SettlementPage = { data: MySettlement[]; meta: { nextCursor: string | null } };
  type RecordRow = typeof schema.positionSettlements.$inferSelect;

  /** One page of `who`'s settlement records, every line held to the DTO and to its keys. */
  async function settlementsOf(who: TestUser, query = ''): Promise<SettlementPage> {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/settlements${query}`,
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<SettlementPage>();
    for (const line of page.data) {
      expect(mySettlementSchema.parse(line)).toEqual(line);
      expect(Object.keys(line).sort()).toEqual(Object.keys(mySettlementSchema.shape).sort());
    }
    return page;
  }
  /** Every page of `who`'s list, `limit` at a time, following the cursor until it ends. */
  async function settlementPages(who: TestUser, limit: number, filter = '') {
    const pages: MySettlement[][] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=${String(limit)}${filter}${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const page = await settlementsOf(who, query);
      pages.push(page.data);
      cursor = page.meta.nextCursor;
      if (cursor !== null) cursors.push(cursor);
      expect(pages.length).toBeLessThan(20);
    } while (cursor !== null);
    return { pages, cursors, lines: pages.flat() };
  }
  /** What names a line: its market and its contract. */
  const keyOf = (line: { marketId: string; outcome: Outcome }) => [line.marketId, line.outcome];
  /** The route's order: the payout time, then the market, then YES before NO — all descending. */
  const byPayout = (x: RecordRow, y: RecordRow) =>
    y.settledAt.getTime() - x.settledAt.getTime() ||
    (x.marketId === y.marketId ? 0 : x.marketId < y.marketId ? 1 : -1) ||
    (x.outcome === y.outcome ? 0 : x.outcome === 'YES' ? -1 : 1);
  const recordsOf = async (userId: string) =>
    (
      await t.db
        .select()
        .from(schema.positionSettlements)
        .where(eq(schema.positionSettlements.userId, userId))
    ).sort(byPayout);
  /** An onboarded member whose only Coin is its start grant. */
  async function member(): Promise<TestUser> {
    const made = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: made.id });
    await createStartGrant(t.db, { userId: made.id, amountCoin: 10_000n });
    return made;
  }
  /** An order through the real intake that must be taken. */
  async function order(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result.order;
  }
  /** The real payout of `marketId`'s holdings, as the worker's step runs it. */
  async function settle(marketId: string, set: Partial<typeof schema.markets.$inferInsert>) {
    await t.db
      .update(schema.markets)
      .set({ status: 'settling', ...set })
      .where(eq(schema.markets.id, marketId));
    return t.db.transaction((tx) => settleMarketPositions(tx, marketId));
  }
  const fillsOf = async (who: TestUser) => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/fills?limit=100',
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: MyFill[] }>().data;
  };

  it('GET /me/settlements answers what each holding was paid — a losing contract’s zero, VOID’s 50 on both contracts — beside the P&L of the sales before it, none of it a start grant', async () => {
    // Three members whose only Coin is the start grant buy, sell and are settled through the real
    // intake and the real payout: every figure below is the order's price × quantity and the
    // position's cost, and none holds the 10,000 they were given (N04 §3).
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    const a = await member();
    const b = await member();
    const c = await member();
    const on = { marketId: market.id };
    // B bids NO at 40 for 4: A takes three YES at 60 (cost 180) and C one (cost 60).
    await order({ ...on, ownerId: b.id, outcome: 'NO', limitPriceCoin: 40, qty: 4 });
    const ioc = { timeInForce: 'ioc' as const };
    expect(await order({ ...on, ...ioc, ownerId: a.id, limitPriceCoin: 60, qty: 3 })).toMatchObject(
      { status: 'filled', filledAmountCoin: 180n },
    );
    expect(await order({ ...on, ...ioc, ownerId: c.id, limitPriceCoin: 60, qty: 1 })).toMatchObject(
      { status: 'filled', filledAmountCoin: 60n },
    );
    // A sells one of its three to B's bid of 70: it releases round(180 × 1 / 3) = 60 and
    // realises 70 − 60 = +10; two are left for 120.
    await order({ ...on, ownerId: b.id, limitPriceCoin: 70, qty: 1 });
    expect(
      await order({ ...on, ...ioc, ownerId: a.id, side: 'sell', limitPriceCoin: 70, qty: 1 }),
    ).toMatchObject({ status: 'filled', filledAmountCoin: 70n });
    // C sells its only one to B's bid of 55: 55 − 60 = −5, and nothing is left to settle.
    await order({ ...on, ownerId: b.id, limitPriceCoin: 55, qty: 1 });
    expect(
      await order({ ...on, ...ioc, ownerId: c.id, side: 'sell', limitPriceCoin: 55, qty: 1 }),
    ).toMatchObject({ status: 'filled', filledAmountCoin: 55n });

    // A second market, judged VOID: A and B each hold both contracts there.
    const voided = await createMarket(t.db);
    await mintTestPairs(t.db, {
      marketId: voided.id,
      yesHolderId: a.id,
      noHolderId: b.id,
      qty: 2,
      yesPriceCoin: 60,
    });
    await mintTestPairs(t.db, {
      marketId: voided.id,
      yesHolderId: b.id,
      noHolderId: a.id,
      qty: 1,
      yesPriceCoin: 30,
    });

    // Nothing is settled yet: no record, whatever is held.
    expect((await settlementsOf(a)).data).toEqual([]);
    const resolvedAt = new Date(base);
    const first = await settle(market.id, { resolvedResult: 'YES', resolvedAt });
    const second = await settle(voided.id, { resolvedResult: 'VOID' });

    // The sale's realised P&L is on the seller's sell line alone (N02 §8): net proceeds minus the
    // cost released. The buys, and the buyer's line of the same fill, carry none.
    const aFills = await fillsOf(a);
    expect(aFills.filter((fill) => fill.side === 'sell')).toEqual([
      expect.objectContaining({
        marketId: market.id,
        outcome: 'YES',
        qty: 1,
        priceCoin: 70,
        amountCoin: '70',
        realizedPnlCoin: '10',
      }),
    ]);
    expect(
      aFills.filter((fill) => fill.side === 'buy').map((fill) => fill.realizedPnlCoin),
    ).toEqual([null, null, null]);
    expect(
      (await fillsOf(c)).map((fill) => [fill.side, fill.amountCoin, fill.realizedPnlCoin]),
    ).toEqual([
      ['sell', '55', '-5'],
      ['buy', '60', null],
    ]);
    const bFills = await fillsOf(b);
    expect(bFills).toHaveLength(6);
    expect(bFills.map((fill) => [fill.side, fill.realizedPnlCoin])).toEqual(
      bFills.map(() => ['buy', null]),
    );

    // A's records: the VOID market's two contracts (paid later), then the two YES it still held.
    const paidAt = first.at.toISOString();
    const voidedAt = second.at.toISOString();
    const aMarket = {
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      resolvedAt: resolvedAt.toISOString(),
      settledAt: paidAt,
    };
    const aVoided = {
      marketId: voided.id,
      marketSlug: voided.slug,
      marketTitle: voided.title,
      result: 'VOID',
      payoutPerContractCoin: 50,
      // The market row carries no 결과 확정 time here: the line says so rather than guess one.
      resolvedAt: null,
      settledAt: voidedAt,
    };
    const aWon = {
      ...aMarket,
      outcome: 'YES',
      result: 'YES',
      qty: 2,
      costBasisCoin: '120',
      payoutPerContractCoin: 100,
      payoutCoin: '200',
      // Payout minus the remaining cost (N02 §8): 200 − 120.
      settlementPnlCoin: '80',
    };
    expect((await settlementsOf(a, `?marketId=${market.id}`)).data).toEqual([aWon]);
    // VOID pays 50 a contract on both contracts, with its own P&L — not the price paid back.
    expect((await settlementsOf(a, `?marketId=${voided.id}`)).data).toEqual([
      {
        ...aVoided,
        outcome: 'YES',
        qty: 2,
        costBasisCoin: '120',
        payoutCoin: '100',
        settlementPnlCoin: '-20',
      },
      {
        ...aVoided,
        outcome: 'NO',
        qty: 1,
        costBasisCoin: '70',
        payoutCoin: '50',
        settlementPnlCoin: '-20',
      },
    ]);
    // B won two YES (70 + 55 of cost) and lost four NO: the zero payout is a record of its own,
    // its P&L minus the cost — after the YES of the same market, paid at the same instant.
    expect((await settlementsOf(b, `?marketId=${market.id}`)).data).toEqual([
      { ...aWon, costBasisCoin: '125', settlementPnlCoin: '75' },
      {
        ...aMarket,
        outcome: 'NO',
        result: 'YES',
        qty: 4,
        costBasisCoin: '160',
        payoutPerContractCoin: 0,
        payoutCoin: '0',
        settlementPnlCoin: '-160',
      },
    ]);
    // C sold out before the payout: no record, so no line — its P&L is its sale's alone.
    expect((await settlementsOf(c)).data).toEqual([]);

    // Each list in the route's order, and one line a page: a market's YES and NO, paid at one
    // instant, are neither repeated nor skipped.
    for (const who of [a, b]) {
      const expected = (await recordsOf(who.id)).map(keyOf);
      expect(expected).toHaveLength(who === a ? 3 : 4);
      expect((await settlementsOf(who)).data.map(keyOf)).toEqual(expected);
      const paged = await settlementPages(who, 1);
      expect(paged.pages.map((page) => page.length)).toEqual(expected.map(() => 1));
      expect(paged.lines.map(keyOf)).toEqual(expected);
    }
    // The most recently paid first: the VOID market was paid after the other. Should the two
    // payouts share a millisecond (`settled_at` keeps no more), the market id decides, as
    // `byPayout` says.
    const later = second.at.getTime() - first.at.getTime();
    expect(later).toBeGreaterThanOrEqual(0);
    const voidedLines = [
      [voided.id, 'YES'],
      [voided.id, 'NO'],
    ];
    const marketLines = [[market.id, 'YES']];
    expect((await settlementsOf(a)).data.map(keyOf)).toEqual(
      later > 0 || voided.id > market.id
        ? [...voidedLines, ...marketLines]
        : [...marketLines, ...voidedLines],
    );

    // The position's realised P&L is its sales' plus its settlement's: 10 + 80.
    const positions = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=settled',
      headers: { cookie: a.cookie },
    });
    expect(
      positions
        .json<{ data: Position[] }>()
        .data.filter((row) => row.marketId === market.id)
        .map((row) => [row.outcome, row.qty, row.realizedPnlCoin]),
    ).toEqual([['YES', 0, '90']]);

    // A line is its record: the market row's result changing afterwards changes no line.
    const before = (await settlementsOf(b, `?marketId=${market.id}`)).data;
    await t.db
      .update(schema.markets)
      .set({ resolvedResult: 'NO' })
      .where(eq(schema.markets.id, market.id));
    expect((await settlementsOf(b, `?marketId=${market.id}`)).data).toEqual(before);
    expect((await settlementsOf(a, `?marketId=${market.id}`)).data).toEqual([aWon]);

    // 52-23 (#56, ADR-0162; ADR-0143 결과 7): the list is the 필수 정산 기록, so turning every
    // notification category off changes no byte of it — the zero payout and VOID's included.
    const raw = async (who: TestUser) =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/me/settlements?limit=100',
          headers: { cookie: who.cookie },
        })
      ).body;
    const bodies = [await raw(a), await raw(b)];
    for (const who of [a, b]) await turnOff(t, who, 'trade', 'market', 'community');
    expect([await raw(a), await raw(b)]).toEqual(bodies);
  });

  it('GET /me/settlements pages two markets paid at one instant without a gap or a repeat, filters by market and period, and reads the session’s own alone', async () => {
    const stranger = await signUpTestUser(t);
    const marketMaker = await createMarketMakerAccount(t.db);
    const settling = () => createMarket(t.db, { status: 'settling', resolvedResult: 'YES' });
    // Two markets paid at the same instant. The one with the greater id comes first, and its
    // losing contract is NO (key 0) while the other's is YES (key 1): a cursor compared in the
    // order it is written — time, contract, market — would skip the second.
    const [small, big] = [await settling(), await settling()].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    ) as [MarketRow, MarketRow];
    await t.db
      .update(schema.markets)
      .set({ resolvedResult: 'NO' })
      .where(eq(schema.markets.id, small.id));
    const paidAt = new Date(base);
    const DAY_MS = 24 * 60 * 60 * 1_000;
    // One payout just inside the last 7 × 24 hours and one just outside, a minute either way.
    const inside = await settling();
    const outside = await settling();
    const insideAt = new Date(Date.now() - 7 * DAY_MS + 60_000);
    const outsideAt = new Date(Date.now() - 7 * DAY_MS - 60_000);
    const lost = (marketId: string, userId: string, outcome: Outcome, qty: number, at: Date) =>
      createSettlementRecord(t.db, {
        marketId,
        userId,
        outcome,
        qty,
        costBasisCoin: BigInt(qty) * 40n,
        settledAt: at,
      });
    await lost(big.id, user.id, 'NO', 3, paidAt);
    await lost(small.id, user.id, 'YES', 5, paidAt);
    await lost(inside.id, user.id, 'NO', 2, insideAt);
    await lost(outside.id, user.id, 'NO', 1, outsideAt);
    // Another member's and the 운영 마켓메이커's records in the same market, at the same instant.
    await lost(big.id, stranger.id, 'NO', 7, paidAt);
    await lost(big.id, marketMaker, 'NO', 9, paidAt);

    const expected = [
      [big.id, 'NO'],
      [small.id, 'YES'],
      [inside.id, 'NO'],
      [outside.id, 'NO'],
    ];
    expect((await recordsOf(user.id)).map(keyOf)).toEqual(expected);
    const whole = await settlementsOf(user);
    expect(whole.data.map(keyOf)).toEqual(expected);
    expect(whole.meta.nextCursor).toBeNull();
    // A losing contract's line: nothing paid, the whole remaining cost lost.
    expect(whole.data[0]).toEqual({
      marketId: big.id,
      marketSlug: big.slug,
      marketTitle: big.title,
      outcome: 'NO',
      result: 'YES',
      qty: 3,
      costBasisCoin: '120',
      payoutPerContractCoin: 0,
      payoutCoin: '0',
      settlementPnlCoin: '-120',
      resolvedAt: null,
      settledAt: paidAt.toISOString(),
    });
    expect(whole.data[1]).toMatchObject({ result: 'NO', qty: 5, settlementPnlCoin: '-200' });

    // Any page size: every line once, in order.
    for (const [limit, sizes] of [
      [1, [1, 1, 1, 1]],
      [2, [2, 2]],
      [3, [3, 1]],
    ] as const) {
      const paged = await settlementPages(user, limit);
      expect(paged.pages.map((page) => page.length)).toEqual(sizes);
      expect(paged.lines.map(keyOf)).toEqual(expected);
    }
    // The cursor: the payout time in milliseconds, the contract key (YES 1, NO 0), the market.
    const { cursors } = await settlementPages(user, 1);
    expect(cursors.slice(0, 2)).toEqual([
      `${String(paidAt.getTime())}_0_${big.id}`,
      `${String(paidAt.getTime())}_1_${small.id}`,
    ]);
    // A cursor of another shape is no cursor: the first page.
    for (const other of ['x', '42', `${String(paidAt.getTime())}_${big.id}`]) {
      expect(
        (await settlementsOf(user, `?cursor=${encodeURIComponent(other)}`)).data.map(keyOf),
      ).toEqual(expected);
    }

    // One market's, alone and across pages.
    expect((await settlementsOf(user, `?marketId=${big.id}`)).data.map(keyOf)).toEqual([
      [big.id, 'NO'],
    ]);
    const one = await settlementsOf(user, `?marketId=${small.id}&limit=1`);
    expect(one.data.map(keyOf)).toEqual([[small.id, 'YES']]);
    expect(one.meta.nextCursor).toBeNull();
    expect((await settlementsOf(user, `?marketId=${randomUUID()}`)).data).toEqual([]);

    // The period is counted back from the read, by the payout time: the payout a minute inside
    // 7 × 24 hours stays, the one a minute outside goes — and comes back within 30 and 90 days.
    expect((await settlementsOf(user, '?period=7d')).data.map(keyOf)).toEqual(expected.slice(0, 3));
    const recent = await settlementPages(user, 1, '&period=7d');
    expect(recent.pages.map((page) => page.length)).toEqual([1, 1, 1]);
    expect(recent.lines.map(keyOf)).toEqual(expected.slice(0, 3));
    for (const period of ['30d', '90d']) {
      expect((await settlementsOf(user, `?period=${period}`)).data.map(keyOf)).toEqual(expected);
    }
    expect(
      (await settlementsOf(user, `?period=7d&marketId=${outside.id}`)).data.map(keyOf),
    ).toEqual([]);

    // Another account reads its own record alone — with this account's cursor and market too —
    // and nobody reads the 운영 마켓메이커's.
    expect((await settlementsOf(stranger)).data).toEqual([
      expect.objectContaining({ marketId: big.id, outcome: 'NO', qty: 7, costBasisCoin: '280' }),
    ]);
    const borrowed = encodeURIComponent(cursors[0]!);
    expect((await settlementsOf(stranger, `?cursor=${borrowed}`)).data).toEqual([]);
    expect(
      (await settlementsOf(stranger, `?cursor=${borrowed}&marketId=${small.id}`)).data,
    ).toEqual([]);
    expect((await settlementsOf(stranger, `?marketId=${small.id}&period=90d`)).data).toEqual([]);
    // The caller's four quantities and no other: the stranger's 7 and the 운영 마켓메이커's 9
    // sit in the same market at the same instant.
    expect(whole.data.map((line) => line.qty)).toEqual([3, 5, 2, 1]);

    for (const query of ['?period=1d', '?period=all', '?marketId=x', '?limit=0']) {
      const bad = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/settlements${query}`,
        headers: { cookie: user.cookie },
      });
      expect(bad.statusCode, query).toBe(400);
      expect(bad.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    }
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/settlements' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    // The records are as they were written: a read changes none.
    expect(await t.db.select().from(schema.positionSettlements)).toHaveLength(6);
  });
});
