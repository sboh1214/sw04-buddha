import {
  bookDepth,
  marketTradingRejectReason,
  ORDER_ACCEPTING_SETTING,
  orderBookOf,
  quoteOrder,
  sellableOf,
  type OrderQuoteFigures,
  type OrderSide,
  type Outcome,
  type QuoteTerms,
  type TimeInForce,
} from '@buddha/shared';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { cancelledMarketIds } from './order-cancel.js';
import { readHoldings, readMarketTradingFacts, readPublicBook } from './order-book.js';
import { ownerOf, placeOrderChangedBook, type PlaceOrderResult } from './orders.js';
import { balances, fills, ledgerEntries, markets, orders, positions } from './schema/index.js';
import {
  createMarket,
  createMarketPause,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundMarketMakerFunds, mintTestPairs } from './test/ledger.js';
import {
  checkOrderInvariants,
  closeTestMarket,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  type PlaceTestOrderInput,
} from './test/orders.js';
import { clockTimestamp } from './tx-helpers.js';

/**
 * 공개 호가와 견적의 읽기 (#179, ADR-0114): the readers against the test database in one REPEATABLE
 * READ READ ONLY snapshot — the quote equals what the real intake fills on the same book, the depth
 * counts each order once, the reads write and lock nothing, and a market that takes no order (a
 * ledger hold's locked orders among them) offers no liquidity.
 */
describe.skipIf(!hasTestDb())('the public book and quotes (#179, docker test profile)', () => {
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

  const member = async (coin = 10_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const market = async (priceProtectionTicks = 10) =>
    (await createMarket(t.db, { createdBy: adminId, priceProtectionTicks })).id;
  /** A person holding `qty` of `outcome` in `marketId` (a pair mint at 50 with a fresh member). */
  const holder = async (marketId: string, outcome: Outcome, qty: number) => {
    const id = await member(10_000n + 50n * BigInt(qty));
    const other = await member(50n * BigInt(qty));
    await mintTestPairs(t.db, {
      marketId,
      yesHolderId: outcome === 'YES' ? id : other,
      noHolderId: outcome === 'YES' ? other : id,
      qty,
    });
    return id;
  };
  async function placed(input: PlaceTestOrderInput) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result;
  }
  /** A resting GTC order: owner, market, outcome, side, limit, qty. */
  const rest = async (
    ownerId: string,
    marketId: string,
    outcome: Outcome,
    side: OrderSide,
    limitPriceCoin: number,
    qty: number,
  ) => {
    const done = await placed({ ownerId, marketId, outcome, side, limitPriceCoin, qty });
    expect(done.order.status).toBe('open');
    return done.order;
  };
  /** The API's snapshot: one REPEATABLE READ READ ONLY transaction. */
  const snapshot = <T>(
    read: (tx: Parameters<Parameters<TestDb['db']['transaction']>[0]>[0]) => Promise<T>,
  ) => t.db.transaction(read, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  /** The public quote as the API computes it: facts, the book when OPEN, no owner. */
  const quoteNow = (marketId: string, terms: QuoteTerms) =>
    snapshot(async (tx) => {
      const facts = (await readMarketTradingFacts(tx, marketId))!;
      const book =
        marketTradingRejectReason(facts) === null ? await readPublicBook(tx, marketId) : [];
      return quoteOrder(book, facts, terms, null);
    });
  const figuresOf = async (marketId: string, terms: QuoteTerms): Promise<OrderQuoteFigures> => {
    const answer = await quoteNow(marketId, terms);
    if (answer.kind !== 'quoted') throw new Error(`expected a quote, got ${answer.kind}`);
    return answer.figures;
  };
  const bookNow = (marketId: string) =>
    snapshot(async (tx) => {
      const facts = (await readMarketTradingFacts(tx, marketId))!;
      return orderBookOf(marketId, facts, await readPublicBook(tx, marketId));
    });
  /** What a read must leave as is: every row an intake or a cancel writes, and every balance. */
  const written = async () => ({
    orders: await t.db.select().from(orders).orderBy(orders.arrivalSeq),
    fills: (await t.db.select({ n: count() }).from(fills))[0]!.n,
    entries: (await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n,
    positions: await t.db.select().from(positions).orderBy(positions.userId, positions.outcome),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
  });
  const terms = (overrides: Partial<QuoteTerms>): QuoteTerms => ({
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: null,
    qty: 1,
    budgetCoin: null,
    ...overrides,
  });

  /**
   * Two people, a converted NO buy, the 운영 마켓메이커 on both sides and partial levels:
   * YES asks 58×2 (B), 60×3 (A's NO buy at 40), 62×5 (the bot's NO buy at 38), 63×4 (B);
   * YES bids 45×4 (A), 44×3 (the bot).
   */
  async function seededBook() {
    const m = await market();
    const a = await member();
    const b = await holder(m, 'YES', 10);
    const mm = await fundMarketMakerFunds(t.db, m, 5_000n);
    await rest(a, m, 'NO', 'buy', 40, 3);
    await rest(b, m, 'YES', 'sell', 58, 2);
    await rest(mm, m, 'NO', 'buy', 38, 5);
    await rest(b, m, 'YES', 'sell', 63, 4);
    await rest(a, m, 'YES', 'buy', 45, 4);
    await rest(mm, m, 'YES', 'buy', 44, 3);
    return { m, a, b, mm };
  }

  /**
   * Quotes `quote` with no owner, then a fresh member with no order in the walk places the same
   * terms with the quoted limit: the order is the quote, field by field (#179 AC6).
   */
  async function expectQuoteIsFill(
    m: string,
    quote: QuoteTerms,
  ): Promise<Extract<PlaceOrderResult, { kind: 'placed' }>> {
    const figures = await figuresOf(m, quote);
    const ownerId =
      quote.side === 'sell' ? await holder(m, quote.outcome, quote.qty!) : await member(100_000n);
    const done = await placed({
      ownerId,
      marketId: m,
      outcome: quote.outcome,
      side: quote.side,
      timeInForce: quote.timeInForce,
      limitPriceCoin: figures.protectedLimitPriceCoin,
      qty: quote.qty,
      budgetCoin: quote.budgetCoin,
    });
    expect({
      protectedLimitPriceCoin: done.order.protectedLimitPrice,
      filledQty: done.order.filledQty,
      filledAmountCoin: done.order.filledAmountCoin,
      remainingQty: done.order.qty === null ? null : done.order.qty - done.order.filledQty,
      unspentCoin: done.order.unspentCoin,
      status: done.order.status,
      rejectReason: done.order.rejectReason,
      cancelReason: done.order.cancelReason,
    }).toEqual({
      protectedLimitPriceCoin: figures.protectedLimitPriceCoin,
      filledQty: figures.filledQty,
      filledAmountCoin: figures.filledAmountCoin,
      remainingQty: figures.remainingQty,
      unspentCoin: figures.unspentCoin,
      status: figures.status,
      rejectReason: figures.rejectReason,
      cancelReason: figures.cancelReason,
    });
    return done;
  }

  describe('the book', () => {
    it('merges converted supply into the asks, keeps the bids direct, and counts each order once', async () => {
      const { m } = await seededBook();
      const book = await bookNow(m);
      expect(book).toEqual({
        marketId: m,
        marketRejectReason: null,
        contracts: [
          {
            outcome: 'YES',
            asks: [
              { priceCoin: 58, qty: 2 },
              { priceCoin: 60, qty: 3 },
              { priceCoin: 62, qty: 5 },
              { priceCoin: 63, qty: 4 },
            ],
            bids: [
              { priceCoin: 45, qty: 4 },
              { priceCoin: 44, qty: 3 },
            ],
            bestAskCoin: 58,
            bestBidCoin: 45,
          },
          {
            outcome: 'NO',
            asks: [
              { priceCoin: 55, qty: 4 },
              { priceCoin: 56, qty: 3 },
            ],
            bids: [
              { priceCoin: 40, qty: 3 },
              { priceCoin: 38, qty: 5 },
            ],
            bestAskCoin: 55,
            bestBidCoin: 40,
          },
        ],
      });
      // A's NO buy shows twice (NO bid 40, YES ask 60) and fills 3 at most: a YES buy of all the
      // asks fills Σ YES asks, each order once.
      const all = await figuresOf(m, terms({ qty: 50, limitPriceCoin: 63 }));
      expect(all).toMatchObject({ filledQty: 14, stop: 'no_quote' });
    });

    it('drops the owners’ account types at the boundary: only the matcher’s fields', async () => {
      const { m } = await seededBook();
      const book = await snapshot((tx) => readPublicBook(tx, m));
      expect(book).toHaveLength(6);
      for (const order of book) {
        expect(Object.keys(order).sort()).toEqual([
          'arrival',
          'id',
          'outcome',
          'owner',
          'priceCoin',
          'remainingQty',
          'side',
        ]);
        expect(Object.keys(order.owner).sort()).toEqual(['human', 'id']);
      }
      expect(bookDepth(book)).toEqual((await bookNow(m)).contracts);
    });

    it('offers nothing where no order is taken: SCHEDULED, PAUSED, CLOSED, past close, a hold', async () => {
      // A ledger_failure pause keeps its live orders locked until the recovery (#178).
      const held = await market();
      const a = await member();
      await rest(a, held, 'YES', 'buy', 40, 2);
      await createMarketPause(t.db, { marketId: held, reason: 'ledger_failure', by: adminId });
      // The worker's close (#120): the GTC ends 만료 in the CLOSED market.
      const closed = await market();
      await rest(a, closed, 'NO', 'buy', 30, 1);
      await passMarketClose(t.db, closed);
      expect(await closeTestMarket(t.db, closed)).toMatchObject({ closed: true });
      // OPEN past its close_at, before the worker's transition (ADR-0114 결과 5 '#120'): its
      // resting GTC is still live and locked, and the book, the quote and the intake refuse it.
      const pastClose = await market();
      await rest(a, pastClose, 'YES', 'buy', 35, 4);
      await rest(await holder(pastClose, 'YES', 2), pastClose, 'YES', 'sell', 70, 2);
      await passMarketClose(t.db, pastClose);
      const scheduled = (await createMarket(t.db, { createdBy: adminId, status: 'scheduled' })).id;
      const live = await t.db
        .select({ n: count() })
        .from(orders)
        .where(sql`${orders.status} IN ('open', 'partially_filled')`);
      expect(live[0]!.n).toBe(3);
      for (const [m, reason] of [
        [held, 'paused'],
        [closed, 'closed'],
        [pastClose, 'closed'],
        [scheduled, 'not_open_yet'],
      ] as const) {
        expect(await bookNow(m)).toEqual({
          marketId: m,
          marketRejectReason: reason,
          contracts: bookDepth([]),
        });
        expect(await figuresOf(m, terms({ side: 'sell', qty: 1 }))).toMatchObject({
          filledQty: 0,
          stop: null,
          status: 'rejected',
          rejectReason: reason,
        });
      }
      // The market past its close is still OPEN by status: only the clock refuses it.
      const [open] = await t.db
        .select({ status: markets.status })
        .from(markets)
        .where(eq(markets.id, pastClose));
      expect(open!.status).toBe('open');
      expect(await figuresOf(pastClose, terms({ timeInForce: 'gtc', limitPriceCoin: 70 }))).toEqual(
        expect.objectContaining({ status: 'rejected', rejectReason: 'closed', maxSpendCoin: null }),
      );
      // A held market is never OPEN, so the OPEN-only book never shows its locked orders.
      const heldIds = await ledgerHeldMarketIds(t.db, [held, closed, scheduled]);
      expect(heldIds).toEqual(new Set([held]));
      const statuses = await t.db
        .select({ status: markets.status })
        .from(markets)
        .where(eq(markets.id, held));
      expect(statuses[0]!.status).toBe('paused');
    });
  });

  describe('the quote is the fill (AC6)', () => {
    it('walks several levels of a quantity buy, the converted supply once', async () => {
      const { m } = await seededBook();
      const done = await expectQuoteIsFill(m, terms({ qty: 6 }));
      expect(done.order).toMatchObject({ protectedLimitPrice: 68, filledQty: 6, status: 'filled' });
      expect(done.fills.map((fill) => fill.priceCoin)).toEqual([58, 60, 62]);
    });

    it('stops where the supply inside the limit ends: a partial buy, its rest cancelled', async () => {
      const { m } = await seededBook();
      const done = await expectQuoteIsFill(m, terms({ qty: 20 }));
      expect(done.order).toMatchObject({ filledQty: 14, cancelReason: 'ioc_remainder' });
      const narrow = await seededBook();
      const limited = await expectQuoteIsFill(narrow.m, terms({ qty: 20, limitPriceCoin: 61 }));
      expect(limited.order).toMatchObject({ filledQty: 5, protectedLimitPrice: 61 });
    });

    it('spends a budget no further than the next contract it cannot buy', async () => {
      const { m } = await seededBook();
      const done = await expectQuoteIsFill(m, terms({ qty: null, budgetCoin: 300n }));
      expect(done.order).toMatchObject({
        filledQty: 5,
        filledAmountCoin: 296n,
        unspentCoin: 4n,
        status: 'filled',
      });
      const small = await seededBook();
      const none = await expectQuoteIsFill(small.m, terms({ qty: null, budgetCoin: 57n }));
      expect(none.order).toMatchObject({ status: 'rejected', rejectReason: 'budget_too_small' });
    });

    it('rests a GTC remainder at its own limit', async () => {
      const { m } = await seededBook();
      const done = await expectQuoteIsFill(
        m,
        terms({ timeInForce: 'gtc', limitPriceCoin: 61, qty: 8 }),
      );
      expect(done.order).toMatchObject({ filledQty: 5, status: 'partially_filled' });
    });

    it('sells into the direct bids down to max(best bid − width, 1)', async () => {
      const { m } = await seededBook();
      const done = await expectQuoteIsFill(m, terms({ side: 'sell', qty: 10 }));
      expect(done.order).toMatchObject({
        protectedLimitPrice: 35,
        filledQty: 7,
        filledAmountCoin: 4n * 45n + 3n * 44n,
        cancelReason: 'ioc_remainder',
      });
      const no = await seededBook();
      await expectQuoteIsFill(no.m, terms({ outcome: 'NO', qty: 5 }));
    });

    it('answers 호가 없음 on an empty side, as the intake rejects it', async () => {
      const m = await market();
      const done = await expectQuoteIsFill(m, terms({ qty: 3 }));
      expect(done.order).toMatchObject({ status: 'rejected', rejectReason: 'no_quote' });
      const sell = await expectQuoteIsFill(m, terms({ outcome: 'NO', side: 'sell', qty: 2 }));
      expect(sell.order).toMatchObject({ rejectReason: 'no_quote', protectedLimitPrice: 1 });
    });

    it('holds after mixed sequences of people, the 운영 마켓메이커 and cancels', async () => {
      let state = 179;
      const pick = (n: number) => {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        return (state >>> 8) % n;
      };
      const m = await market(15);
      const people = [await holder(m, 'YES', 30), await holder(m, 'NO', 30), await member()];
      const mm = await fundMarketMakerFunds(t.db, m, 20_000n);
      const owners = [...people, mm];
      let checks = 0;
      for (let step = 0; step < 40; step += 1) {
        const outcome: Outcome = pick(2) === 0 ? 'YES' : 'NO';
        const side: OrderSide = pick(3) === 0 ? 'sell' : 'buy';
        await placeTestOrder(t.db, {
          ownerId: owners[pick(owners.length)]!,
          marketId: m,
          outcome,
          side,
          timeInForce: 'gtc',
          limitPriceCoin: 25 + pick(51),
          qty: 1 + pick(4),
        });
        if (step % 4 !== 3) continue;
        const budget = pick(4) === 0;
        const timeInForce: TimeInForce = budget || pick(3) > 0 ? 'ioc' : 'gtc';
        await expectQuoteIsFill(
          m,
          terms({
            outcome: pick(2) === 0 ? 'YES' : 'NO',
            side: budget || pick(2) === 0 ? 'buy' : 'sell',
            timeInForce,
            limitPriceCoin: timeInForce === 'gtc' || pick(2) === 0 ? 20 + pick(61) : null,
            qty: budget ? null : 1 + pick(6),
            budgetCoin: budget ? BigInt(40 + pick(300)) : null,
          }),
        );
        checks += 1;
      }
      expect(checks).toBe(10);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('quotes while intake is closed, which the intake refuses (ADR-0107 결정 3)', async () => {
      const { m } = await seededBook();
      await setReleaseSetting(t.db, {
        adminId,
        key: ORDER_ACCEPTING_SETTING.key,
        status: 'undecided',
        value: null,
      });
      expect(await figuresOf(m, terms({ qty: 2 }))).toMatchObject({
        filledQty: 2,
        status: 'filled',
      });
      const refused = await placeTestOrder(t.db, { ownerId: await member(), marketId: m });
      expect(refused).toEqual({ kind: 'closed', why: 'intake' });
    });
  });

  describe('the sellable figures (#177 15항)', () => {
    it('quotes the unlocked holding as the holder’s own immediate sell, the resting sells apart', async () => {
      const { m, b } = await seededBook();
      const figures = await snapshot(async (tx) => {
        const facts = (await readMarketTradingFacts(tx, m))!;
        const owner = (await ownerOf(tx, b))!;
        const book = await readPublicBook(tx, m);
        return (await readHoldings(tx, b, m)).map((holding) =>
          sellableOf(book, facts, holding, { id: owner.id, human: owner.human }),
        );
      });
      // B holds 10 YES with 6 in resting sells: 4 quoted, into A's 45×4.
      expect(figures[0]).toMatchObject({
        outcome: 'YES',
        qty: 10,
        restingSellQty: 6,
        unlockedQty: 4,
        quote: {
          protectedLimitPriceCoin: 35,
          filledQty: 4,
          filledAmountCoin: 180n,
          status: 'filled',
        },
      });
      expect(figures[1]).toEqual({
        outcome: 'NO',
        qty: 0,
        restingSellQty: 0,
        unlockedQty: 0,
        quote: null,
      });
      // The sale is what B's own IOC sell of 4 at that limit fills.
      const done = await placed({
        ownerId: b,
        marketId: m,
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'ioc',
        limitPriceCoin: 35,
        qty: 4,
      });
      expect(done.order).toMatchObject({ filledQty: 4, filledAmountCoin: 180n });
    });

    it('stops at the holder’s own bid where the public quote fills (P9)', async () => {
      const m = await market();
      const a = await holder(m, 'YES', 5);
      await rest(a, m, 'YES', 'buy', 45, 2);
      await rest(await member(), m, 'YES', 'buy', 40, 3);
      const [publicQuote, own] = await snapshot(async (tx) => {
        const facts = (await readMarketTradingFacts(tx, m))!;
        const book = await readPublicBook(tx, m);
        const [yes] = await readHoldings(tx, a, m);
        return [
          quoteOrder(book, facts, terms({ side: 'sell', qty: 5 }), null),
          sellableOf(book, facts, yes!, { id: a, human: true }),
        ] as const;
      });
      expect(publicQuote).toMatchObject({ kind: 'quoted', figures: { filledQty: 5 } });
      expect(own.quote).toMatchObject({ filledQty: 0, stop: 'self_trade' });
      const done = await placed({
        ownerId: a,
        marketId: m,
        outcome: 'YES',
        side: 'sell',
        timeInForce: 'ioc',
        limitPriceCoin: own.quote!.protectedLimitPriceCoin,
        qty: 5,
      });
      expect(done.order).toMatchObject({ status: 'rejected', rejectReason: 'self_trade' });
    });

    it('reads the holder’s rows alone, a missing one as zeros', async () => {
      const m = await market();
      const a = await holder(m, 'YES', 4);
      const b = await holder(m, 'NO', 7);
      const other = await market();
      await holder(other, 'YES', 9);
      expect(await readHoldings(t.db, a, m)).toEqual([
        { outcome: 'YES', qty: 4, lockedQty: 0 },
        { outcome: 'NO', qty: 0, lockedQty: 0 },
      ]);
      expect(await readHoldings(t.db, b, m)).toEqual([
        { outcome: 'YES', qty: 0, lockedQty: 0 },
        { outcome: 'NO', qty: 7, lockedQty: 0 },
      ]);
      expect(await readHoldings(t.db, a, other)).toEqual([
        { outcome: 'YES', qty: 0, lockedQty: 0 },
        { outcome: 'NO', qty: 0, lockedQty: 0 },
      ]);
    });
  });

  describe('reads only', () => {
    it('writes nothing, and the snapshot refuses a write', async () => {
      const { m, b } = await seededBook();
      const before = await written();
      await bookNow(m);
      await quoteNow(m, terms({ qty: 9 }));
      await quoteNow(m, terms({ qty: null, budgetCoin: 500n }));
      await snapshot(async (tx) => {
        const facts = (await readMarketTradingFacts(tx, m))!;
        const book = await readPublicBook(tx, m);
        for (const holding of await readHoldings(tx, b, m)) {
          sellableOf(book, facts, holding, { id: b, human: true });
        }
      });
      expect(await written()).toEqual(before);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
      const error = await snapshot((tx) =>
        tx.execute(sql`UPDATE orders SET updated_at = updated_at WHERE market_id = ${m}`),
      ).catch((caught: unknown) => caught);
      const cause = (error as { cause?: { code?: string } }).cause ?? error;
      expect((cause as { code?: string }).code).toBe('25006');
    });

    it('takes no market lock: it answers while an intake holds one, and sees it whole after', async () => {
      const { m, a } = await seededBook();
      const holder = await t.db.$client.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [m]);
        const read = Promise.all([bookNow(m), quoteNow(m, terms({ qty: 2 }))]);
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the read waited on the market lock')), 3_000),
        );
        const [book] = (await Promise.race([read, timeout])) as Awaited<typeof read>;
        expect(book.contracts[0]!.bestAskCoin).toBe(58);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // One snapshot: an intake that commits in the middle is not seen until the next read.
      const [first, second] = await snapshot(async (tx) => {
        const facts = (await readMarketTradingFacts(tx, m))!;
        const before = orderBookOf(m, facts, await readPublicBook(tx, m));
        await placed({
          ownerId: a,
          marketId: m,
          outcome: 'YES',
          side: 'buy',
          limitPriceCoin: 50,
          qty: 7,
        });
        const after = orderBookOf(m, facts, await readPublicBook(tx, m));
        return [before, after];
      });
      expect(second).toEqual(first);
      expect((await bookNow(m)).contracts[0]!.bids[0]).toEqual({ priceCoin: 50, qty: 7 });
    });

    it('finds no public market for an unknown, draft or review one', async () => {
      const draft = (await createMarket(t.db, { createdBy: adminId, status: 'draft' })).id;
      const review = (await createMarket(t.db, { createdBy: adminId, status: 'review' })).id;
      for (const id of [draft, review, '3f2504e0-4f89-41d3-9a0c-0305e82c3301']) {
        expect(await readMarketTradingFacts(t.db, id)).toBeNull();
      }
      const noWidth = (await createMarket(t.db, { createdBy: adminId, priceProtectionTicks: null }))
        .id;
      const [stored] = await t.db
        .select({ closeAt: markets.closeAt })
        .from(markets)
        .where(eq(markets.id, noWidth));
      const before = await clockTimestamp(t.db);
      const facts = await readMarketTradingFacts(t.db, noWidth);
      const after = await clockTimestamp(t.db);
      expect(facts).toEqual({
        status: 'open',
        widthTicks: null,
        closeAt: stored!.closeAt,
        now: expect.any(Date) as unknown,
      });
      // The DB clock read with the facts (#120), not the transaction's start or the app's.
      expect(facts!.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(facts!.now.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(await quoteNow(noWidth, terms({}))).toEqual({
        kind: 'closed',
        why: 'price_protection',
      });
    });
  });

  describe('what changes the book (the market:book signal, #179)', () => {
    it('is a resting order or a fill, never a refusal, an IOC with no fill or a replay', async () => {
      const { m, a } = await seededBook();
      const resting = await placeTestOrder(t.db, { ownerId: a, marketId: m, limitPriceCoin: 20 });
      expect(placeOrderChangedBook(resting)).toBe(true);
      const filling = await placeTestOrder(t.db, {
        ownerId: await member(),
        marketId: m,
        timeInForce: 'ioc',
        limitPriceCoin: 60,
        qty: 1,
      });
      expect(placeOrderChangedBook(filling)).toBe(true);
      const nothing = await placeTestOrder(t.db, {
        ownerId: await member(),
        marketId: m,
        timeInForce: 'ioc',
        limitPriceCoin: 50,
        qty: 1,
      });
      expect(nothing).toMatchObject({ kind: 'placed', order: { status: 'rejected' } });
      expect(placeOrderChangedBook(nothing)).toBe(false);
      const poor = await placeTestOrder(t.db, {
        ownerId: await member(10n),
        marketId: m,
        limitPriceCoin: 40,
        qty: 5,
      });
      expect(poor).toMatchObject({ order: { rejectReason: 'insufficient_coin' } });
      expect(placeOrderChangedBook(poor)).toBe(false);
      if (resting.kind !== 'placed') throw new Error('placed');
      const replay = await placeTestOrder(t.db, {
        ownerId: a,
        marketId: m,
        limitPriceCoin: 20,
        requestId: resting.order.idempotencyKey,
      });
      expect(replay.kind).toBe('replayed');
      expect(placeOrderChangedBook(replay)).toBe(false);
      expect(placeOrderChangedBook({ kind: 'closed', why: 'intake' })).toBe(false);
      expect(placeOrderChangedBook({ kind: 'not_found' })).toBe(false);
      expect(placeOrderChangedBook({ kind: 'conflict' })).toBe(false);
    });

    it('names each market a batch cancelled in once', () => {
      const row = (marketId: string) => ({ marketId }) as never;
      expect(cancelledMarketIds({ cancelled: [] })).toEqual([]);
      expect(cancelledMarketIds({ cancelled: [row('m1'), row('m2'), row('m1')] })).toEqual([
        'm1',
        'm2',
      ]);
    });
  });
});
