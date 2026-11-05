import { randomUUID } from 'node:crypto';
import {
  type BookOrder,
  type FillBuyLeg,
  type FillProcessInput,
  type IncomingOrder,
  type MatchResult,
  type OrderLock,
  fillProcessInput,
  matchOrder,
  orderIntakeLock,
} from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPairMintFill,
  applyTradeFill,
  type BuyLeg,
  lockForOrder,
  lockOrderHolders,
  releaseForOrder,
  type PairMintFillInput,
  type TradeFillInput,
} from './contracts.js';
import { ledgerAccounts } from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
} from './test/ledger.js';

/**
 * The plan's argument and #118's input have the same keys, both ways. The `satisfies` below
 * catches a field #118 requires that the plan lacks and a renamed or retyped field, but not a
 * field only the plan has (no excess-property check on a non-literal or a spread), which #118
 * would drop silently.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type PlannedInput<P> = Extract<FillProcessInput, { process: P }>['input'];
type ProcessInput<T> = Omit<T, 'marketId' | 'fillId' | 'at'>;
const INPUT_KEYS_PINNED: [
  SameKeys<PlannedInput<'trade'>, ProcessInput<TradeFillInput>>,
  SameKeys<PlannedInput<'pair_mint'>, ProcessInput<PairMintFillInput>>,
  SameKeys<FillBuyLeg, BuyLeg>,
] = [true, true, true];

it('pins the plan’s argument to #118’s input keys (a drift fails `tsc`)', () => {
  expect(INPUT_KEYS_PINNED).toEqual([true, true, true]);
});

/**
 * The matching rule (#117, ADR-0111, `@buddha/shared` matching.ts) composed with #118's contract
 * processes the way #119 will call them (ADR-0110 결정 4·5, 결과 5): the holders locked first with
 * the plan's counterparties, the incoming order's intake lock, one process per planned fill with
 * `fillProcessInput`'s argument, then the remainder or the unspent budget released. Resting orders
 * exist only as their locks (no order or fill row before #119).
 */
describe.skipIf(!hasTestDb())('matching × contracts (#117, docker test profile)', () => {
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

  const member = async (balanceCoin: bigint) => (await createUser(t.db, { balanceCoin })).user.id;
  const lock = async (marketId: string, ownerId: string, what: OrderLock) => {
    const locked = await t.db.transaction((tx) =>
      lockForOrder(tx, { marketId, ownerId, lock: what }),
    );
    expect(locked.locked).toBe(true);
  };
  /** A resting buy: its lock taken as #119's intake takes it, and its book entry. */
  const restingBuy = async (
    marketId: string,
    owner: { id: string; human: boolean },
    order: Omit<BookOrder, 'owner' | 'side'>,
  ): Promise<BookOrder> => {
    await lock(
      marketId,
      owner.id,
      orderIntakeLock({
        side: 'buy',
        outcome: order.outcome,
        limitPriceCoin: order.priceCoin,
        qty: order.remainingQty,
        filledQty: 0,
        budgetCoin: null,
        live: true,
      }),
    );
    return { ...order, owner, side: 'buy' };
  };

  /** Plans `incoming` on `book` and applies the plan in one processing, as #119 will. */
  async function matchAndApply(
    marketId: string,
    book: readonly BookOrder[],
    incoming: IncomingOrder,
  ): Promise<MatchResult> {
    const result = matchOrder(book, incoming);
    const ownerId = incoming.owner!.id;
    await t.db.transaction(async (tx) => {
      await lockOrderHolders(tx, marketId, [ownerId, ...result.counterpartyOwnerIds]);
      const intake = orderIntakeLock({
        side: incoming.side,
        outcome: incoming.outcome,
        limitPriceCoin:
          incoming.side === 'buy' && incoming.budgetCoin === null ? incoming.limitPriceCoin : null,
        qty: incoming.qty,
        filledQty: 0,
        budgetCoin: incoming.budgetCoin,
        live: true,
      });
      const locked = await lockForOrder(tx, { marketId, ownerId, lock: intake });
      expect(locked.locked).toBe(true);
      for (const fill of result.fills) {
        const call = fillProcessInput(incoming, fill);
        const fillId = randomUUID();
        if (call.process === 'trade') {
          // A missing, renamed or retyped field fails `tsc` here; an extra one, INPUT_KEYS_PINNED.
          const input = call.input satisfies Omit<TradeFillInput, 'marketId' | 'fillId' | 'at'>;
          expect((await applyTradeFill(tx, { marketId, fillId, ...input })).outcome).toBe('filled');
        } else {
          const input = call.input satisfies Omit<PairMintFillInput, 'marketId' | 'fillId' | 'at'>;
          expect((await applyPairMintFill(tx, { marketId, fillId, ...input })).outcome).toBe(
            'minted',
          );
        }
      }
      let rest: OrderLock | null = null;
      if (result.unspentCoin !== null) {
        if (result.unspentCoin > 0n) rest = { kind: 'coin', amountCoin: result.unspentCoin };
      } else if (result.remainder === 'cancel' && result.remainingQty! > 0) {
        rest =
          incoming.side === 'buy'
            ? {
                kind: 'coin',
                amountCoin: BigInt(incoming.limitPriceCoin) * BigInt(result.remainingQty!),
              }
            : { kind: 'contracts', outcome: incoming.outcome, qty: result.remainingQty! };
      }
      if (rest !== null) await releaseForOrder(tx, { marketId, ownerId, lock: rest });
    });
    return result;
  }

  it('mints the N01 §4 example end to end: YES 60 / NO 40, 5 back, nothing to the operator', async () => {
    const market = await createMarket(t.db);
    const a = await member(100n);
    const b = await member(100n);
    const no40 = await restingBuy(
      market.id,
      { id: b, human: true },
      {
        id: 'no40',
        outcome: 'NO',
        priceCoin: 40,
        remainingQty: 1,
        arrival: 1,
      },
    );
    const supply = await ledgerSupply(t.db);
    const result = await matchAndApply(market.id, [no40], {
      owner: { id: a, human: true },
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 65,
      qty: 1,
      budgetCoin: null,
    });
    expect(result).toMatchObject({ stop: 'filled', counterpartyOwnerIds: [b] });
    expect(result.fills).toMatchObject([{ kind: 'pair_mint', priceCoin: 60, yesPriceCoin: 60 }]);
    expect(await balanceOf(t.db, a)).toMatchObject({ availableCoin: 40n, lockedCoin: 0n });
    expect(await balanceOf(t.db, b)).toMatchObject({ availableCoin: 60n, lockedCoin: 0n });
    expect(await contractBook(t.db, market.id)).toEqual({
      yes: 1,
      no: 1,
      lockedYes: 0,
      lockedNo: 0,
      collateralCoin: 100n,
    });
    const kinds = await t.db.select({ kind: ledgerAccounts.kind }).from(ledgerAccounts);
    expect(new Set(kinds.map((row) => row.kind))).toEqual(new Set(['market_collateral', 'user']));
    expect(await ledgerSupply(t.db)).toEqual(supply);
  });

  it('buys the bot’s NO bids with a budget: pair mints, the unspent budget released', async () => {
    const market = await createMarket(t.db);
    const mm = await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const bot = { id: mm, human: false };
    const book = [
      await restingBuy(market.id, bot, {
        id: 'no40',
        outcome: 'NO',
        priceCoin: 40,
        remainingQty: 2,
        arrival: 1,
      }),
      await restingBuy(market.id, bot, {
        id: 'no35',
        outcome: 'NO',
        priceCoin: 35,
        remainingQty: 3,
        arrival: 2,
      }),
    ];
    const a = await member(500n);
    const supply = await ledgerSupply(t.db);
    const result = await matchAndApply(market.id, book, {
      owner: { id: a, human: true },
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 70,
      qty: null,
      budgetCoin: 200n,
    });
    expect(result.fills.map((fill) => [fill.kind, fill.qty, fill.priceCoin])).toEqual([
      ['pair_mint', 2, 60],
      ['pair_mint', 1, 65],
    ]);
    expect(result).toMatchObject({ stop: 'budget_spent', amountCoin: 185n, unspentCoin: 15n });
    expect(await balanceOf(t.db, a)).toMatchObject({ availableCoin: 315n, lockedCoin: 0n });
    // The bot's two filled contracts paid 40 + 35 from its locks; 2 × 35 stay locked for the rest.
    expect(
      await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toMatchObject({ availableCoin: 1_000n - 80n - 105n, lockedCoin: 70n });
    expect(await contractBook(t.db, market.id)).toMatchObject({
      yes: 3,
      no: 3,
      collateralCoin: 300n,
    });
    expect(await ledgerSupply(t.db)).toEqual(supply);
  });

  it('fills a holder’s sell into a waiting bid at the bid’s price', async () => {
    const market = await createMarket(t.db);
    const a = await member(1_000n);
    const b = await member(1_000n);
    const c = await member(1_000n);
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: a, noHolderId: c, qty: 2 });
    const bid = await restingBuy(
      market.id,
      { id: b, human: true },
      {
        id: 'bid55',
        outcome: 'YES',
        priceCoin: 55,
        remainingQty: 2,
        arrival: 1,
      },
    );
    const before = (await balanceOf(t.db, a))!.availableCoin;
    const result = await matchAndApply(market.id, [bid], {
      owner: { id: a, human: true },
      outcome: 'YES',
      side: 'sell',
      timeInForce: 'ioc',
      limitPriceCoin: 50,
      qty: 2,
      budgetCoin: null,
    });
    expect(result.fills).toMatchObject([{ kind: 'trade', qty: 2, priceCoin: 55 }]);
    expect((await balanceOf(t.db, a))!.availableCoin).toBe(before + 110n);
    expect(await balanceOf(t.db, b)).toMatchObject({ availableCoin: 890n, lockedCoin: 0n });
    expect(await positionOf(t.db, a, market.id, 'YES')).toMatchObject({ qty: 0, lockedQty: 0 });
    expect(await positionOf(t.db, b, market.id, 'YES')).toMatchObject({ qty: 2, lockedQty: 0 });
    expect(await contractBook(t.db, market.id)).toMatchObject({
      yes: 2,
      no: 2,
      collateralCoin: 200n,
    });
  });

  it('applies the fills before a self-trade stop and leaves the own order’s lock', async () => {
    const market = await createMarket(t.db);
    const a = await member(1_000n);
    const c = await member(1_000n);
    const book = [
      await restingBuy(
        market.id,
        { id: c, human: true },
        {
          id: 'cNo45',
          outcome: 'NO',
          priceCoin: 45,
          remainingQty: 1,
          arrival: 1,
        },
      ),
      await restingBuy(
        market.id,
        { id: a, human: true },
        {
          id: 'ownNo40',
          outcome: 'NO',
          priceCoin: 40,
          remainingQty: 1,
          arrival: 2,
        },
      ),
    ];
    const result = await matchAndApply(market.id, book, {
      owner: { id: a, human: true },
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 70,
      qty: 3,
      budgetCoin: null,
    });
    expect(result).toMatchObject({ stop: 'self_trade', remainder: 'cancel', remainingQty: 2 });
    expect(result.fills).toMatchObject([{ restingOrderId: 'cNo45', priceCoin: 55 }]);
    // A paid 55 for one pair; only its own NO 40 buy's lock is left.
    expect(await balanceOf(t.db, a)).toMatchObject({
      availableCoin: 1_000n - 55n - 40n,
      lockedCoin: 40n,
    });
    expect(await contractBook(t.db, market.id)).toMatchObject({
      yes: 1,
      no: 1,
      collateralCoin: 100n,
    });
  });
});
