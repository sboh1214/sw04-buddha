/**
 * 공개 호가와 견적 (#179, ADR-0114) through the API against the docker `test` profile:
 * `GET /markets/:id/book` and `POST /markets/:id/quote` (public, no session) and
 * `GET /me/markets/:id/sellable` (the session's own). Skips when TEST_* are unset (fails under
 * CI=true, see the harness). The readers' snapshot, their locks and writes and the parity over
 * mixed sequences are packages/db order-book.test.ts's and the figures @buddha/shared's; here are
 * the routes' access, answers and errors, the book as every caller reads it with the 운영
 * 마켓메이커's orders merged in, a quote equal to what the intake then fills for a member with no
 * order in the walk, and a market that takes no order. The `market:book` signal is
 * orders.controller.test.ts's and the batches' suites'; here only that an admin's width change
 * publishes none.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  checkOrderInvariants,
  closeTestMarket,
  completeOnboarding,
  createMarket,
  createMarketPause,
  createModerationAction,
  createStartGrant,
  fundMarketMakerFunds,
  mintTestPairs,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  setReleaseSetting,
} from '@buddha/db/test';
import {
  ORDER_ACCEPTING_SETTING,
  orderBookSchema,
  orderQuoteSchema,
  placeOrderResultSchema,
  sellableSchema,
  type OrderBook,
  type OrderQuote,
  type OrderSide,
  type Outcome,
  type PlaceOrderResult,
  type Sellable,
} from '@buddha/shared';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

/** Each member's start Coin. */
const START_COIN = 10_000n;

type Res = { statusCode: number; body: string };

describe.skipIf(!hasTestInfra)('the public book and quotes (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  /** A and the 운영 마켓메이커 make the book; B holds YES and rests a sell; D holds NO. */
  let a: TestUser;
  let b: TestUser;
  /** A member with no order anywhere: whose orders the quotes are compared with. */
  let c: TestUser;
  let d: TestUser;
  let marketMaker: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await anAdmin();
    a = await member();
    b = await member();
    c = await member();
    d = await member();
    await openOrderIntake(t.db, { adminId: admin.id });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function member(coin = true): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    if (coin) await createStartGrant(t.db, { userId: user.id, amountCoin: START_COIN });
    return user;
  }
  async function anAdmin(): Promise<TestUser> {
    const user = await member(false);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  /** A resting GTC order through the real intake. */
  async function rest(
    marketId: string,
    ownerId: string,
    outcome: Outcome,
    side: OrderSide,
    limitPriceCoin: number,
    qty: number,
  ) {
    const result = await placeTestOrder(t.db, {
      marketId,
      ownerId,
      outcome,
      side,
      limitPriceCoin,
      qty,
    });
    if (result.kind !== 'placed' || result.order.status !== 'open') {
      throw new Error(`expected a resting order, got ${JSON.stringify(result)}`);
    }
    return result.order;
  }

  /**
   * An OPEN market (width 5) with the one book every case below reads, in this arrival order: A's
   * NO buy 40 × 10 (YES supply at 60), the 운영 마켓메이커's NO buys 37 × 5 and 33 × 2 and YES buy
   * 30 × 4, A's YES buy 30 × 3, then B's YES sell 60 × 2 out of the 12 YES it holds (D holds the
   * NO side of those pairs).
   */
  async function stocked() {
    const market = await createMarket(t.db, { createdBy: admin.id });
    marketMaker = await fundMarketMakerFunds(t.db, market.id, 10_000n);
    await rest(market.id, a.id, 'NO', 'buy', 40, 10);
    await rest(market.id, marketMaker, 'NO', 'buy', 37, 5);
    await rest(market.id, marketMaker, 'NO', 'buy', 33, 2);
    await rest(market.id, marketMaker, 'YES', 'buy', 30, 4);
    await rest(market.id, a.id, 'YES', 'buy', 30, 3);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: b.id,
      noHolderId: d.id,
      qty: 12,
    });
    await rest(market.id, b.id, 'YES', 'sell', 60, 2);
    return market;
  }
  /** `stocked()`'s book as every caller reads it. */
  const STOCKED_BOOK = [
    {
      outcome: 'YES',
      // 60: A's converted NO buy (10) and B's direct sell (2), one level; each order once.
      asks: [
        { priceCoin: 60, qty: 12 },
        { priceCoin: 63, qty: 5 },
        { priceCoin: 67, qty: 2 },
      ],
      // The 운영 마켓메이커's 4 and A's 3, one level, no split.
      bids: [{ priceCoin: 30, qty: 7 }],
      bestAskCoin: 60,
      bestBidCoin: 30,
    },
    {
      outcome: 'NO',
      asks: [{ priceCoin: 70, qty: 7 }],
      bids: [
        { priceCoin: 40, qty: 10 },
        { priceCoin: 37, qty: 5 },
        { priceCoin: 33, qty: 2 },
      ],
      bestAskCoin: 70,
      bestBidCoin: 40,
    },
  ];
  const EMPTY_BOOK = ['YES', 'NO'].map((outcome) => ({
    outcome,
    asks: [],
    bids: [],
    bestAskCoin: null,
    bestBidCoin: null,
  }));

  const read = (url: string, who: TestUser | null = null) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const quote = (marketId: string, body: Record<string, unknown>, who: TestUser | null = null) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/quote`,
      headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) },
      payload: JSON.stringify(body),
    });
  /** The member's real order through the API, the quote's terms with the quoted limit. */
  const order = (who: TestUser, marketId: string, body: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/orders`,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        cookie: who.cookie,
      },
      payload: JSON.stringify({ ...body, expectedAccountId: who.id }),
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return (JSON.parse(res.body) as { data: T }).data;
  };
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const { error } = JSON.parse(res.body) as { error: { code: string; details: unknown } };
    expect(error.code).toBe(code);
    return error.details;
  };
  const bookOf = async (marketId: string, who: TestUser | null = null) =>
    orderBookSchema.parse(dataOf<OrderBook>(await read(`/markets/${marketId}/book`, who)));
  const quoted = async (marketId: string, body: Record<string, unknown>) =>
    orderQuoteSchema.parse(dataOf<OrderQuote>(await quote(marketId, body)));
  const sellableOf = async (marketId: string, who: TestUser) =>
    sellableSchema.parse(dataOf<Sellable>(await read(`/me/markets/${marketId}/sellable`, who)));
  const orderRows = async () => (await t.db.select({ n: count() }).from(schema.orders))[0]!.n;
  /** Every balance row and position row: what a read must leave as it was. */
  const ledgerState = async () => ({
    orders: await orderRows(),
    balances: await t.db.select().from(schema.balances).orderBy(schema.balances.userId),
    positions: await t.db.select().from(schema.positions).orderBy(schema.positions.userId),
  });

  /**
   * The quote, then the same order by `who` (no order of theirs in the walk) with the quoted limit
   * on the unchanged book: the figures are the order's (#179 수용 기준, ADR-0111 결정 8).
   */
  async function expectFillAsQuoted(
    marketId: string,
    terms: Record<string, unknown>,
    who: TestUser = c,
  ): Promise<OrderQuote> {
    const answer = await quoted(marketId, terms);
    const { order: placed } = placeOrderResultSchema.parse(
      dataOf<PlaceOrderResult>(
        await order(who, marketId, { ...terms, limitPriceCoin: answer.protectedLimitPriceCoin }),
      ),
    );
    expect(answer).toEqual({
      protectedLimitPriceCoin: placed.protectedLimitPriceCoin,
      filledQty: placed.filledQty,
      filledAmountCoin: placed.filledAmountCoin,
      remainingQty: placed.qty === null ? null : placed.qty - placed.filledQty,
      unspentCoin: placed.unspentCoin,
      maxSpendCoin: answer.maxSpendCoin,
      feeCoin: '0',
      stop: answer.stop,
      status: placed.status,
      rejectReason: placed.rejectReason,
      cancelReason: placed.cancelReason,
    });
    return answer;
  }

  /**
   * The worker's close at `close_at` (`closeMarketAtClose`, #120): the close moved a minute back,
   * then OPEN or PAUSED → CLOSED with every live order ended 만료 (a ledger-held market's kept).
   */
  async function workerClose(marketId: string) {
    await passMarketClose(t.db, marketId);
    const done = await closeTestMarket(t.db, marketId);
    if (!done.closed) throw new Error(`the close skipped: ${done.reason}`);
    return done;
  }

  // --- the book ---------------------------------------------------------------------------------
  it('answers the public book to anyone alike: every level, converted supply merged, each order once, no source or account', async () => {
    const market = await stocked();
    const book = await bookOf(market.id);
    expect(book).toEqual({
      marketId: market.id,
      marketRejectReason: null,
      contracts: STOCKED_BOOK,
    });
    // Allow-listed keys only: no order, owner, account type, bot flag, source or order count.
    expect(Object.keys(book).sort()).toEqual(['contracts', 'marketId', 'marketRejectReason']);
    for (const contract of book.contracts) {
      expect(Object.keys(contract).sort()).toEqual(
        ['asks', 'bestAskCoin', 'bestBidCoin', 'bids', 'outcome'].sort(),
      );
      for (const level of [...contract.asks, ...contract.bids]) {
        expect(Object.keys(level).sort()).toEqual(['priceCoin', 'qty']);
      }
    }
    // The same body for an anonymous visitor, a member with orders in it and one without.
    const raw = (await read(`/markets/${market.id}/book`)).body;
    for (const who of [a, b, c])
      expect((await read(`/markets/${market.id}/book`, who)).body).toBe(raw);
    // Nothing that names an order or an owner: the 운영 마켓메이커 is in the levels alone.
    const ids = (await t.db.select({ id: schema.orders.id }).from(schema.orders)).map((r) => r.id);
    for (const value of [...ids, marketMaker, a.id, b.id, 'market_maker', 'human']) {
      expect(raw).not.toContain(value);
    }
    // Intake closed (결정 3): the book reads the same.
    await setReleaseSetting(t.db, {
      adminId: admin.id,
      key: ORDER_ACCEPTING_SETTING.key,
      status: 'test',
      value: false,
    });
    expect((await read(`/markets/${market.id}/book`)).body).toBe(raw);
  });

  it('answers 호가 없음 on an empty side, and NOT_FOUND for an unknown, draft or review market', async () => {
    const empty = await createMarket(t.db, { createdBy: admin.id });
    expect(await bookOf(empty.id)).toEqual({
      marketId: empty.id,
      marketRejectReason: null,
      contracts: EMPTY_BOOK,
    });
    // One side only: a YES sell shows as a YES ask, never as a NO bid of 100 − its price.
    await mintTestPairs(t.db, { marketId: empty.id, yesHolderId: b.id, noHolderId: d.id, qty: 1 });
    await rest(empty.id, b.id, 'YES', 'sell', 55, 1);
    expect((await bookOf(empty.id)).contracts).toEqual([
      { ...EMPTY_BOOK[0], asks: [{ priceCoin: 55, qty: 1 }], bestAskCoin: 55 },
      EMPTY_BOOK[1],
    ]);
    for (const status of ['draft', 'review'] as const) {
      const hidden = await createMarket(t.db, { createdBy: admin.id, status });
      errorOf(await read(`/markets/${hidden.id}/book`), 404, 'NOT_FOUND');
      errorOf(
        await quote(hidden.id, { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 1 }),
        404,
        'NOT_FOUND',
      );
    }
    errorOf(await read(`/markets/${randomUUID()}/book`), 404, 'NOT_FOUND');
    errorOf(await read('/markets/not-a-uuid/book'), 400, 'VALIDATION_ERROR');
  });

  it('shows a market that takes no order as empty sides with its reason, and quotes it rejected', async () => {
    const terms = { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 3 };
    const expectClosedBook = async (
      marketId: string,
      reason: 'not_open_yet' | 'paused' | 'closed',
    ) => {
      expect(await bookOf(marketId)).toEqual({
        marketId,
        marketRejectReason: reason,
        contracts: EMPTY_BOOK,
      });
      // The intake's rejected row: nothing filled, matched or locked, the limit as sent.
      expect(await quoted(marketId, terms)).toEqual({
        protectedLimitPriceCoin: 99,
        filledQty: 0,
        filledAmountCoin: '0',
        remainingQty: 3,
        unspentCoin: null,
        maxSpendCoin: null,
        feeCoin: '0',
        stop: null,
        status: 'rejected',
        rejectReason: reason,
        cancelReason: null,
      });
    };
    const scheduled = await createMarket(t.db, { createdBy: admin.id, status: 'scheduled' });
    await expectClosedBook(scheduled.id, 'not_open_yet');
    // A basis_change pause cancelled the book; a ledger failure's keeps its orders locked, and
    // none of them is offered.
    const paused = await stocked();
    await createMarketPause(t.db, { marketId: paused.id, reason: 'basis_change' });
    await expectClosedBook(paused.id, 'paused');
    const held = await stocked();
    await createMarketPause(t.db, { marketId: held.id, reason: 'ledger_failure' });
    // Its six resting orders still live and locked (the pair mint's are filled).
    const heldOrders = await t.db
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.marketId, held.id));
    expect(heldOrders.filter((row) => row.status === 'open')).toHaveLength(6);
    expect(heldOrders.filter((row) => row.status === 'cancelled')).toEqual([]);
    await expectClosedBook(held.id, 'paused');
    // Closed by the worker, its six resting orders expired (#120), and closed while held — its
    // six kept live and locked for #93's recovery, none offered.
    const closed = await stocked();
    expect((await workerClose(closed.id)).expired.expired).toHaveLength(6);
    await expectClosedBook(closed.id, 'closed');
    expect((await workerClose(held.id)).expired.held).toHaveLength(6);
    await expectClosedBook(held.id, 'closed');
    // The holder's sellable figure there is the rejected quote too; the expiry gave B's 2 back.
    expect((await sellableOf(closed.id, b)).contracts[0]).toMatchObject({
      qty: 12,
      restingSellQty: 0,
      unlockedQty: 12,
      quote: { status: 'rejected', rejectReason: 'closed', filledQty: 0, stop: null },
    });
  });

  it('refuses an OPEN market past its close_at before the worker closes it: book, quote, sellable and the order agree (#120)', async () => {
    // ADR-0114 결과 5 '#120' (b): one gate (`marketTradingRejectReason` on `close_at` and the
    // read's DB clock) for all four, the market still OPEN and its orders still live.
    const market = await stocked();
    await passMarketClose(t.db, market.id);
    const publisher = t.app.get(MarketPublisher);
    const toMarket = vi.spyOn(publisher, 'publishMarket');
    const before = await ledgerState();
    expect(await bookOf(market.id)).toEqual({
      marketId: market.id,
      marketRejectReason: 'closed',
      contracts: EMPTY_BOOK,
    });
    for (const terms of [
      { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 3 },
      { outcome: 'NO', side: 'buy', timeInForce: 'gtc', limitPriceCoin: 45, qty: 2 },
      { outcome: 'YES', side: 'buy', timeInForce: 'ioc', budgetCoin: '100' },
    ]) {
      expect(await quoted(market.id, terms)).toMatchObject({
        filledQty: 0,
        filledAmountCoin: '0',
        maxSpendCoin: null,
        stop: null,
        status: 'rejected',
        rejectReason: 'closed',
        cancelReason: null,
      });
    }
    expect((await sellableOf(market.id, b)).contracts[0]).toMatchObject({
      qty: 12,
      restingSellQty: 2,
      unlockedQty: 10,
      quote: { status: 'rejected', rejectReason: 'closed', filledQty: 0, stop: null },
    });
    expect(await ledgerState()).toEqual(before);
    // The order in the same window is a rejected row 마감 — not ORDER_INTAKE_CLOSED — with its
    // limit as sent, nothing filled or locked, and no market:book (no live order changed).
    const { order: rejected } = placeOrderResultSchema.parse(
      dataOf<PlaceOrderResult>(
        await order(c, market.id, {
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'ioc',
          limitPriceCoin: 65,
          qty: 3,
        }),
      ),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectReason: 'closed',
      filledQty: 0,
      protectedLimitPriceCoin: 65,
    });
    expect(await ledgerState()).toEqual({ ...before, orders: before.orders + 1 });
    expect(toMarket).not.toHaveBeenCalled();
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0],
    ).toMatchObject({ status: 'open' });
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  });

  // --- the quote --------------------------------------------------------------------------------
  it('quotes what the intake then fills on the same book: multi-level, partial, budget, GTC, sell, NO, empty side', async () => {
    // Several levels within the limit: 60 + 5 = 65 bounds a YES buy with no limit sent.
    expect(
      await expectFillAsQuoted((await stocked()).id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        qty: 15,
      }),
    ).toMatchObject({
      protectedLimitPriceCoin: 65,
      filledQty: 15,
      filledAmountCoin: String(12 * 60 + 3 * 63),
      maxSpendCoin: String(65 * 15),
      stop: 'filled',
      status: 'filled',
    });
    // Part only: the supply at 67 lies beyond the limit (가격 한도).
    expect(
      await expectFillAsQuoted((await stocked()).id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        qty: 20,
      }),
    ).toMatchObject({
      filledQty: 17,
      filledAmountCoin: String(12 * 60 + 5 * 63),
      remainingQty: 3,
      stop: 'price_limit',
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
    // A budget: stops when the next contract is unaffordable (#177 3항), the rest unspent.
    expect(
      await expectFillAsQuoted((await stocked()).id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        budgetCoin: '1000',
      }),
    ).toMatchObject({
      filledQty: 16,
      filledAmountCoin: String(12 * 60 + 4 * 63),
      remainingQty: null,
      unspentCoin: String(1000 - 12 * 60 - 4 * 63),
      maxSpendCoin: '1000',
      stop: 'budget_spent',
      status: 'filled',
    });
    // A GTC order: its own limit, never narrowed; the rest rests, its lock in the max spend.
    expect(
      await expectFillAsQuoted((await stocked()).id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 61,
        qty: 15,
      }),
    ).toMatchObject({
      protectedLimitPriceCoin: 61,
      filledQty: 12,
      remainingQty: 3,
      maxSpendCoin: String(61 * 15),
      status: 'partially_filled',
    });
    // An immediate sell with no limit sent: max(30 − 5, 1); the bids run out (호가 부족).
    const sold = await stocked();
    await mintTestPairs(t.db, { marketId: sold.id, yesHolderId: c.id, noHolderId: d.id, qty: 9 });
    expect(
      await expectFillAsQuoted(sold.id, {
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'ioc',
        qty: 9,
      }),
    ).toMatchObject({
      protectedLimitPriceCoin: 25,
      filledQty: 7,
      filledAmountCoin: String(7 * 30),
      remainingQty: 2,
      maxSpendCoin: null,
      stop: 'no_quote',
      status: 'cancelled',
    });
    // NO: what a NO buyer meets is the converted YES bids.
    expect(
      await expectFillAsQuoted((await stocked()).id, {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'ioc',
        qty: 3,
      }),
    ).toMatchObject({ protectedLimitPriceCoin: 75, filledQty: 3, filledAmountCoin: '210' });
    // 호가 없음: no reference, the limit as sent (99), rejected 호가 부족.
    expect(
      await expectFillAsQuoted((await createMarket(t.db, { createdBy: admin.id })).id, {
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        qty: 1,
      }),
    ).toMatchObject({
      protectedLimitPriceCoin: 99,
      filledQty: 0,
      status: 'rejected',
      rejectReason: 'no_quote',
    });
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  });

  it('differs from the fill when an admin changes the width after it: the book unchanged, no signal', async () => {
    const market = await stocked();
    const terms = { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 15 };
    // Width 5 over the best ask 60: 65, so 12 at 60 and 3 at 63.
    expect(await quoted(market.id, terms)).toMatchObject({
      protectedLimitPriceCoin: 65,
      filledQty: 15,
      filledAmountCoin: '909',
      status: 'filled',
    });
    // Every room's publish goes through these two (`publishBook` and `publishStatus` included).
    const publisher = t.app.get(MarketPublisher);
    const toMarket = vi.spyOn(publisher, 'publishMarket');
    const toUser = vi.spyOn(publisher, 'publishUser');
    const change = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${market.id}/price-protection`,
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: admin.cookie },
      payload: JSON.stringify({
        expectedAccountId: admin.id,
        reason: '호가 폭 조정',
        priceProtectionTicks: 2,
      }),
    });
    expect(change.statusCode, change.body).toBe(200);
    // Nothing on the book moved, and no `market:book` or `market:status` tells a held quote
    // (ADR-0114 결과 5 #66).
    expect((await bookOf(market.id)).contracts).toEqual(STOCKED_BOOK);
    expect(toMarket).not.toHaveBeenCalled();
    expect(toUser).not.toHaveBeenCalled();
    toMarket.mockRestore();
    toUser.mockRestore();
    // The quoted limit sent as is: the intake narrows it to the new width, 60 + 2.
    const { order: placed } = placeOrderResultSchema.parse(
      dataOf<PlaceOrderResult>(await order(c, market.id, { ...terms, limitPriceCoin: 65 })),
    );
    expect(placed).toMatchObject({
      protectedLimitPriceCoin: 62,
      filledQty: 12,
      filledAmountCoin: '720',
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  });

  it('writes and locks nothing, reads no session, and answers while intake is closed or the caller is at its order limit', async () => {
    const market = await stocked();
    const terms = { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 15 };
    const before = await ledgerState();
    const res = await quote(market.id, terms);
    expect(res.statusCode, res.body).toBe(200); // a read, not 201
    const answer = dataOf<OrderQuote>(res);
    expect(Object.keys(answer).sort()).toEqual(
      [
        'cancelReason',
        'feeCoin',
        'filledAmountCoin',
        'filledQty',
        'maxSpendCoin',
        'protectedLimitPriceCoin',
        'rejectReason',
        'remainingQty',
        'status',
        'stop',
        'unspentCoin',
      ].sort(),
    );
    // The same for a member's cookie (no session is read) …
    expect((await quote(market.id, terms, a)).body).toBe(res.body);
    // … at that member's order limit (the address bucket alone counts a quote) …
    await openOrderIntake(t.db, { adminId: admin.id, rateLimit: 1 });
    dataOf(await order(c, market.id, { ...terms, outcome: 'NO', qty: 1, limitPriceCoin: 1 }));
    errorOf(await order(c, market.id, { ...terms, limitPriceCoin: 99 }), 429, 'RATE_LIMITED');
    const afterOrder = await ledgerState();
    expect(dataOf<OrderQuote>(await quote(market.id, terms, c))).toEqual(answer);
    // … and while intake is closed (결정 3), when the intake answers ORDER_INTAKE_CLOSED.
    await setReleaseSetting(t.db, {
      adminId: admin.id,
      key: ORDER_ACCEPTING_SETTING.key,
      status: 'test',
      value: false,
    });
    expect(dataOf<OrderQuote>(await quote(market.id, terms))).toEqual(answer);
    expect(before.orders + 1).toBe(afterOrder.orders);
    // No order, balance or position changed by any quote.
    expect(await ledgerState()).toEqual(afterOrder);
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  });

  it('refuses a malformed quote, and an immediate one on a market with no width as the intake does', async () => {
    const market = await createMarket(t.db, { createdBy: admin.id });
    const base = { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 1 };
    for (const body of [
      { ...base, budgetCoin: '100' }, // both
      { ...base, qty: undefined }, // neither
      { ...base, timeInForce: 'gtc' }, // GTC with no limit
      { ...base, timeInForce: 'gtc', limitPriceCoin: 40, qty: undefined, budgetCoin: '100' },
      { ...base, side: 'sell', qty: undefined, budgetCoin: '100' }, // a budget on a sell
      { ...base, limitPriceCoin: 100 }, // off the grid
      { ...base, limitPriceCoin: 40.5 },
      { ...base, qty: 0 },
      { ...base, expectedAccountId: a.id }, // no account on a quote
      { ...base, extra: 1 },
    ]) {
      errorOf(await quote(market.id, body), 400, 'VALIDATION_ERROR');
    }
    errorOf(await quote('not-a-uuid', base), 400, 'VALIDATION_ERROR');
    errorOf(await quote(randomUUID(), base), 404, 'NOT_FOUND');

    // No width (submitted before #119): the intake's own answer for an immediate order, a GTC
    // quoted as taken.
    const none = await createMarket(t.db, { createdBy: admin.id, priceProtectionTicks: null });
    const quoteError = JSON.parse((await quote(none.id, base)).body) as unknown;
    const intake = await order(c, none.id, { ...base, limitPriceCoin: 99 });
    expect(errorOf(intake, 409, 'ORDER_INTAKE_CLOSED')).toEqual([
      { path: ['priceProtection'], message: 'undecided' },
    ]);
    expect(quoteError).toEqual(JSON.parse(intake.body));
    expect(
      await quoted(none.id, { ...base, timeInForce: 'gtc', limitPriceCoin: 40 }),
    ).toMatchObject({ status: 'open', protectedLimitPriceCoin: 40, maxSpendCoin: '40' });
    // The status comes before the width (ADR-0112 결정 4): a paused or scheduled market with no
    // width answers both kinds with its own rejection, a 200 as the intake's row, never the 409.
    const pausedNone = await createMarket(t.db, {
      createdBy: admin.id,
      priceProtectionTicks: null,
    });
    await createMarketPause(t.db, { marketId: pausedNone.id, reason: 'basis_change' });
    const scheduledNone = await createMarket(t.db, {
      createdBy: admin.id,
      status: 'scheduled',
      priceProtectionTicks: null,
    });
    for (const [marketId, reason] of [
      [pausedNone.id, 'paused'],
      [scheduledNone.id, 'not_open_yet'],
    ] as const) {
      for (const terms of [base, { ...base, timeInForce: 'gtc', limitPriceCoin: 40 }]) {
        expect(await expectFillAsQuoted(marketId, terms)).toMatchObject({
          status: 'rejected',
          rejectReason: reason,
          filledQty: 0,
          stop: null,
        });
      }
    }
  });

  // --- the sellable figure ---------------------------------------------------------------------
  it('answers the session’s own holding: the free part quoted as its own immediate sell, the resting sell apart', async () => {
    const market = await stocked();
    errorOf(await read(`/me/markets/${market.id}/sellable`), 401, 'UNAUTHENTICATED');
    const before = await ledgerState();
    const own = await sellableOf(market.id, b);
    expect(own).toEqual({
      marketId: market.id,
      contracts: [
        {
          outcome: 'YES',
          qty: 12,
          restingSellQty: 2,
          unlockedQty: 10,
          // Only part can go now: 7 bids, max(30 − 5, 1) the 최소 매도 단가.
          quote: {
            protectedLimitPriceCoin: 25,
            filledQty: 7,
            filledAmountCoin: '210',
            remainingQty: 3,
            unspentCoin: null,
            maxSpendCoin: null,
            feeCoin: '0',
            stop: 'no_quote',
            status: 'cancelled',
            rejectReason: null,
            cancelReason: 'ioc_remainder',
          },
        },
        { outcome: 'NO', qty: 0, restingSellQty: 0, unlockedQty: 0, quote: null },
      ],
    });
    expect(await ledgerState()).toEqual(before);
    // Another member reads their own — none — in the same shape, never B's.
    expect(await sellableOf(market.id, c)).toEqual({
      marketId: market.id,
      contracts: ['YES', 'NO'].map((outcome) => ({
        outcome,
        qty: 0,
        restingSellQty: 0,
        unlockedQty: 0,
        quote: null,
      })),
    });
    // D's NO: within the limit (40 − 5 = 35) it fills 10 at 40 and 2 at 37.
    expect((await sellableOf(market.id, d)).contracts[1]).toMatchObject({
      qty: 12,
      unlockedQty: 12,
      quote: {
        protectedLimitPriceCoin: 35,
        filledQty: 12,
        filledAmountCoin: '474',
        status: 'filled',
      },
    });
    // A restricted account still reads its own (a read: no trading check).
    await createModerationAction(t.db, {
      userId: b.id,
      createdBy: admin.id,
      type: 'account_restriction',
      reason: 'multi_account',
      approvedBy: (await anAdmin()).id,
    });
    expect(await sellableOf(market.id, b)).toEqual(own);
    errorOf(await read(`/me/markets/${randomUUID()}/sellable`, b), 404, 'NOT_FOUND');
    errorOf(await read('/me/markets/not-a-uuid/sellable', b), 400, 'VALIDATION_ERROR');
  });

  it('quotes the holder’s own sell, its own bid stopping it (자기 체결) where the public quote goes on', async () => {
    const market = await stocked();
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: a.id,
      noHolderId: d.id,
      qty: 10,
    });
    const terms = { outcome: 'YES', side: 'sell', timeInForce: 'ioc', qty: 10 };
    // The public quote (no owner) meets all 7 bids; A's walk meets the 운영 마켓메이커's 4 first,
    // then A's own 3 (#177 7항).
    expect(await quoted(market.id, terms)).toMatchObject({ filledQty: 7, stop: 'no_quote' });
    const [yes] = (await sellableOf(market.id, a)).contracts;
    expect(yes).toMatchObject({
      qty: 10,
      restingSellQty: 0,
      unlockedQty: 10,
      quote: {
        filledQty: 4,
        filledAmountCoin: '120',
        stop: 'self_trade',
        status: 'cancelled',
        cancelReason: 'self_trade',
      },
    });
    // A's real immediate sell of the free quantity is that figure.
    const { order: sold } = placeOrderResultSchema.parse(
      dataOf<PlaceOrderResult>(
        await order(a, market.id, {
          ...terms,
          limitPriceCoin: yes!.quote!.protectedLimitPriceCoin,
        }),
      ),
    );
    expect(sold).toMatchObject({
      protectedLimitPriceCoin: yes!.quote!.protectedLimitPriceCoin,
      filledQty: 4,
      filledAmountCoin: '120',
      status: 'cancelled',
      cancelReason: 'self_trade',
    });
  });

  it('answers no sellable quote on a market with no width, and B’s holding there as it is', async () => {
    const none = await createMarket(t.db, { createdBy: admin.id, priceProtectionTicks: null });
    await mintTestPairs(t.db, { marketId: none.id, yesHolderId: b.id, noHolderId: d.id, qty: 3 });
    expect((await sellableOf(none.id, b)).contracts[0]).toEqual({
      outcome: 'YES',
      qty: 3,
      restingSellQty: 0,
      unlockedQty: 3,
      quote: null,
    });
  });
});
