import { randomUUID } from 'node:crypto';
import {
  ORDER_ACCEPTING_SETTING,
  type OrderSide,
  type Outcome,
  type TimeInForce,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasMarketFill } from './market-dispute.js';
import { pauseMarket } from './market-pause.js';
import { DAY_AGO, marketPriceAt, newHumanParticipants, recordFillStats } from './market-stats.js';
import { lockMarketOrders } from './order-cancel.js';
import { placeOrder, type PlaceOrderResult } from './orders.js';
import { fills, markets, profiles } from './schema/index.js';
import {
  closeAccount,
  createCorrectedMarket,
  createConfiguredOpenMarket,
  createMarket,
  TEST_MM_TRADING_LIQUIDITY,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds } from './test/ledger.js';
import {
  NO_MARKET_STATS,
  cancelTestAccountOrders,
  cancelTestOrder,
  checkMarketStats,
  checkOrderInvariants,
  closeTestMarket,
  createFillRecord,
  createFillSeries,
  marketStatsOf,
  MARKET_STATS_CHECK_SQL,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/**
 * 시장 통계 (#121, ADR-0116; ADR-0107 결정 1 #177 11–15항, 결정 4 #121 rows) against the test
 * database, through the real intake: the 시장가격 and its time, the volume (each match once), the
 * fill count and the person participants after each kind of fill; nothing for an intake that
 * filled nothing or for any other writer; the races on the market lock; the 24-hours-ago price.
 * Each case that fills through the intake reads the statistics back against the fills
 * (`expectSound`: the result and the row, `checkMarketStats`, `checkOrderInvariants`), but the
 * newcomers and the edit-time cases, which check one thing each. The refused call, the 시장가격 at
 * an instant, the `DAY_AGO` and the series cases build their fills with the fixtures, which write
 * no statistics on purpose (ADR-0116 결정 2), so they skip that check — the series case asserts the
 * check flags its market.
 */
describe.skipIf(!hasTestDb())('market statistics (#121, docker test profile)', () => {
  let t: TestDb;
  let adminId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const market = async (input: Parameters<typeof createMarket>[1] = {}) =>
    (await createMarket(t.db, { createdBy: adminId, ...input })).id;
  const riskMarket = async (
    input: Omit<Parameters<typeof createConfiguredOpenMarket>[1], 'liquiditySettings'> = {},
  ) =>
    (
      await createConfiguredOpenMarket(t.db, {
        createdBy: adminId,
        liquiditySettings: TEST_MM_TRADING_LIQUIDITY,
        ...input,
      })
    ).id;

  async function placed(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result;
  }
  /** Shorthand for an order: owner, market, outcome, side, time in force, limit, qty. */
  const order = (
    ownerId: string,
    marketId: string,
    outcome: Outcome,
    side: OrderSide,
    timeInForce: TimeInForce,
    limitPriceCoin: number,
    qty: number,
    extra: Partial<PlaceTestOrderInput> = {},
  ) => placed({ ownerId, marketId, outcome, side, timeInForce, limitPriceCoin, qty, ...extra });
  const stats = (marketId: string) => marketStatsOf(t.db, marketId);
  /** The statistics an intake returned are the row's, and every market's are its fills'. */
  const expectSound = async (done?: Extract<PlaceOrderResult, { kind: 'placed' }>) => {
    if (done !== undefined && done.stats !== null) {
      expect(done.stats).toMatchObject(await stats(done.order.marketId));
    }
    expect(await checkMarketStats(t.db)).toEqual([]);
    expect(await checkOrderInvariants(t.db)).toEqual([]);
  };

  describe('nothing before a fill', () => {
    it('reads 체결 없음 on a fresh market and after every intake that filled nothing', async () => {
      const m = await market();
      expect(await stats(m)).toEqual(NO_MARKET_STATS);
      const a = await member();
      const b = await member(10n);
      // A resting order, a refused one, an immediate order with nothing to meet.
      const resting = await order(a, m, 'NO', 'buy', 'gtc', 40, 2);
      expect(resting.order.status).toBe('open');
      expect(resting.stats).toBeNull();
      const broke = await order(b, m, 'YES', 'buy', 'gtc', 50, 1);
      expect(broke.order.rejectReason).toBe('insufficient_coin');
      expect(broke.stats).toBeNull();
      const lonely = await order(b, m, 'NO', 'buy', 'ioc', 5, 1);
      expect(lonely.order.status).not.toBe('filled');
      expect(lonely.fills).toEqual([]);
      expect(lonely.stats).toBeNull();
      // The request answered again, and another with other terms: nothing written.
      const requestId = randomUUID();
      await order(b, m, 'YES', 'buy', 'gtc', 5, 1, { requestId });
      expect(
        (await placeTestOrder(t.db, { ownerId: b, marketId: m, requestId, limitPriceCoin: 5 }))
          .kind,
      ).toBe('replayed');
      expect(
        (await placeTestOrder(t.db, { ownerId: b, marketId: m, requestId, limitPriceCoin: 6 }))
          .kind,
      ).toBe('conflict');
      // A market refused before the book: paused, not found; and a closed intake.
      const paused = await market({ status: 'paused' });
      expect((await order(b, paused, 'YES', 'buy', 'gtc', 5, 1)).order.rejectReason).toBe('paused');
      const draft = await market({ status: 'draft' });
      expect((await placeTestOrder(t.db, { ownerId: b, marketId: draft })).kind).toBe('not_found');
      await setReleaseSetting(t.db, {
        adminId,
        key: ORDER_ACCEPTING_SETTING.key,
        status: 'test',
        value: false,
      });
      expect(
        (
          await placeTestOrder(t.db, {
            ownerId: b,
            marketId: m,
            outcome: 'YES',
            limitPriceCoin: 99,
            timeInForce: 'ioc',
          })
        ).kind,
      ).toBe('closed');
      for (const id of [m, paused, draft]) expect(await stats(id)).toEqual(NO_MARKET_STATS);
      await expectSound();
    });

    it('records nothing from a refused statistics call', async () => {
      const m = await market();
      await expect(
        t.db.transaction((tx) =>
          recordFillStats(tx, { marketId: m, fills: [], newParticipants: 0 }),
        ),
      ).rejects.toThrow(RangeError);
      const { fill } = await createFillRecord(t.db, {
        marketId: m,
        incomingOwnerId: await member(),
        restingOwnerId: await member(),
      });
      const other = await market();
      await expect(
        t.db.transaction((tx) =>
          recordFillStats(tx, { marketId: other, fills: [fill], newParticipants: 0 }),
        ),
      ).rejects.toThrow(RangeError);
      await expect(
        t.db.transaction((tx) =>
          recordFillStats(tx, { marketId: m, fills: [fill], newParticipants: -1 }),
        ),
      ).rejects.toThrow(RangeError);
      expect(await stats(m)).toEqual(NO_MARKET_STATS);
      expect(await stats(other)).toEqual(NO_MARKET_STATS);
    });
  });

  describe('each kind of fill', () => {
    it('counts a pair mint once at its YES price: 60 × qty, not the NO side too', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 2);
      const done = await order(b, m, 'YES', 'buy', 'ioc', 65, 2);
      expect(done.fills.map((f) => [f.kind, f.qty, f.priceCoin, f.yesPriceCoin])).toEqual([
        ['pair_mint', 2, 60, 60],
      ]);
      expect(await stats(m)).toEqual({
        lastPrice: 60,
        lastFillAt: done.fills[0]!.createdAt,
        volumeCoin: 120n,
        tradeCount: 1,
        traderCount: 2,
      });
      await expectSound(done);
    });

    it('takes a NO fill at its YES value: a NO trade at 45 is 55', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const c = await member();
      await order(a, m, 'YES', 'buy', 'gtc', 60, 1);
      await order(b, m, 'NO', 'buy', 'ioc', 45, 1); // a pair mint: B holds a NO
      const sell = await order(b, m, 'NO', 'sell', 'gtc', 45, 1);
      expect(sell.stats).toBeNull();
      const done = await order(c, m, 'NO', 'buy', 'ioc', 50, 1);
      expect(done.fills.map((f) => [f.kind, f.outcome, f.priceCoin, f.yesPriceCoin])).toEqual([
        ['trade', 'NO', 45, 55],
      ]);
      expect(await stats(m)).toEqual({
        lastPrice: 55,
        lastFillAt: done.fills[0]!.createdAt,
        volumeCoin: 40n + 45n,
        tradeCount: 2,
        traderCount: 3,
      });
      await expectSound(done);
    });

    it('takes the last of an order’s fills by id, sums them, and counts a person met twice once', async () => {
      const m = await market();
      const b1 = await member();
      const b2 = await member();
      await order(b1, m, 'NO', 'buy', 'gtc', 40, 1);
      await order(b2, m, 'NO', 'buy', 'gtc', 38, 1);
      await order(b1, m, 'NO', 'buy', 'gtc', 36, 1);
      const a = await member();
      const done = await order(a, m, 'YES', 'buy', 'ioc', 99, 3);
      expect(done.fills.map((f) => f.yesPriceCoin)).toEqual([60, 62, 64]);
      // One instant, so the last is the last in walk order (the highest id).
      expect(new Set(done.fills.map((f) => f.createdAt.getTime())).size).toBe(1);
      expect(await stats(m)).toEqual({
        lastPrice: 64,
        lastFillAt: done.fills[2]!.createdAt,
        volumeCoin: 60n + 62n + 64n,
        tradeCount: 3,
        traderCount: 3,
      });
      await expectSound(done);
    });

    it('counts a budget order like any other', async () => {
      const m = await market();
      const b = await member();
      await order(b, m, 'NO', 'buy', 'gtc', 40, 3);
      const a = await member();
      const done = await placed({ ownerId: a, marketId: m, limitPriceCoin: 65, budgetCoin: 130n });
      expect(done.fills.map((f) => [f.qty, f.yesPriceCoin, f.amountCoin])).toEqual([[2, 60, 120n]]);
      expect(await stats(m)).toEqual({
        lastPrice: 60,
        lastFillAt: done.fills[0]!.createdAt,
        volumeCoin: 120n,
        tradeCount: 1,
        traderCount: 2,
      });
      await expectSound(done);
    });

    it('counts the 운영 마켓메이커’s fills in price and volume but never as a participant', async () => {
      const m = await riskMarket();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const a = await member();
      // The bot resting, a member coming in.
      await order(mm, m, 'NO', 'buy', 'gtc', 40, 2);
      const first = await order(a, m, 'YES', 'buy', 'ioc', 65, 1);
      expect(await stats(m)).toMatchObject({ lastPrice: 60, volumeCoin: 60n, traderCount: 1 });
      await expectSound(first);
      // The bot coming in against a member's bid (already a participant), then a new member's.
      await order(a, m, 'YES', 'buy', 'gtc', 55, 1);
      const second = await order(mm, m, 'NO', 'buy', 'ioc', 45, 1);
      expect(second.fills.map((f) => [f.kind, f.yesPriceCoin, f.incomingAccountType])).toEqual([
        ['pair_mint', 55, 'market_maker'],
      ]);
      expect(await stats(m)).toMatchObject({
        lastPrice: 55,
        volumeCoin: 60n + 45n,
        tradeCount: 2,
        traderCount: 1,
      });
      await expectSound(second);
      const b = await member();
      await order(b, m, 'YES', 'buy', 'gtc', 52, 1);
      const third = await order(mm, m, 'NO', 'buy', 'ioc', 48, 1);
      expect(await stats(m)).toEqual({
        lastPrice: 52,
        lastFillAt: third.fills[0]!.createdAt,
        volumeCoin: 60n + 45n + 48n,
        tradeCount: 3,
        traderCount: 2,
      });
      await expectSound(third);
    });

    it('adds two for two new people, none for a repeat or a resting order filled before', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const c = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 3);
      await order(b, m, 'YES', 'buy', 'ioc', 60, 1);
      expect((await stats(m)).traderCount).toBe(2);
      // A's order was partly filled before: only C is new.
      await order(c, m, 'YES', 'buy', 'ioc', 60, 1);
      expect((await stats(m)).traderCount).toBe(3);
      // B again, against A again: nobody new.
      const again = await order(b, m, 'YES', 'buy', 'ioc', 60, 1);
      expect(await stats(m)).toMatchObject({ traderCount: 3, tradeCount: 3, volumeCoin: 180n });
      await expectSound(again);
    });
  });

  describe('participants', () => {
    it('never fewer: a full sell, a closure and an admin role keep the count', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const c = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 2);
      await order(b, m, 'YES', 'buy', 'ioc', 60, 2);
      await order(c, m, 'YES', 'buy', 'gtc', 58, 2);
      // B sells every YES it holds to C: B holds none, and is still a participant.
      const sold = await order(b, m, 'YES', 'sell', 'ioc', 55, 2);
      expect(sold.fills.map((f) => [f.kind, f.priceCoin])).toEqual([['trade', 58]]);
      expect(await stats(m)).toMatchObject({ traderCount: 3, volumeCoin: 120n + 116n });
      await expectSound(sold);
      await closeAccount(t.db, b);
      await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, a));
      expect((await stats(m)).traderCount).toBe(3);
      await expectSound();
    });

    it('is the number of people with a fill on the market, as 판정 이의 counts them', async () => {
      const m = await riskMarket();
      const mm = await fundMarketMakerFunds(t.db, m, 1_000n);
      const people = [await member(), await member(), await member(), await member()];
      const idle = await member();
      await order(people[0]!, m, 'NO', 'buy', 'gtc', 40, 2);
      await order(people[1]!, m, 'YES', 'buy', 'ioc', 60, 1);
      await order(mm, m, 'NO', 'buy', 'gtc', 41, 1);
      await order(people[2]!, m, 'YES', 'buy', 'ioc', 59, 1); // meets the bot
      await order(people[3]!, m, 'YES', 'buy', 'ioc', 60, 1); // meets people[0] again
      await order(idle, m, 'YES', 'buy', 'gtc', 10, 1); // rests, fills nothing
      await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, people[3]!));
      let eligible = 0;
      for (const id of [...people, idle, mm, adminId]) {
        if (await hasMarketFill(t.db, id, m)) eligible += 1;
      }
      expect(eligible).toBe(4);
      expect((await stats(m)).traderCount).toBe(eligible);
      await expectSound();
    });

    it('reads the newcomers among the given people from the orders filled before', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 1);
      await order(b, m, 'YES', 'buy', 'ioc', 60, 1);
      const c = await member();
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, m);
        expect(await newHumanParticipants(tx, m, [])).toBe(0);
        expect(await newHumanParticipants(tx, m, [a, b])).toBe(0);
        expect(await newHumanParticipants(tx, m, [a, c, c])).toBe(1);
      });
    });
  });

  it('leaves the market’s edit time as it was', async () => {
    const m = await market();
    const before = (await t.db.select().from(markets).where(eq(markets.id, m)))[0]!.updatedAt;
    await order(await member(), m, 'NO', 'buy', 'gtc', 40, 1);
    await order(await member(), m, 'YES', 'buy', 'ioc', 60, 1);
    const row = (await t.db.select().from(markets).where(eq(markets.id, m)))[0]!;
    expect(row.tradeCount).toBe(1);
    expect(row.updatedAt).toEqual(before);
  });

  describe('nothing else writes them', () => {
    it('keeps them through a cancel, an account’s batch, a pause and the close’s expiry', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 3);
      await order(b, m, 'YES', 'buy', 'ioc', 60, 1);
      const traded = await stats(m);
      expect(traded.tradeCount).toBe(1);
      const own = await order(b, m, 'YES', 'buy', 'gtc', 30, 1);
      expect((await cancelTestOrder(t.db, { ownerId: b, orderId: own.order.id })).kind).toBe(
        'cancelled',
      );
      expect(await stats(m)).toEqual(traded);
      await order(b, m, 'YES', 'buy', 'gtc', 30, 1);
      await cancelTestAccountOrders(t.db, b, 'restricted');
      expect(await stats(m)).toEqual(traded);
      // A pause ends the live orders (A's remainder) under the market lock.
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, m);
        const [row] = await tx.select().from(markets).where(eq(markets.id, m)).for('update');
        const done = await pauseMarket(tx, {
          market: row!,
          orders: await lockMarketOrders(tx, m),
          now: await clockTimestamp(tx),
          actorId: adminId,
          reason: 'basis_change',
          note: '시험',
          resultPublishedAt: null,
        });
        expect(done.paused).toBe(true);
      });
      expect(await stats(m)).toEqual(traded);
      // Another market's close expires its resting orders.
      const closing = await market();
      await order(a, closing, 'NO', 'buy', 'gtc', 40, 2);
      await order(b, closing, 'YES', 'buy', 'ioc', 60, 1);
      const before = await stats(closing);
      await passMarketClose(t.db, closing);
      const closed = await closeTestMarket(t.db, closing);
      expect(closed.closed && closed.expired.expired).toHaveLength(1);
      expect(await stats(closing)).toEqual(before);
      await expectSound();
    });

    it('keeps them and the fills through a judgement, its correction and the confirmation', async () => {
      // #121 수용 기준: 판정·정산은 가격 기록과 마지막 체결가를 바꾸지 않는다 — the real approval,
      // correction and confirmation (the factories call approveMarketJudgement,
      // correctMarketJudgement and resolveProvisionalMarket), each read back.
      const m = await market();
      const a = await member();
      const b = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 2);
      await order(b, m, 'YES', 'buy', 'ioc', 60, 1);
      await passMarketClose(t.db, m);
      expect((await closeTestMarket(t.db, m)).closed).toBe(true);
      const traded = await stats(m);
      expect(traded).toMatchObject({ lastPrice: 60, tradeCount: 1, traderCount: 2 });
      const record = () => t.db.select().from(fills).where(eq(fills.marketId, m));
      const recorded = await record();
      expect(recorded).toHaveLength(1);
      await createProvisionalMarket(t.db, { marketId: m, result: 'YES' });
      expect(await stats(m)).toEqual(traded);
      await createCorrectedMarket(t.db, { marketId: m });
      expect(await stats(m)).toEqual(traded);
      const { market: resolved } = await resolveMarketNow(t.db, m);
      expect(resolved.status).toBe('resolved');
      expect(await stats(m)).toEqual(traded);
      expect(await record()).toEqual(recorded);
      await expectSound();
    });
  });

  describe('races', () => {
    it('serialises two intakes of one market on its lock: no count is lost', async () => {
      const m = await market();
      const a = await member();
      await order(a, m, 'NO', 'buy', 'gtc', 40, 5);
      const b = await member();
      const c = await member();
      let go!: () => void;
      const held = new Promise<void>((resolve) => (go = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const first = t.db.transaction(async (tx) => {
        const done = await placeOrder(tx, {
          ownerId: b,
          marketId: m,
          requestId: randomUUID(),
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'ioc',
          limitPriceCoin: 60,
          qty: 2,
          budgetCoin: null,
        });
        entered();
        await held;
        return done;
      });
      await inside;
      const second = order(c, m, 'YES', 'buy', 'ioc', 60, 1);
      await waitForLockWaiter(t.db.$client, 'the second intake waits on the market');
      // Another market's intake does not wait for it.
      const other = await market();
      await order(await member(), other, 'NO', 'buy', 'gtc', 40, 1);
      const elsewhere = await order(await member(), other, 'YES', 'buy', 'ioc', 60, 1);
      expect(elsewhere.stats).toMatchObject({ tradeCount: 1, traderCount: 2 });
      go();
      const one = await first;
      const two = await second;
      expect(one.kind === 'placed' && one.stats).toMatchObject({ tradeCount: 1, traderCount: 2 });
      expect(two.stats).toMatchObject({ tradeCount: 2, traderCount: 3, volumeCoin: 180n });
      expect(two.stats).toMatchObject(await stats(m));
      await expectSound();
    });

    it('counts two new people coming at once as two, in many rounds and two markets', async () => {
      for (let round = 0; round < 3; round += 1) {
        const m1 = await market();
        const m2 = await market();
        const a = await member();
        await order(a, m1, 'NO', 'buy', 'gtc', 40, 2);
        await order(a, m2, 'NO', 'buy', 'gtc', 40, 2);
        const people = [await member(), await member(), await member(), await member()];
        await Promise.all([
          order(people[0]!, m1, 'YES', 'buy', 'ioc', 60, 1),
          order(people[1]!, m1, 'YES', 'buy', 'ioc', 60, 1),
          order(people[2]!, m2, 'YES', 'buy', 'ioc', 60, 1),
          order(people[3]!, m2, 'YES', 'buy', 'ioc', 60, 1),
        ]);
        for (const id of [m1, m2]) {
          expect(await stats(id)).toMatchObject({
            tradeCount: 2,
            traderCount: 3,
            volumeCoin: 120n,
          });
        }
      }
      await expectSound();
    });
  });

  describe('the 시장가격 at an instant (the change badge’s baseline)', () => {
    const at = (iso: string) => sql`${iso}::timestamptz`;

    it('is the last fill at or before it, the higher id on a tie, and null with none', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      expect(await marketPriceAt(t.db, m, at('2026-11-07T00:00:00Z'))).toBeNull();
      const record = (iso: string, priceCoin: number, outcome: Outcome = 'YES') =>
        createFillRecord(t.db, {
          marketId: m,
          incomingOwnerId: a,
          restingOwnerId: b,
          outcome,
          priceCoin,
          createdAt: new Date(iso),
        });
      await record('2026-11-06T10:00:00.000Z', 40);
      await record('2026-11-06T12:00:00.000Z', 45);
      await record('2026-11-06T12:00:00.000Z', 30, 'NO'); // the same instant, a higher id: 70
      await record('2026-11-06T13:00:00.000Z', 80);
      expect(await marketPriceAt(t.db, m, at('2026-11-06T09:59:59.999Z'))).toBeNull();
      expect(await marketPriceAt(t.db, m, at('2026-11-06T10:00:00.000Z'))).toBe(40);
      expect(await marketPriceAt(t.db, m, at('2026-11-06T11:59:59.999Z'))).toBe(40);
      expect(await marketPriceAt(t.db, m, at('2026-11-06T12:00:00.000Z'))).toBe(70);
      expect(await marketPriceAt(t.db, m, at('2026-11-06T12:59:59.999Z'))).toBe(70);
      expect(await marketPriceAt(t.db, m, at('2026-11-07T00:00:00.000Z'))).toBe(80);
      // Another market's fills are not this one's.
      expect(await marketPriceAt(t.db, await market(), at('2026-11-07T00:00:00.000Z'))).toBeNull();
    });

    it('reads 24 hours back on the DB clock: none, or the one before — never the open’s 50%', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      expect(await marketPriceAt(t.db, m, DAY_AGO)).toBeNull();
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
      await createFillSeries(t.db, {
        marketId: m,
        incomingOwnerId: a,
        restingOwnerId: b,
        points: [{ at: hoursAgo(23), yesPriceCoin: 70 }],
      });
      expect(await marketPriceAt(t.db, m, DAY_AGO)).toBeNull();
      await createFillSeries(t.db, {
        marketId: m,
        incomingOwnerId: a,
        restingOwnerId: b,
        points: [
          { at: hoursAgo(26), yesPriceCoin: 30 },
          { at: hoursAgo(25), yesPriceCoin: 35 },
        ],
      });
      expect(await marketPriceAt(t.db, m, DAY_AGO)).toBe(35);
    });

    it('takes a fill exactly 24 hours before the DB clock, not one a millisecond later', async () => {
      // The edge to the millisecond, against the transaction's fixed `now()`: the fills are
      // committed from another connection after the clock is read, and READ COMMITTED shows them
      // to the next statement while `now()` stays put. An hour too far or too short, the host's
      // clock, or an open end (`<`) each picks another price (ADR-0116 결정 4; the closed end
      // beside 추천's `(asOf − 24h, asOf]`, ADR-0065).
      const m = await market();
      const a = await member();
      const b = await member();
      await t.db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`SELECT (extract(epoch FROM date_trunc('milliseconds', now())) * 1000)::bigint::text
            AS ms`,
        );
        const now = Number(result.rows[0]?.ms);
        expect(Number.isSafeInteger(now)).toBe(true);
        const dayAgo = now - 24 * 3_600_000;
        const record = (ms: number, priceCoin: number) =>
          createFillRecord(t.db, {
            marketId: m,
            incomingOwnerId: a,
            restingOwnerId: b,
            outcome: 'YES',
            priceCoin,
            createdAt: new Date(ms),
          });
        await record(dayAgo - 3_600_000, 20);
        await record(dayAgo - 1, 30);
        await record(dayAgo, 40);
        await record(dayAgo + 1, 60);
        await record(dayAgo + 3_600_000, 70);
        expect(await marketPriceAt(tx, m, DAY_AGO)).toBe(40);
        // The same instant read as a literal agrees: DAY_AGO is that instant and nothing else.
        const literal = sql`${new Date(dayAgo).toISOString()}::timestamptz`;
        expect(await marketPriceAt(tx, m, literal)).toBe(40);
      });
    });

    it('writes a series as fills in point order, every row its price’s', async () => {
      const m = await market();
      const a = await member();
      const b = await member();
      const base = Date.parse('2026-11-01T00:00:00.000Z');
      const points = Array.from({ length: 500 }, (_, i) => ({
        at: new Date(base + Math.floor(i / 2) * 1000),
        yesPriceCoin: 1 + (i % 99),
      }));
      const made = await createFillSeries(t.db, {
        marketId: m,
        incomingOwnerId: a,
        restingOwnerId: b,
        points,
      });
      expect(made.map((f) => [f.createdAt.getTime(), f.yesPriceCoin])).toEqual(
        points.map((p) => [p.at.getTime(), p.yesPriceCoin]),
      );
      expect(made.map((f) => f.id)).toEqual([...made.map((f) => f.id)].sort((x, y) => x - y));
      expect(await t.db.$count(fills)).toBe(500);
      // A read fixture: no statistic moved, which the check names.
      expect(await stats(m)).toEqual(NO_MARKET_STATS);
      expect((await t.db.$client.query(MARKET_STATS_CHECK_SQL)).rows).toHaveLength(1);
    });
  });
});
