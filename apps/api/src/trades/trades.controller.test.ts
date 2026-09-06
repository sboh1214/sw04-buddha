/**
 * Trade integration tests (PLAN M3 AC 3-7, 9; PLAN 5.3/5.4; M3 design 3.3, 3.5, 3.7) against
 * the docker `test` profile. Skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { createMarket, createPosition } from '@buddha/db/test';
import {
  POSITION_QTY_MAX,
  SIGNUP_BONUS_P,
  marketChannel,
  parseQuantity,
  quoteBuy,
  quoteSell,
  serializeQuantity,
  userChannel,
  type LmsrState,
  type Order,
  type Outcome,
  type Position,
  type TradeResult,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chargeHeaders,
  createTestApp,
  signUpTestUser,
  type TestApp,
  type TestUser,
} from '../test/app.js';
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

type MarketRow = typeof schema.markets.$inferSelect;
type ErrorBody = { error: { code: string; details?: { path: unknown[] }[] } };

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

/** The LMSR state a market row holds, exactly as the service reads it. */
function stateOf(market: Pick<MarketRow, 'qYes' | 'qNo' | 'liquidityB'>): LmsrState {
  return {
    qYes: parseQuantity(market.qYes),
    qNo: parseQuantity(market.qNo),
    b: parseQuantity(market.liquidityB),
  };
}

describe.skipIf(!hasTestInfra)('trades (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** Open, b = 1000, p0 = 0.5 (price 50), closes in a week. */
  let market: MarketRow;

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
  });

  interface TradeOptions {
    outcome?: Outcome;
    as?: TestUser;
    /** The account the screen shows; defaults to the cookie's. */
    expectedAccountId?: string;
    idempotencyKey?: string;
    origin?: string;
  }

  /** One buy: `maxCostP` defaults to the 100P-per-contract ceiling, so only price moves fail. */
  const buy = (
    marketId: string,
    shares: number,
    maxCostP: bigint = BigInt(shares) * 100n,
    options: TradeOptions = {},
  ) => {
    const as = options.as ?? user;
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/trades',
      headers: {
        ...chargeHeaders(as.cookie, options.idempotencyKey),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
      payload: {
        marketId,
        outcome: options.outcome ?? 'YES',
        side: 'buy',
        shares,
        maxCostP: maxCostP.toString(),
        expectedAccountId: options.expectedAccountId ?? as.id,
      },
    });
  };

  /** One sell: `minProceedsP` defaults to 0, so only a missing position fails. */
  const sell = (
    marketId: string,
    shares: number,
    minProceedsP = 0n,
    options: TradeOptions = {},
  ) => {
    const as = options.as ?? user;
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/trades',
      headers: chargeHeaders(as.cookie, options.idempotencyKey),
      payload: {
        marketId,
        outcome: options.outcome ?? 'YES',
        side: 'sell',
        shares,
        minProceedsP: minProceedsP.toString(),
        expectedAccountId: options.expectedAccountId ?? as.id,
      },
    });
  };

  const dataOf = (res: { json: <T>() => T }) => res.json<{ data: TradeResult }>().data;

  async function marketRow(id: string = market.id) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    if (!row) throw new Error('market vanished');
    return row;
  }

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row;
  }

  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  async function ordersOf(userId: string) {
    return t.db.select().from(schema.orders).where(eq(schema.orders.userId, userId));
  }

  async function fillsOf(marketId: string = market.id) {
    return t.db
      .select()
      .from(schema.fills)
      .where(eq(schema.fills.marketId, marketId))
      .orderBy(asc(schema.fills.id));
  }

  async function ticksOf(marketId: string = market.id) {
    return t.db
      .select()
      .from(schema.priceTicks)
      .where(eq(schema.priceTicks.marketId, marketId))
      .orderBy(asc(schema.priceTicks.id));
  }

  async function positionsOf(userId: string) {
    return t.db.select().from(schema.positions).where(eq(schema.positions.userId, userId));
  }

  /** Nothing of a refused trade is left behind: no order, fill, tick, position or entry. */
  async function expectUntouched(marketBefore: MarketRow, userId: string = user.id) {
    expect(await balanceOf(userId)).toMatchObject({ availableP: SIGNUP_BONUS_P });
    expect(await ledgerOf(userId)).toHaveLength(1); // the sign-up bonus only
    expect(await ordersOf(userId)).toHaveLength(0);
    expect(await fillsOf(marketBefore.id)).toHaveLength(0);
    expect(await ticksOf(marketBefore.id)).toHaveLength(0);
    expect(await positionsOf(userId)).toHaveLength(0);
    const after = await marketRow(marketBefore.id);
    expect(after).toMatchObject({
      qYes: marketBefore.qYes,
      qNo: marketBefore.qNo,
      volumeP: marketBefore.volumeP,
      tradeCount: marketBefore.tradeCount,
      traderCount: marketBefore.traderCount,
      lastPrice: marketBefore.lastPrice,
    });
  }

  it('buys YES: order, fill, ledger, position, market stats and tick in one go (PLAN 5.4)', async () => {
    const quote = quoteBuy(stateOf(market), 'YES', 100);
    const res = await buy(market.id, 100);
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);

    expect(data.order).toMatchObject({
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      outcome: 'YES',
      side: 'buy',
      type: 'market',
      qty: 100,
      filledQty: 100,
      status: 'filled',
      amountP: quote.amountP.toString(),
      priceAvgBp: quote.priceAvgBp,
      maxCostP: '10000',
      minProceedsP: null,
    });
    expect(data.fill).toMatchObject({
      outcome: 'YES',
      side: 'buy',
      qty: 100,
      amountP: quote.amountP.toString(),
      priceAvgBp: quote.priceAvgBp,
    });
    expect(data.fill).not.toHaveProperty('userId');
    expect(data.balance).toEqual({
      availableP: (SIGNUP_BONUS_P - quote.amountP).toString(),
      lockedP: '0',
    });
    expect(data.position).toMatchObject({
      marketId: market.id,
      outcome: 'YES',
      qty: 100,
      costBasisP: quote.amountP.toString(),
      realizedPnlP: '0',
      settled: false,
      marketStatus: 'open',
    });
    // AC 2: 50 → 52 after buying 100 YES at b = 1000.
    expect(data.market).toEqual({
      id: market.id,
      lastPrice: 52,
      pYesBp: quote.priceAfterBp,
      volumeP: quote.amountP.toString(),
      tradeCount: 1,
    });

    const after = await marketRow();
    expect(after).toMatchObject({
      qYes: serializeQuantity(quote.next.qYes),
      qNo: serializeQuantity(quote.next.qNo),
      lastPrice: 52,
      volumeP: quote.amountP,
      tradeCount: 1,
      traderCount: 1,
    });
    const [fill] = await fillsOf();
    expect(fill).toMatchObject({ counterpartyType: 'amm', feeP: 0n, amountP: quote.amountP });
    const entries = await ledgerOf(user.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: 'TRADE_BUY',
      amountP: -quote.amountP,
      balanceAfterP: SIGNUP_BONUS_P - quote.amountP,
      refType: 'fill',
      refId: fill!.id.toString(),
    });
    expect(await balanceOf(user.id)).toMatchObject({ availableP: SIGNUP_BONUS_P - quote.amountP });
    const ticks = await ticksOf();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ pYesBp: quote.priceAfterBp, trigger: 'trade' });
    // One instant for everything the trade wrote (clock_timestamp() taken under the lock).
    const [order] = await ordersOf(user.id);
    expect(order!.createdAt.getTime()).toBe(fill!.createdAt.getTime());
    expect(entries[1]!.createdAt.getTime()).toBe(fill!.createdAt.getTime());
    expect(ticks[0]!.ts.getTime()).toBe(fill!.createdAt.getTime());
  });

  it('publishes the tick, the trade and the account events after COMMIT (PLAN 8)', async () => {
    // What the M4 gateway forwards: `market:tick` before `market:trade` on the market's
    // channel, then `user:balance` and `user:position` on the account's own channel, every P
    // amount a string and every `ts` the instant the trade was stamped with.
    const quote = quoteBuy(stateOf(market), 'YES', 100);
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: [string, string][] = [];
    subscriber.on('message', (channel: string, message: string) =>
      received.push([channel, message]),
    );
    await subscriber.subscribe(marketChannel(market.id), userChannel(user.id));
    try {
      const res = await buy(market.id, 100);
      expect(res.statusCode).toBe(200);
      const started = Date.now();
      while (received.length < 4) {
        if (Date.now() - started > 5_000) {
          throw new Error(`${String(received.length)} of 4 realtime events received`);
        }
        await sleep(20);
      }
      const [fill] = await fillsOf();
      const ts = fill!.createdAt.toISOString();
      const parse = (message: string) => JSON.parse(message) as Record<string, unknown>;

      const onMarket = received
        .filter(([channel]) => channel === marketChannel(market.id))
        .map(([, message]) => parse(message));
      expect(onMarket).toEqual([
        {
          type: 'market:tick',
          marketId: market.id,
          pYesBp: quote.priceAfterBp,
          lastPrice: 52,
          volumeP: quote.amountP.toString(),
          tradeCount: 1,
          ts,
        },
        {
          type: 'market:trade',
          marketId: market.id,
          outcome: 'YES',
          side: 'buy',
          qty: 100,
          priceAvgBp: quote.priceAvgBp,
          ts,
        },
      ]);
      expect(typeof onMarket[0]!.volumeP).toBe('string');

      const onUser = received
        .filter(([channel]) => channel === userChannel(user.id))
        .map(([, message]) => parse(message));
      expect(onUser).toEqual([
        {
          type: 'user:balance',
          availableP: (SIGNUP_BONUS_P - quote.amountP).toString(),
          lockedP: '0',
          ts,
        },
        {
          type: 'user:position',
          marketId: market.id,
          outcome: 'YES',
          qty: 100,
          costBasisP: quote.amountP.toString(),
          realizedPnlP: '0',
          ts,
        },
      ]);
      expect(received).toHaveLength(4);
    } finally {
      await subscriber.quit();
    }
  });

  it('refuses a buy the balance cannot cover and leaves everything unchanged (AC 3)', async () => {
    // 1000 YES at b = 1000 costs ~62,000P; the sign-up bonus is 10,000P.
    const res = await buy(market.id, 1000);
    expect(res.statusCode).toBe(409);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(body.error.details).toBeUndefined();
    await expectUntouched(market);
  });

  it('replays a trade whose answer was lost instead of trading twice (AC 4)', async () => {
    const key = randomUUID();
    const first = await buy(market.id, 100, undefined, { idempotencyKey: key });
    expect(first.statusCode).toBe(200);
    const again = await buy(market.id, 100, undefined, { idempotencyKey: key });
    expect(again.statusCode).toBe(200);

    const a = dataOf(first);
    const b = dataOf(again);
    expect(b.order).toEqual(a.order);
    expect(b.fill).toEqual(a.fill);
    expect(b.balance).toEqual(a.balance);
    expect(b.position).toEqual(a.position);
    expect(b.market).toEqual(a.market);

    expect(await ordersOf(user.id)).toHaveLength(1);
    expect(await fillsOf()).toHaveLength(1);
    expect((await ledgerOf(user.id)).filter((entry) => entry.type === 'TRADE_BUY')).toHaveLength(1);
    expect(await marketRow()).toMatchObject({ tradeCount: 1, traderCount: 1 });
  });

  it('replays the first order and fill with the current balance and market (AC 4)', async () => {
    // Same split as the charge replay: the immutable half is the first answer; balance,
    // position and market stats are whatever they are now.
    const key = randomUUID();
    const first = dataOf(await buy(market.id, 100, undefined, { idempotencyKey: key }));
    expect((await buy(market.id, 50)).statusCode).toBe(200);

    const replayed = await buy(market.id, 100, undefined, { idempotencyKey: key });
    expect(replayed.statusCode).toBe(200);
    const data = dataOf(replayed);
    expect(data.order).toEqual(first.order);
    expect(data.fill).toEqual(first.fill);
    expect(data.market.tradeCount).toBe(2);
    expect(data.position.qty).toBe(150);
    expect(data.balance.availableP).toBe((await balanceOf(user.id))!.availableP.toString());
    expect(await ordersOf(user.id)).toHaveLength(2);
  });

  it('refuses a re-used Idempotency-Key that carries different terms (DUPLICATE_REQUEST)', async () => {
    const key = randomUUID();
    const elsewhere = await createMarket(t.db);
    expect((await buy(market.id, 100, undefined, { idempotencyKey: key })).statusCode).toBe(200);

    // Every field `sameTradeTerms` compares, changed one at a time: shares, the guard, the
    // outcome, the side and the market.
    for (const res of [
      await buy(market.id, 101, undefined, { idempotencyKey: key }),
      await buy(market.id, 100, 9_999n, { idempotencyKey: key }),
      await buy(market.id, 100, undefined, { idempotencyKey: key, outcome: 'NO' }),
      await sell(market.id, 100, 0n, { idempotencyKey: key }),
      await buy(elsewhere.id, 100, undefined, { idempotencyKey: key }),
    ]) {
      expect(res.statusCode).toBe(409);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('DUPLICATE_REQUEST');
      // No field named: the key is spent, so the client's next click is a new trade.
      expect(body.error.details).toBeUndefined();
    }
    expect(await ordersOf(user.id)).toHaveLength(1);
    expect(await marketRow()).toMatchObject({ tradeCount: 1 });
    expect(await marketRow(elsewhere.id)).toMatchObject({ tradeCount: 0 });

    // A sell key re-sent with another floor is the same kind of re-use.
    const sellKey = randomUUID();
    expect((await sell(market.id, 10, 0n, { idempotencyKey: sellKey })).statusCode).toBe(200);
    const otherFloor = await sell(market.id, 10, 1n, { idempotencyKey: sellKey });
    expect(otherFloor.statusCode).toBe(409);
    expect(otherFloor.json<ErrorBody>().error.code).toBe('DUPLICATE_REQUEST');
    expect(await ordersOf(user.id)).toHaveLength(2);
    expect(await marketRow()).toMatchObject({ tradeCount: 2 });
  });

  it('lets 20 concurrent requests with one key produce exactly one order (AC 4)', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => buy(market.id, 100, undefined, { idempotencyKey: key })),
    );
    // Byte-identical terms, so no 409 is legitimate: the winner trades and every loser finds
    // the key taken under the lock and replays the winner's answer. With one trade in total
    // the current half (balance, position, market) is the same on every replay as well.
    expect(responses.map((res) => res.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));
    const answers = responses.map(dataOf);
    const first = answers[0]!;
    for (const data of answers) expect(data).toEqual(first);

    expect(await ordersOf(user.id)).toHaveLength(1);
    expect(await fillsOf()).toHaveLength(1);
    expect((await ledgerOf(user.id)).filter((entry) => entry.type === 'TRADE_BUY')).toHaveLength(1);
    const cost = quoteBuy(stateOf(market), 'YES', 100).amountP;
    expect(await balanceOf(user.id)).toMatchObject({ availableP: SIGNUP_BONUS_P - cost });
    expect(await marketRow()).toMatchObject({ tradeCount: 1, traderCount: 1, volumeP: cost });
  });

  it('scopes keys to the account: another user may use the same value', async () => {
    const key = randomUUID();
    const other = await signUpTestUser(t);
    expect((await buy(market.id, 10, undefined, { idempotencyKey: key })).statusCode).toBe(200);
    expect(
      (await buy(market.id, 10, undefined, { idempotencyKey: key, as: other })).statusCode,
    ).toBe(200);
    expect(await ordersOf(other.id)).toHaveLength(1);
    expect(await marketRow()).toMatchObject({ tradeCount: 2, traderCount: 2 });
  });

  it('refuses a buy whose cost moved above maxCostP, writing nothing (AC 5)', async () => {
    const cost = quoteBuy(stateOf(market), 'YES', 100).amountP;
    const res = await buy(market.id, 100, cost - 1n);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'PRICE_MOVED' } });
    await expectUntouched(market);

    // Exactly the quoted cost is accepted.
    const ok = await buy(market.id, 100, cost);
    expect(ok.statusCode).toBe(200);
    expect(dataOf(ok).fill.amountP).toBe(cost.toString());
  });

  describe('AC 6: 10 users × 5 parallel buys', () => {
    let traders: TestUser[];

    beforeEach(async () => {
      traders = [];
      for (let i = 0; i < 10; i += 1) traders.push(await signUpTestUser(t));
    });

    it('serialises every trade on the market lock and keeps the books consistent', async () => {
      // 60 YES at b = 1000 costs ~3,000P at 50 and more as the price climbs, so each 10,000P
      // account affords two or three: a mix of 200s and INSUFFICIENT_BALANCE.
      const responses = await Promise.all(
        traders.flatMap((trader) =>
          Array.from({ length: 5 }, () => buy(market.id, 60, undefined, { as: trader })),
        ),
      );
      for (const res of responses) {
        if (res.statusCode === 200) continue;
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } });
      }
      const successes = responses.filter((res) => res.statusCode === 200).length;
      expect(successes).toBeGreaterThan(0);
      expect(successes).toBeLessThan(50);

      // The stored state equals the initial state replayed through the shared engine over the
      // successful fills in commit order (fill ids are assigned under the market lock), with
      // the numeric(24,10) round trip the service makes at every step.
      const fills = await fillsOf();
      expect(fills).toHaveLength(successes);
      let state = stateOf(market);
      for (const fill of fills) {
        const { next } = quoteBuy(state, fill.outcome, fill.qty);
        state = {
          qYes: parseQuantity(serializeQuantity(next.qYes)),
          qNo: parseQuantity(serializeQuantity(next.qNo)),
          b: state.b,
        };
      }
      const after = await marketRow();
      expect(after.qYes).toBe(serializeQuantity(state.qYes));
      expect(after.qNo).toBe(serializeQuantity(state.qNo));
      expect(after.tradeCount).toBe(successes);
      const allOrders = await t.db.select().from(schema.orders);
      expect(after.traderCount).toBe(new Set(allOrders.map((order) => order.userId)).size);
      expect(after.volumeP).toBe(fills.reduce((sum, fill) => sum + fill.amountP, 0n));
      expect(await ticksOf()).toHaveLength(successes);

      // PLAN 5.6: every balance is the sum of its ledger.
      for (const trader of traders) {
        const entries = await ledgerOf(trader.id);
        const total = entries.reduce((sum, entry) => sum + entry.amountP, 0n);
        expect((await balanceOf(trader.id))!.availableP).toBe(total);
        expect(entries.at(-1)!.balanceAfterP).toBe(total);
        expect(await ordersOf(trader.id)).toHaveLength(entries.length - 1);
      }
    });
  });

  it('waits for the market advisory lock before writing anything (PLAN 0.2)', async () => {
    // A session-level lock on the same key from another connection stands in for a
    // concurrent trade, open, close or void holding the transaction-level one.
    const holder = await t.db.$client.connect();
    let released = false;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [market.id]);
      // light-my-request dispatches lazily: `.then` is what sends the request.
      const pending = buy(market.id, 100).then((res) => res);
      await sleep(300);
      expect(await ordersOf(user.id)).toHaveLength(0);
      expect(await fillsOf()).toHaveLength(0);
      expect(await marketRow()).toMatchObject({ tradeCount: 0 });

      // The database clock just before the release, in the same expression the service uses
      // for `executedAt`: a trade stamped before it took the lock would be ~300 ms older.
      const { rows } = await holder.query<{ ms: string }>(
        'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms',
      );
      const releasedMs = Number(rows[0]!.ms);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [market.id]);
      released = true;
      const res = await pending;
      expect(res.statusCode).toBe(200);
      const [order] = await ordersOf(user.id);
      const [fill] = await fillsOf();
      expect(order).toBeDefined();
      expect(fill!.createdAt.getTime()).toBeGreaterThanOrEqual(releasedMs);
      expect(order!.createdAt.getTime()).toBe(fill!.createdAt.getTime());
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });

  it('answers a concurrent same-key twin with different terms with DUPLICATE_REQUEST', async () => {
    // Both requests pass the up-front key lookup (nothing is written yet) and queue on the
    // market lock; whichever wins trades, the other finds the key taken under the lock and
    // goes through the same terms comparison a sequential replay does — different shares, so
    // 409 rather than the winner's answer. The outcome set is the same whichever wins.
    const key = randomUUID();
    const holder = await t.db.$client.connect();
    let released = false;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [market.id]);
      const a = buy(market.id, 100, undefined, { idempotencyKey: key }).then((res) => res);
      const b = buy(market.id, 50, undefined, { idempotencyKey: key }).then((res) => res);
      await sleep(100);
      expect(await ordersOf(user.id)).toHaveLength(0);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [market.id]);
      released = true;

      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
      const refused = ra.statusCode === 409 ? ra : rb;
      const accepted = ra.statusCode === 200 ? ra : rb;
      const body = refused.json<ErrorBody>();
      expect(body.error.code).toBe('DUPLICATE_REQUEST');
      expect(body.error.details).toBeUndefined();

      const orders = await ordersOf(user.id);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.qty).toBe(dataOf(accepted).order.qty);
      expect(await marketRow()).toMatchObject({ tradeCount: 1 });
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });

  it('refuses a market that is not open (AC 7)', async () => {
    const closed = await createMarket(t.db, { status: 'closed' });
    const res = await buy(closed.id, 10);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'MARKET_NOT_OPEN' } });

    for (const status of ['resolving', 'settled', 'voided'] as const) {
      const other = await createMarket(t.db, { status });
      const refused = await buy(other.id, 10);
      expect({ status, code: refused.statusCode }).toEqual({ status, code: 409 });
      expect(refused.json()).toMatchObject({ error: { code: 'MARKET_NOT_OPEN' } });
    }

    const expired = await createMarket(t.db, { closeAt: new Date(Date.now() - 1_000) });
    const past = await buy(expired.id, 10);
    expect(past.statusCode).toBe(409);
    expect(past.json()).toMatchObject({ error: { code: 'MARKET_CLOSED' } });

    // A draft is invisible outside the admin: the same 404 as no market at all.
    const draft = await createMarket(t.db, { status: 'draft' });
    const hidden = await buy(draft.id, 10);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const unknown = await buy('3f1a5b6c-1111-4222-8333-444455556666', 10);
    expect(unknown.statusCode).toBe(404);

    await expectUntouched(closed);
    await expectUntouched(draft);
    expect(await ordersOf(user.id)).toHaveLength(0);
  });

  it('sells: refuses more than held, then closes the position with realised PnL (AC 9)', async () => {
    const cost = quoteBuy(stateOf(market), 'YES', 10).amountP;
    expect((await buy(market.id, 10)).statusCode).toBe(200);

    const tooMany = await sell(market.id, 15);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toMatchObject({ error: { code: 'INSUFFICIENT_POSITION' } });
    // No row at all for the other outcome.
    const none = await sell(market.id, 1, 0n, { outcome: 'NO' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: { code: 'INSUFFICIENT_POSITION' } });

    const held = await marketRow();
    const proceeds = quoteSell(stateOf(held), 'YES', 10).amountP;
    expect(proceeds).toBeLessThanOrEqual(cost); // buy→sell round trip never profits

    const moved = await sell(market.id, 10, proceeds + 1n);
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: { code: 'PRICE_MOVED' } });
    expect(await ordersOf(user.id)).toHaveLength(1);
    expect(await marketRow()).toMatchObject({ tradeCount: 1, qYes: held.qYes });

    const res = await sell(market.id, 10, proceeds);
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data.order).toMatchObject({
      side: 'sell',
      qty: 10,
      filledQty: 10,
      status: 'filled',
      amountP: proceeds.toString(),
      maxCostP: null,
      minProceedsP: proceeds.toString(),
    });
    expect(data.position).toMatchObject({
      qty: 0,
      costBasisP: '0',
      realizedPnlP: (proceeds - cost).toString(),
      settled: false,
    });
    expect(data.balance.availableP).toBe((SIGNUP_BONUS_P - cost + proceeds).toString());

    const [position] = await positionsOf(user.id);
    expect(position).toMatchObject({ qty: 0, costBasisP: 0n, realizedPnlP: proceeds - cost });
    const entries = await ledgerOf(user.id);
    expect(entries.map((entry) => entry.type)).toEqual(['BONUS', 'TRADE_BUY', 'TRADE_SELL']);
    expect(entries[2]).toMatchObject({
      amountP: proceeds,
      balanceAfterP: SIGNUP_BONUS_P - cost + proceeds,
      refType: 'fill',
    });
    expect(await balanceOf(user.id)).toMatchObject({
      availableP: SIGNUP_BONUS_P - cost + proceeds,
    });
    // Back at the initial state: the AMM is where it started, with both trades on the books.
    expect(await marketRow()).toMatchObject({
      qYes: market.qYes,
      qNo: market.qNo,
      lastPrice: 50,
      tradeCount: 2,
      traderCount: 1,
      volumeP: cost + proceeds,
    });
  });

  it('prices NO symmetrically: the NO price is 100 − YES within ±1', async () => {
    // Two accounts: two 100-contract buys (~5,125P each) would outrun one sign-up bonus.
    const yesMarket = market;
    const noMarket = await createMarket(t.db);
    const noTrader = await signUpTestUser(t);
    const yes = dataOf(await buy(yesMarket.id, 100));
    const no = dataOf(await buy(noMarket.id, 100, undefined, { outcome: 'NO', as: noTrader }));

    // Same trade mirrored on a fresh 50/50 market: same cost, mirrored probability.
    expect(no.fill.amountP).toBe(yes.fill.amountP);
    expect(no.market.pYesBp).toBe(10_000 - yes.market.pYesBp);
    expect(yes.market.lastPrice).toBe(52);
    expect(no.market.lastPrice).toBe(48);
    const noPrice = 100 - no.market.lastPrice;
    expect(Math.abs(noPrice - yes.market.lastPrice)).toBeLessThanOrEqual(1);

    expect(await marketRow(noMarket.id)).toMatchObject({
      qYes: noMarket.qYes,
      qNo: serializeQuantity(parseQuantity(noMarket.qNo) + 100),
    });
    expect(no.position).toMatchObject({ outcome: 'NO', qty: 100 });
  });

  it('stamps later trades no earlier than earlier ones (clock_timestamp under the lock)', async () => {
    // Five requests race for the lock; whoever waited gets its instant when it holds the
    // lock, not when its transaction began — so ids and timestamps agree.
    const responses = await Promise.all(Array.from({ length: 5 }, () => buy(market.id, 10)));
    expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const later = await buy(market.id, 10);
    expect(later.statusCode).toBe(200);

    const fills = await fillsOf();
    const ticks = await ticksOf();
    expect(fills).toHaveLength(6);
    expect(ticks).toHaveLength(6);
    for (let i = 1; i < fills.length; i += 1) {
      expect(fills[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        fills[i - 1]!.createdAt.getTime(),
      );
      expect(ticks[i]!.ts.getTime()).toBeGreaterThanOrEqual(ticks[i - 1]!.ts.getTime());
    }
    const orders = await ordersOf(user.id);
    for (const fill of fills) {
      const order = orders.find((row) => row.id === fill.orderId);
      expect(order?.createdAt.getTime()).toBe(fill.createdAt.getTime());
    }
    expect(dataOf(later).fill.createdAt >= dataOf(responses[0]!).fill.createdAt).toBe(true);
  });

  it('stamps a trade after the balance lock: one account keeps commit order across markets', async () => {
    // A (this market) takes its advisory lock, then blocks on the market ROW a helper
    // transaction holds — the window in which B (another market, same account) locks the
    // balance row, trades and commits. A then debits the balance B left behind. Stamped
    // before that wait, A would carry the older instant with the newer balance_after_p, and
    // `/me/ledger` (created_at DESC) and a client keeping the newest `user:balance` by ts
    // would both end on B's stale balance.
    const elsewhere = await createMarket(t.db);
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(user.id));
    const holder = await t.db.$client.connect();
    let a: ReturnType<typeof buy> | undefined;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM markets WHERE id = $1 FOR UPDATE', [market.id]);
      a = buy(market.id, 100).then((res) => res);
      await waitForLockWaiter(holder, 'trade A on the market row');
      expect(await ordersOf(user.id)).toHaveLength(0);
      const b = await buy(elsewhere.id, 50);
      expect(b.statusCode).toBe(200);
      // The database clock just before the release: A's instant must follow it.
      const { rows } = await holder.query<{ ms: string }>(
        'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms',
      );
      const releasedMs = Number(rows[0]!.ms);
      await holder.query('COMMIT');
      committed = true;
      const ra = await a;
      expect(ra.statusCode).toBe(200);
      await waitForMessages(received, 4, 'user events of the two trades');

      const ledger = await ledgerOf(user.id);
      const byA = ledger.find((entry) => entry.refId === dataOf(ra).fill.id);
      const byB = ledger.find((entry) => entry.refId === dataOf(b).fill.id);
      expect(byA).toBeDefined();
      expect(byB).toBeDefined();
      expect(byA!.createdAt.getTime()).toBeGreaterThanOrEqual(releasedMs);
      expect(byA!.createdAt.getTime()).toBeGreaterThanOrEqual(byB!.createdAt.getTime());
      expect(byA!.balanceAfterP).toBe(byB!.balanceAfterP + byA!.amountP);
      expectLedgerChain(ledger, (await balanceOf(user.id))!.availableP);
      expect(dataOf(ra).fill.createdAt >= dataOf(b).fill.createdAt).toBe(true);
      expect(dataOf(ra).balance.availableP).toBe(byA!.balanceAfterP.toString());

      // PLAN 8: a client that keeps the newest `user:balance` by ts ends on the true balance.
      const balances = received
        .map((message) => JSON.parse(message) as { type: string; availableP?: string; ts: string })
        .filter((event) => event.type === 'user:balance');
      expect(balances).toHaveLength(2);
      const newest = balances.reduce((kept, event) => (event.ts >= kept.ts ? event : kept));
      expect(newest.availableP).toBe(byA!.balanceAfterP.toString());
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await a?.catch(() => undefined);
      await subscriber.quit();
    }
  });

  it('counts each account once in trader_count', async () => {
    expect((await buy(market.id, 10)).statusCode).toBe(200);
    expect((await buy(market.id, 10)).statusCode).toBe(200);
    expect((await buy(market.id, 10, undefined, { outcome: 'NO' })).statusCode).toBe(200);
    expect(await marketRow()).toMatchObject({ tradeCount: 3, traderCount: 1 });

    const other = await signUpTestUser(t);
    expect((await buy(market.id, 10, undefined, { as: other })).statusCode).toBe(200);
    expect(await marketRow()).toMatchObject({ tradeCount: 4, traderCount: 2 });
    expect(await positionsOf(user.id)).toHaveLength(2);
  });

  it('refuses a body that names another account than the cookie holds (FORBIDDEN)', async () => {
    const other = await signUpTestUser(t);
    const res = await buy(market.id, 10, undefined, { expectedAccountId: other.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN', details: [{ path: ['expectedAccountId'] }] },
    });
    await expectUntouched(market);
    expect(await balanceOf(other.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });
  });

  it('refuses an account with no balance row (404, no field)', async () => {
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, user.id));
    const res = await buy(market.id, 10);
    expect(res.statusCode).toBe(404);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toBeUndefined();
    expect(await ordersOf(user.id)).toHaveLength(0);
    expect(await ledgerOf(user.id)).toHaveLength(1);
    expect(await marketRow()).toMatchObject({ tradeCount: 0 });
  });

  it('refuses a mutation from a foreign Origin (CSRF) and a request without a session', async () => {
    const foreign = await buy(market.id, 10, undefined, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(foreign.json<ErrorBody>().error.details).toBeUndefined();

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/v1/trades',
      headers: { ...jsonHeaders, 'idempotency-key': randomUUID() },
      payload: {
        marketId: market.id,
        outcome: 'YES',
        side: 'buy',
        shares: 10,
        maxCostP: '1000',
        expectedAccountId: user.id,
      },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    await expectUntouched(market);
  });

  it('validates the body and the Idempotency-Key header (PLAN 5.3: guards are mandatory)', async () => {
    const post = (payload: Record<string, unknown>, headers = chargeHeaders(user.cookie)) =>
      t.app.inject({ method: 'POST', url: '/api/v1/trades', headers, payload });
    const base = { marketId: market.id, outcome: 'YES', shares: 10, expectedAccountId: user.id };

    const noGuard = await post({ ...base, side: 'buy' });
    expect(noGuard.statusCode).toBe(400);
    expect(noGuard.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['maxCostP'] }] },
    });
    const wrongGuard = await post({ ...base, side: 'sell', maxCostP: '1000' });
    expect(wrongGuard.statusCode).toBe(400);
    const zero = await post({ ...base, side: 'buy', shares: 0, maxCostP: '1000' });
    expect(zero.statusCode).toBe(400);

    const noKey = await post(
      { ...base, side: 'buy', maxCostP: '1000' },
      {
        ...jsonHeaders,
        cookie: user.cookie,
      },
    );
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['Idempotency-Key'] }] },
    });
    await expectUntouched(market);
  });

  it('refuses a buy that would overflow the position row, naming shares', async () => {
    await createPosition(t.db, {
      userId: user.id,
      marketId: market.id,
      outcome: 'YES',
      qty: POSITION_QTY_MAX,
    });
    const res = await buy(market.id, 1);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['shares'] }] },
    });
    // Rolled back: the debit that ran before the accounting step is gone with it.
    expect(await balanceOf(user.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });
    expect(await ordersOf(user.id)).toHaveLength(0);
    expect(await marketRow()).toMatchObject({ tradeCount: 0 });
  });

  it('GET /me/positions filters by status and keeps a qty-0 row after a full sell', async () => {
    const other = await createMarket(t.db);
    expect((await buy(market.id, 10)).statusCode).toBe(200);
    expect((await sell(market.id, 10)).statusCode).toBe(200);
    expect((await buy(other.id, 5, undefined, { outcome: 'NO' })).statusCode).toBe(200);
    const settledMarket = await createMarket(t.db, { status: 'settled' });
    await createPosition(t.db, {
      userId: user.id,
      marketId: settledMarket.id,
      outcome: 'YES',
      qty: 0,
      realizedPnlP: 700n,
      settled: true,
    });
    // Somebody else's row never shows.
    const stranger = await signUpTestUser(t);
    expect((await buy(market.id, 3, undefined, { as: stranger })).statusCode).toBe(200);

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
      [other.id, 'NO', 5],
      [market.id, 'YES', 0],
    ]);
    expect(open[1]).toMatchObject({
      marketSlug: market.slug,
      marketTitle: market.title,
      marketStatus: 'open',
      costBasisP: '0',
      settled: false,
    });
    expect(BigInt(open[1]!.realizedPnlP)).toBeLessThanOrEqual(0n);

    const settled = await list('?status=settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      marketId: settledMarket.id,
      marketStatus: 'settled',
      qty: 0,
      realizedPnlP: '700',
      settled: true,
    });

    const all = await list();
    expect(all).toHaveLength(3);
    expect(all.map((row) => row.marketId)).toEqual([settledMarket.id, other.id, market.id]);

    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/positions?status=closed',
      headers: { cookie: user.cookie },
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/positions' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('GET /me/orders pages newest first with the fill joined in', async () => {
    const second = await createMarket(t.db);
    expect((await buy(market.id, 10)).statusCode).toBe(200);
    expect((await buy(second.id, 20)).statusCode).toBe(200);
    expect((await sell(market.id, 4)).statusCode).toBe(200);
    const other = await signUpTestUser(t);
    expect((await buy(market.id, 7, undefined, { as: other })).statusCode).toBe(200);

    const fetchPage = async (query: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/orders${query}`,
        headers: { cookie: user.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: Order[]; meta: { nextCursor: string | null } }>();
    };

    const first = await fetchPage('?limit=2');
    expect(first.data.map((order) => [order.marketId, order.side, order.qty])).toEqual([
      [market.id, 'sell', 4],
      [second.id, 'buy', 20],
    ]);
    expect(first.meta.nextCursor).toBeTypeOf('string');
    const [sellOrder, buyOrder] = first.data;
    const fills = await t.db.select().from(schema.fills);
    const sellFill = fills.find((fill) => fill.orderId === sellOrder!.id)!;
    expect(sellOrder).toMatchObject({
      marketSlug: market.slug,
      marketTitle: market.title,
      type: 'market',
      filledQty: 4,
      status: 'filled',
      amountP: sellFill.amountP.toString(),
      priceAvgBp: sellFill.priceAvgBp,
      maxCostP: null,
      minProceedsP: '0',
    });
    expect(buyOrder).toMatchObject({
      marketSlug: second.slug,
      maxCostP: '2000',
      minProceedsP: null,
    });

    const rest = await fetchPage(`?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(rest.data.map((order) => [order.marketId, order.side, order.qty])).toEqual([
      [market.id, 'buy', 10],
    ]);
    expect(rest.meta.nextCursor).toBeNull();

    // A malformed cursor serves the first page rather than a 500 (uuid-shaped id half).
    const malformed = await fetchPage('?cursor=0_not-a-uuid');
    expect(malformed.data).toHaveLength(3);

    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me/orders' });
    expect(anonymous.statusCode).toBe(401);
  });
});
