import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MARKET_STATUSES,
  orderIntakeLock,
  orderRemainingLock,
  PAYOUT_PER_CONTRACT_COIN,
  type MarketStatus,
  type OrderLock,
  type OrderLockFacts,
  type Outcome,
} from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPairMintFill,
  applyTradeFill,
  burnMarketMakerPairs,
  ContractError,
  lockForOrder,
  lockOrderHolders,
  releaseForOrder,
  type PairMintFillInput,
  type TradeFillInput,
} from './contracts.js';
import {
  findLedgerAccount,
  LedgerEntryError,
  ledgerKeys,
  type LedgerAccountRef,
} from './ledger.js';
import { transitionMarket } from './market-transitions.js';
import {
  balances,
  fills,
  ledgerAccounts,
  ledgerEntries,
  markets,
  orders,
  positions,
  priceTicks,
} from './schema/index.js';
import { contractBook, positionOf } from './test/contracts.js';
import { createMarket, createMarketPause, createPosition, createUser } from './test/factories.js';
import { createFillRecord, createOrder } from './test/orders.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
  spendCoin,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { orderLockFactsOf } from './orders.js';
import { lockMarket, lockMarkets } from './tx-helpers.js';
import { waitForLockWaiter } from './test/wait.js';

const contractCode = (error: unknown) => (error instanceof ContractError ? error.code : undefined);
const ledgerCode = (error: unknown) => (error instanceof LedgerEntryError ? error.code : undefined);

describe('contracts.ts exports (#118, static)', () => {
  it('has no same-owner pair mint, no person’s burn and no redeem (#177 6항)', async () => {
    // A runtime export beyond these — a "mintPair", a "redeem" — fails here first.
    expect(Object.keys(await import('./contracts.js')).sort()).toEqual(
      [
        'ContractError',
        'applyPairMintFill',
        'applyTradeFill',
        'burnMarketMakerPairs',
        'lockForOrder',
        'lockOrderHolders',
        'releaseForOrder',
      ].sort(),
    );
  });
});

/**
 * 완전 담보 계약과 주문 잠금 (#118, ADR-0110; ADR-0107 결정 1 #177, 결정 2 #73): the Coin and contract
 * locks of an order, the pair mint of two opposite-outcome buys, the fill of existing contracts,
 * the 운영 마켓메이커's pair burn and its refusals, and the books they keep — per market unsettled
 * YES = NO and collateral = pairs × 100, Coin conserved, no bucket or holding below 0, every
 * account's lock the sum of its live orders' — through mixed and randomized sequences and races.
 */
describe.skipIf(!hasTestDb())('contracts (#118, docker test profile)', () => {
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

  const coin = (amountCoin: bigint): OrderLock => ({ kind: 'coin', amountCoin });
  const contracts = (outcome: Outcome, qty: number): OrderLock => ({
    kind: 'contracts',
    outcome,
    qty,
  });
  const lock = (marketId: string, ownerId: string, what: OrderLock) =>
    t.db.transaction((tx) => lockForOrder(tx, { marketId, ownerId, lock: what }));
  const release = (marketId: string, ownerId: string, what: OrderLock) =>
    t.db.transaction((tx) => releaseForOrder(tx, { marketId, ownerId, lock: what }));
  /**
   * The fill record (#119, `createFillRecord`) a test's fill events refer to — migration 0062
   * binds every TRADE_FILL and PAIR_MINT_COLLATERAL to its fill — as its id. A refusal no record
   * can stand for (one owner on both sides, an unknown owner, a malformed price or quantity) gets
   * an id that names none: contracts.ts refuses it before any event.
   */
  const recordId = async (record: () => Promise<{ fill: { id: number } }>) => {
    try {
      return String((await record()).fill.id);
    } catch {
      return randomUUID();
    }
  };
  type MintTerms = Pick<PairMintFillInput, 'marketId' | 'qty' | 'yesPriceCoin' | 'yes' | 'no'>;
  type TradeTerms = Pick<TradeFillInput, 'marketId' | 'outcome' | 'qty' | 'priceCoin' | 'buyer'> &
    Pick<TradeFillInput, 'sellerId'>;
  const mintRecordId = (input: MintTerms) =>
    recordId(() =>
      createFillRecord(t.db, {
        marketId: input.marketId,
        incomingOwnerId: input.yes.ownerId,
        restingOwnerId: input.no.ownerId,
        priceCoin: input.yesPriceCoin,
        qty: input.qty,
      }),
    );
  const tradeRecordId = (input: TradeTerms) =>
    recordId(() =>
      createFillRecord(t.db, {
        marketId: input.marketId,
        incomingOwnerId: input.buyer.ownerId,
        restingOwnerId: input.sellerId,
        outcome: input.outcome,
        kind: 'trade',
        priceCoin: input.priceCoin,
        qty: input.qty,
      }),
    );
  const mint = async (input: Omit<PairMintFillInput, 'fillId'> & { fillId?: string }) => {
    const fillId = input.fillId ?? (await mintRecordId(input));
    return t.db.transaction((tx) => applyPairMintFill(tx, { ...input, fillId }));
  };
  const fill = async (input: Omit<TradeFillInput, 'fillId'> & { fillId?: string }) => {
    const fillId = input.fillId ?? (await tradeRecordId(input));
    return t.db.transaction((tx) => applyTradeFill(tx, { ...input, fillId }));
  };
  const burn = (marketId: string, qty: number, burnId: string = randomUUID()) =>
    t.db.transaction((tx) => burnMarketMakerPairs(tx, { marketId, burnId, qty }));

  const member = async (balanceCoin: bigint) =>
    (await createUser(t.db, balanceCoin > 0n ? { balanceCoin } : {})).user.id;
  const funds = (marketId: string): LedgerAccountRef => ({ kind: 'market_maker_funds', marketId });
  const collateralOf = async (marketId: string) =>
    (await ledgerAccountBalance(t.db, { kind: 'market_collateral', marketId }))?.ledgerCoin ?? 0n;

  /** Every balance and position row, to show a refusal wrote nothing. */
  const snapshot = async () => ({
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
    positions: await t.db
      .select()
      .from(positions)
      .orderBy(positions.userId, positions.marketId, positions.outcome),
    entries: (await t.db.select({ n: sql<number>`count(*)::int` }).from(ledgerEntries))[0]!.n,
    accounts: (await t.db.select({ n: sql<number>`count(*)::int` }).from(ledgerAccounts))[0]!.n,
  });

  /** Full collateral in `marketId`: unsettled YES = NO, collateral = pairs × payout. */
  async function expectFullCollateral(marketId: string, step = '') {
    const book = await contractBook(t.db, marketId);
    expect(book.yes, step).toBe(book.no);
    expect(book.collateralCoin, step).toBe(BigInt(book.yes) * PAYOUT_PER_CONTRACT_COIN);
  }

  /** A market whose 운영 마켓메이커 funds hold `fundsCoin` (the account made if missing). */
  async function marketWithMarketMaker(fundsCoin = 10_000n, status: MarketStatus = 'open') {
    const market = await createMarket(t.db, { status });
    const mm = await fundMarketMakerFunds(t.db, market.id, fundsCoin);
    return { marketId: market.id, mm };
  }

  describe('order locks', () => {
    it('locks a buy’s limit × qty or a whole budget, and refuses more than available', async () => {
      // R5, R6, R8: available → locked of the holder's account; no event, the total and the
      // ledger total stay.
      const market = await createMarket(t.db);
      const a = await member(2_000n);
      const facts: OrderLockFacts = {
        side: 'buy',
        outcome: 'YES',
        limitPriceCoin: 60,
        qty: 10,
        filledQty: 0,
        budgetCoin: null,
        live: true,
      };
      const first = await lock(market.id, a, orderIntakeLock(facts));
      expect(first).toMatchObject({
        locked: true,
        holder: { kind: 'user', userId: a },
        balance: { availableCoin: 1_400n, lockedCoin: 600n, ledgerCoin: 2_000n },
        position: null,
      });
      const budget = orderIntakeLock({
        ...facts,
        limitPriceCoin: null,
        qty: null,
        budgetCoin: 1_234n,
        live: false,
      });
      expect(await lock(market.id, a, budget)).toMatchObject({
        locked: true,
        balance: { availableCoin: 166n, lockedCoin: 1_834n, ledgerCoin: 2_000n },
      });
      const before = await snapshot();
      expect(await lock(market.id, a, coin(167n))).toEqual({
        locked: false,
        reason: 'insufficient_coin',
      });
      expect(await snapshot()).toEqual(before);
      // Only the start grant is an event.
      expect(before.entries).toBe(1);
      for (const what of [coin(0n), coin(-5n), contracts('YES', 0), contracts('YES', 1.5)]) {
        await expect(lock(market.id, a, what)).rejects.toSatisfy(
          (e) => contractCode(e) === 'refused',
        );
      }
      // A person's id that is no account at all is refused, not taken for the 운영 마켓메이커.
      await expect(lock(market.id, randomUUID(), coin(1n))).rejects.toSatisfy(
        (e) => contractCode(e) === 'refused',
      );
    });

    it('releases part, then the rest, in any market status and on an account off its ledger', async () => {
      // R9: a release never goes below 0, works in CLOSED and CANCELLED (an expiry, #120, #20),
      // and keeps an account's gap (#73 10항). No status check in a lock either (#119 refuses).
      for (const status of ['closed', 'cancelled'] as const) {
        const market = await createMarket(t.db, { status });
        const a = await member(500n);
        await lock(market.id, a, coin(300n));
        expect(await release(market.id, a, coin(120n))).toMatchObject({
          balance: { availableCoin: 320n, lockedCoin: 180n },
        });
        await expect(release(market.id, a, coin(181n))).rejects.toSatisfy(
          (e) => contractCode(e) === 'refused',
        );
        expect(await release(market.id, a, coin(180n))).toMatchObject({
          balance: { availableCoin: 500n, lockedCoin: 0n, ledgerCoin: 500n },
        });
        // Zero is a no-op.
        expect(await release(market.id, a, coin(0n))).toMatchObject({ balance: null });
      }
      const market = await createMarket(t.db);
      const gapped = await member(100n);
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin + 50 WHERE user_id = $1',
          [gapped],
        ),
      );
      // Available (150) covers 101, the ledger's part (100 − 0) does not: a shortfall RETURNED,
      // nothing written (10-11) — not lockCoin's throw, so #119 can write its rejected order.
      const healthy = await snapshot();
      expect(await lock(market.id, gapped, coin(101n))).toEqual({
        locked: false,
        reason: 'insufficient_coin',
      });
      expect(await snapshot()).toEqual(healthy);
      await lock(market.id, gapped, coin(100n));
      await release(market.id, gapped, coin(100n));
      expect(await balanceOf(t.db, gapped)).toMatchObject({
        availableCoin: 150n,
        lockedCoin: 0n,
        ledgerCoin: 100n,
      });
    });

    it('never locks one account’s Coin twice across markets, however the locks race (R10)', async () => {
      // N01 §9: two markets' orders of one account meet on its one balance row, FOR UPDATE.
      const a = await member(1_000n);
      const m1 = await createMarket(t.db);
      const m2 = await createMarket(t.db);
      let go!: () => void;
      const held = new Promise<void>((resolve) => (go = resolve));
      let lockedFirst!: () => void;
      const firstLocked = new Promise<void>((resolve) => (lockedFirst = resolve));
      const first = t.db.transaction(async (tx) => {
        const done = await lockForOrder(tx, { marketId: m1.id, ownerId: a, lock: coin(700n) });
        lockedFirst();
        await held;
        return done;
      });
      await firstLocked;
      const second = lock(m2.id, a, coin(400n));
      await waitForLockWaiter(t.db.$client, 'the second market’s lock waits on the account');
      go();
      const [one, two] = await Promise.all([first, second]);
      expect(one.locked).toBe(true);
      expect(two).toEqual({ locked: false, reason: 'insufficient_coin' });
      expect(await balanceOf(t.db, a)).toMatchObject({ availableCoin: 300n, lockedCoin: 700n });

      // Three markets at once on 1,000: two of 400 fit, the third does not.
      const b = await member(1_000n);
      const marketIds = await Promise.all([1, 2, 3].map(async () => (await createMarket(t.db)).id));
      const results = await Promise.allSettled(
        marketIds.map((marketId) => lock(marketId, b, coin(400n))),
      );
      // None throws: a shortfall is returned.
      const outcomes = results.map((result) =>
        result.status === 'fulfilled' ? result.value.locked : 'threw',
      );
      expect(outcomes.filter((locked) => locked === true)).toHaveLength(2);
      expect(outcomes.filter((locked) => locked === false)).toHaveLength(1);
      expect(await balanceOf(t.db, b)).toMatchObject({ availableCoin: 200n, lockedCoin: 800n });
    });

    it('locks contracts within the holding not locked yet, for a person and the 운영 마켓메이커', async () => {
      // R7, R20: 매도는 보유 계약만 — locked contracts cannot be locked again, burned or sold twice.
      const { marketId, mm } = await marketWithMarketMaker();
      const a = await member(1_000n);
      const b = await member(1_000n);
      await mintTestPairs(t.db, { marketId, yesHolderId: a, noHolderId: b, qty: 3 });
      expect(await lock(marketId, a, contracts('YES', 2))).toMatchObject({
        locked: true,
        balance: null,
        position: { qty: 3, lockedQty: 2, version: 2 },
      });
      const before = await snapshot();
      expect(await lock(marketId, a, contracts('YES', 2))).toEqual({
        locked: false,
        reason: 'insufficient_contracts',
      });
      // No row at all: nothing held.
      expect(await lock(marketId, a, contracts('NO', 1))).toEqual({
        locked: false,
        reason: 'insufficient_contracts',
      });
      expect(await snapshot()).toEqual(before);
      expect(await lock(marketId, a, contracts('YES', 1))).toMatchObject({
        position: { lockedQty: 3 },
      });
      expect(await release(marketId, a, contracts('YES', 1))).toMatchObject({
        position: { qty: 3, lockedQty: 2 },
      });
      await expect(release(marketId, a, contracts('YES', 3))).rejects.toSatisfy(
        (e) => contractCode(e) === 'refused',
      );
      await expect(release(marketId, a, contracts('NO', 1))).rejects.toSatisfy(
        (e) => contractCode(e) === 'refused',
      );
      // A fill sells only what is locked: 2, not 3.
      await lock(marketId, b, coin(300n));
      await expect(
        fill({
          marketId,
          outcome: 'YES',
          qty: 3,
          priceCoin: 50,
          buyer: { ownerId: b, limitPriceCoin: 50 },
          sellerId: a,
        }),
      ).rejects.toSatisfy((e) => contractCode(e) === 'insufficient_contracts');
      // The 운영 마켓메이커 locks its own holding, the same way.
      await mintTestPairs(t.db, { marketId, yesHolderId: mm, noHolderId: b, qty: 1 });
      expect(await lock(marketId, mm, contracts('YES', 1))).toMatchObject({
        locked: true,
        holder: funds(marketId),
        position: { lockedQty: 1 },
      });
      // A settled row holds nothing to sell.
      const other = await createMarket(t.db);
      await t.db.insert(positions).values({
        userId: a,
        marketId: other.id,
        outcome: 'YES',
        qty: 0,
        settled: true,
      });
      expect(await lock(other.id, a, contracts('YES', 1))).toEqual({
        locked: false,
        reason: 'insufficient_contracts',
      });
    });

    it('refuses the 운영 마켓메이커’s Coin lock before its allocation, making no funds account', async () => {
      // A refused intake is committed with its rejected order (#119): nothing may come with it,
      // not even the empty 마켓메이커 자금 OPERATIONS.md counts as the bot's (`funds_accounts`)
      // or a collateral no pair was minted into — in the order a processing calls them
      // (`lockOrderHolders` first, ADR-0110 결정 4) and alone.
      const { mm } = await marketWithMarketMaker(100n);
      const a = await member(10n);
      const unfunded = await createMarket(t.db);
      const collateral = { kind: 'market_collateral', marketId: unfunded.id } as const;
      const before = await snapshot();
      const intake = (ownerId: string, amountCoin: bigint) =>
        t.db.transaction(async (tx) => {
          await lockOrderHolders(tx, unfunded.id, [ownerId]);
          return lockForOrder(tx, { marketId: unfunded.id, ownerId, lock: coin(amountCoin) });
        });
      const refused = { locked: false, reason: 'insufficient_coin' };
      expect(await intake(mm, 1n)).toEqual(refused);
      expect(await intake(a, 11n)).toEqual(refused);
      expect(await lock(unfunded.id, mm, coin(1n))).toEqual(refused);
      // A bulk cancel's or an expiry's holders in a market with no pair minted.
      await t.db.transaction((tx) => lockOrderHolders(tx, unfunded.id, [a, mm]));
      expect(await snapshot()).toEqual(before);
      expect(await findLedgerAccount(t.db, funds(unfunded.id))).toBeNull();
      expect(await findLedgerAccount(t.db, collateral)).toBeNull();
      // A person's lock goes through in that order, and still makes no collateral.
      expect(await intake(a, 10n)).toMatchObject({ locked: true });
      expect(await findLedgerAccount(t.db, collateral)).toBeNull();
    });

    it('locks every holder of a processing at once, the collateral with them once it exists', async () => {
      const { marketId, mm } = await marketWithMarketMaker(100n);
      const a = await member(100n);
      const b = await member(100n);
      const holders = await t.db.transaction((tx) => lockOrderHolders(tx, marketId, [a, mm, a]));
      expect([...holders.entries()]).toEqual([
        [a, { kind: 'user', userId: a }],
        [mm, funds(marketId)],
      ]);
      // No pair minted yet: no collateral, and none made (ADR-0110 10-24). The first mint makes it.
      const collateral = { kind: 'market_collateral', marketId } as const;
      expect(await findLedgerAccount(t.db, collateral)).toBeNull();
      await mintTestPairs(t.db, { marketId, yesHolderId: a, noHolderId: b, qty: 1 });
      const made = await findLedgerAccount(t.db, collateral);
      expect(made).not.toBeNull();
      // Once it exists it is held with the owners to the end of the transaction.
      const nowait = () =>
        t.db
          .execute(
            sql`SELECT 1 FROM ${balances} WHERE ${balances.accountId} = ${made!.id} FOR UPDATE NOWAIT`,
          )
          .then(
            () => 'free',
            (e: unknown) =>
              (e as { cause?: { code?: string }; code?: string }).cause?.code ??
              (e as { code?: string }).code,
          );
      await t.db.transaction(async (tx) => {
        await lockOrderHolders(tx, marketId, [b]);
        expect(await nowait()).toBe('55P03');
      });
      expect(await nowait()).toBe('free');
      await expect(
        t.db.transaction((tx) => lockOrderHolders(tx, marketId, [randomUUID()])),
      ).rejects.toSatisfy((e) => contractCode(e) === 'refused');
    });

    it('meets two crossed processings without a deadlock only when the holders lock first', async () => {
      // u's buy comes in market A and meets v's waiting NO; at once v's buy comes in market B and
      // meets u's. Each processing touches both people's one balance row each.
      const sqlState = (e: unknown) =>
        (e as { cause?: { code?: string }; code?: string }).cause?.code ??
        (e as { code?: string }).code;
      async function crossed(order: 'holders_first' | 'intake_first') {
        const u = await member(1_000n);
        const v = await member(1_000n);
        const a = (await createMarket(t.db)).id;
        const b = (await createMarket(t.db)).id;
        await lock(a, v, coin(40n));
        await lock(b, u, coin(40n));
        let go!: () => void;
        const opened = new Promise<void>((resolve) => (go = resolve));
        // The fill records first: the two processings meet on the balance rows, not on them.
        const recorded = new Map<string, string>();
        for (const [marketId, incoming, waiting] of [
          [a, u, v],
          [b, v, u],
        ] as const) {
          recorded.set(
            marketId,
            await mintRecordId({
              marketId,
              qty: 1,
              yesPriceCoin: 60,
              yes: { ownerId: incoming, limitPriceCoin: 60 },
              no: { ownerId: waiting, limitPriceCoin: 40 },
            }),
          );
        }
        const processing = (
          marketId: string,
          incoming: string,
          waiting: string,
          held: () => void,
        ) =>
          t.db.transaction(async (tx) => {
            const holders = () => lockOrderHolders(tx, marketId, [incoming, waiting]);
            const intake = async () => {
              const done = await lockForOrder(tx, { marketId, ownerId: incoming, lock: coin(60n) });
              expect(done.locked).toBe(true);
            };
            await (order === 'holders_first' ? holders() : intake());
            held();
            await opened;
            await (order === 'holders_first' ? intake() : holders());
            await applyPairMintFill(tx, {
              marketId,
              fillId: recorded.get(marketId)!,
              qty: 1,
              yesPriceCoin: 60,
              yes: { ownerId: incoming, limitPriceCoin: 60 },
              no: { ownerId: waiting, limitPriceCoin: 40 },
            });
          });
        let heldA!: () => void;
        const aHeld = new Promise<void>((resolve) => (heldA = resolve));
        let heldB!: () => void;
        const bHeld = new Promise<void>((resolve) => (heldB = resolve));
        const inA = processing(a, u, v, heldA);
        await aHeld;
        const inB = processing(b, v, u, heldB);
        if (order === 'holders_first') {
          // B waits on the rows A holds, before it holds any.
          await waitForLockWaiter(t.db.$client, 'B’s holders wait on A’s');
        } else {
          await bHeld; // each holds its own buyer's row
        }
        go();
        const endings = (await Promise.allSettled([inA, inB])).map((r) =>
          r.status === 'fulfilled' ? 'ok' : sqlState(r.reason),
        );
        return { endings, u, v, a, b };
      }

      const fine = await crossed('holders_first');
      expect(fine.endings).toEqual(['ok', 'ok']);
      for (const person of [fine.u, fine.v]) {
        expect(await balanceOf(t.db, person)).toMatchObject({
          availableCoin: 900n,
          lockedCoin: 0n,
        });
      }
      await expectFullCollateral(fine.a, 'A');
      await expectFullCollateral(fine.b, 'B');

      // The intake's lock first, then the holders: each waits on the row the other holds, and
      // Postgres aborts one (after deadlock_timeout, 1s) — the order the rule forbids.
      const crossedOut = await crossed('intake_first');
      expect([...crossedOut.endings].sort()).toEqual(['40P01', 'ok']);
    });

    it('cancels one person’s orders market by market after lockMarkets, never waiting', async () => {
      // The closure's, restriction's and admin grant's cancels (#178, #143; ADR-0110 결정 4,
      // 10-28): `lockMarkets` over the person's markets, then each market's `lockOrderHolders`
      // and release. Market B's call comes after A's release with u's row held, yet never waits:
      // it re-locks u's row and adds B's collateral, written only under lockMarket(B), held.
      // Another market's processing of v and u holds v's row and waits on u's meanwhile, and
      // B's own processing waits on its market. Adding v at B is the deadlock again.
      const sqlState = (e: unknown) =>
        (e as { cause?: { code?: string }; code?: string }).cause?.code ??
        (e as { code?: string }).code;
      async function cancels(laterOwners: 'same_person' | 'new_owner') {
        const v = await member(1_000n);
        const u = await member(1_000n);
        const accountId = async (userId: string) =>
          (await findLedgerAccount(t.db, { kind: 'user', userId }))!.id;
        // A processing over both takes v's row first (ascending account id).
        expect(await accountId(v)).toBeLessThan(await accountId(u));
        const [a, b, c] = [
          (await createMarket(t.db)).id,
          (await createMarket(t.db)).id,
          (await createMarket(t.db)).id,
        ];
        await mintTestPairs(t.db, {
          marketId: b,
          yesHolderId: await member(100n),
          noHolderId: await member(100n),
          qty: 1,
        });
        expect(await collateralOf(b)).toBe(PAYOUT_PER_CONTRACT_COIN);
        await lock(a, u, coin(10n));
        await lock(b, u, coin(20n));
        let go!: () => void;
        const opened = new Promise<void>((resolve) => (go = resolve));
        let heldA!: () => void;
        const aDone = new Promise<void>((resolve) => (heldA = resolve));
        const closure = t.db.transaction(async (tx) => {
          await lockMarkets(tx, [b, a]);
          await lockOrderHolders(tx, a, [u]);
          await releaseForOrder(tx, { marketId: a, ownerId: u, lock: coin(10n) });
          heldA();
          await opened;
          await lockOrderHolders(tx, b, laterOwners === 'same_person' ? [u] : [u, v]);
          await releaseForOrder(tx, { marketId: b, ownerId: u, lock: coin(20n) });
        });
        await aDone;
        const inC = t.db.transaction((tx) => lockOrderHolders(tx, c, [v, u]));
        const inB = t.db.transaction((tx) => lockOrderHolders(tx, b, [v]));
        await waitForLockWaiter(t.db.$client, 'C on u’s row, B on its market', 2);
        go();
        const endings = (await Promise.allSettled([closure, inC, inB])).map((r) =>
          r.status === 'fulfilled' ? 'ok' : sqlState(r.reason),
        );
        return { endings, u };
      }

      const fine = await cancels('same_person');
      expect(fine.endings).toEqual(['ok', 'ok', 'ok']);
      expect(await balanceOf(t.db, fine.u)).toMatchObject({
        availableCoin: 1_000n,
        lockedCoin: 0n,
      });
      // A later market's call that adds an owner another processing holds: one is aborted.
      const added = await cancels('new_owner');
      expect([...added.endings].sort()).toEqual(['40P01', 'ok', 'ok']);
    });
  });

  describe('pair mint', () => {
    it('mints the N01 §4 example: NO waits at 40, YES comes at 65, 5 goes back to YES', async () => {
      // R13, R14, R18, issue AC 3: each lock pays its price into the collateral, YES gets its
      // excess back, nothing reaches an operating account, and no fill, tick or statistic.
      const market = await createMarket(t.db);
      const yesBuyer = await member(100n);
      const noBuyer = await member(100n);
      const buy = (outcome: Outcome, limitPriceCoin: number): OrderLockFacts => ({
        side: 'buy',
        outcome,
        limitPriceCoin,
        qty: 1,
        filledQty: 0,
        budgetCoin: null,
        live: true,
      });
      await lock(market.id, noBuyer, orderIntakeLock(buy('NO', 40)));
      await lock(market.id, yesBuyer, orderIntakeLock(buy('YES', 65)));
      const supply = await ledgerSupply(t.db);
      const terms = {
        marketId: market.id,
        qty: 1,
        yesPriceCoin: 60,
        yes: { ownerId: yesBuyer, limitPriceCoin: 65 },
        no: { ownerId: noBuyer, limitPriceCoin: 40 },
      };
      const fillId = await mintRecordId(terms);
      const minted = await mint({ ...terms, fillId });
      expect(minted.outcome).toBe('minted');
      if (minted.outcome !== 'minted') return;
      expect(minted.entries.YES).toMatchObject({
        type: 'PAIR_MINT_COLLATERAL',
        amountCoin: 60n,
        refType: 'fill',
        refId: fillId,
        idempotencyKey: ledgerKeys.fillLeg(fillId, 'YES'),
        marketId: market.id,
      });
      expect(minted.entries.NO).toMatchObject({
        amountCoin: 40n,
        idempotencyKey: ledgerKeys.fillLeg(fillId, 'NO'),
      });
      expect(await balanceOf(t.db, yesBuyer)).toMatchObject({
        availableCoin: 40n,
        lockedCoin: 0n,
        ledgerCoin: 40n,
      });
      expect(await balanceOf(t.db, noBuyer)).toMatchObject({
        availableCoin: 60n,
        lockedCoin: 0n,
        ledgerCoin: 60n,
      });
      expect(await collateralOf(market.id)).toBe(100n);
      expect(await positionOf(t.db, yesBuyer, market.id, 'YES')).toMatchObject({
        qty: 1,
        lockedQty: 0,
        costBasisCoin: 60n,
        version: 1,
      });
      expect(await positionOf(t.db, noBuyer, market.id, 'NO')).toMatchObject({
        qty: 1,
        costBasisCoin: 40n,
      });
      // No treasury, no 마켓메이커 자금: only people's accounts and the collateral.
      const kinds = await t.db.select({ kind: ledgerAccounts.kind }).from(ledgerAccounts);
      expect(new Set(kinds.map((row) => row.kind))).toEqual(new Set(['market_collateral', 'user']));
      expect(await ledgerSupply(t.db)).toEqual(supply);
      // contracts.ts writes no fill: the one row is the test's record (#119 writes it).
      expect((await t.db.select().from(fills)).map((row) => String(row.id))).toEqual([fillId]);
      expect(await t.db.select().from(priceTicks)).toEqual([]);
      expect(
        await t.db
          .select({ last: markets.lastPrice, volume: markets.volumeCoin, n: markets.tradeCount })
          .from(markets)
          .where(eq(markets.id, market.id)),
      ).toEqual([{ last: null, volume: 0n, n: 0 }]);
      await expectFullCollateral(market.id);
    });

    it('mints with the 운영 마켓메이커 as a buyer, from its funds, and with a budget leg', async () => {
      // R17: either buyer may be a person or the 운영 마켓메이커 (#73 11항). #177 3항: a Coin-amount
      // buy's budget pays its fills and the rest is released in the same processing.
      const { marketId, mm } = await marketWithMarketMaker(1_000n);
      const a = await member(1_000n);
      await lock(marketId, mm, coin(100n));
      await lock(marketId, a, coin(100n));
      const minted = await mint({
        marketId,
        qty: 2,
        yesPriceCoin: 50,
        yes: { ownerId: mm, limitPriceCoin: 50 },
        no: { ownerId: a, limitPriceCoin: 50 },
      });
      expect(minted.outcome === 'minted' && minted.legs.YES.holder).toEqual(funds(marketId));
      expect(await ledgerAccountBalance(t.db, funds(marketId))).toMatchObject({
        availableCoin: 900n,
        lockedCoin: 0n,
        ledgerCoin: 900n,
      });

      // The budget: 1,234 locked, a fill of 3 at 60 and a mint of 2 at 55 spend 290, 944 back.
      const buyer = await member(2_000n);
      const seller = await member(1_000n);
      const other = await member(1_000n);
      await mintTestPairs(t.db, { marketId, yesHolderId: seller, noHolderId: other, qty: 3 });
      await lock(marketId, seller, contracts('YES', 3));
      await lock(marketId, buyer, coin(1_234n));
      await lock(marketId, other, coin(90n));
      const tradeId = await tradeRecordId({
        marketId,
        outcome: 'YES',
        qty: 3,
        priceCoin: 60,
        buyer: { ownerId: buyer, limitPriceCoin: null },
        sellerId: seller,
      });
      const mintId = await mintRecordId({
        marketId,
        qty: 2,
        yesPriceCoin: 55,
        yes: { ownerId: buyer, limitPriceCoin: null },
        no: { ownerId: other, limitPriceCoin: 45 },
      });
      await t.db.transaction(async (tx) => {
        await lockOrderHolders(tx, marketId, [buyer, seller, other]);
        await applyTradeFill(tx, {
          marketId,
          fillId: tradeId,
          outcome: 'YES',
          qty: 3,
          priceCoin: 60,
          buyer: { ownerId: buyer, limitPriceCoin: null },
          sellerId: seller,
        });
        await applyPairMintFill(tx, {
          marketId,
          fillId: mintId,
          qty: 2,
          yesPriceCoin: 55,
          yes: { ownerId: buyer, limitPriceCoin: null },
          no: { ownerId: other, limitPriceCoin: 45 },
        });
        await releaseForOrder(tx, { marketId, ownerId: buyer, lock: coin(1_234n - 180n - 110n) });
      });
      expect(await balanceOf(t.db, buyer)).toMatchObject({
        availableCoin: 2_000n - 290n,
        lockedCoin: 0n,
        ledgerCoin: 2_000n - 290n,
      });
      expect(await positionOf(t.db, buyer, marketId, 'YES')).toMatchObject({
        qty: 5,
        costBasisCoin: 290n,
      });
      expect(await balanceOf(t.db, other)).toMatchObject({ lockedCoin: 0n });
      await expectFullCollateral(marketId);
    });

    it('refuses the same owner, an unknown owner, prices off the grid and a short lock', async () => {
      // R15 (no same-owner mint, #177 5·6항), R16, R17, R20: refused before any write.
      const { marketId, mm } = await marketWithMarketMaker(1_000n);
      const a = await member(1_000n);
      const b = await member(1_000n);
      await lock(marketId, a, coin(500n));
      await lock(marketId, b, coin(500n));
      const ok = {
        marketId,
        qty: 1,
        yesPriceCoin: 60,
        yes: { ownerId: a, limitPriceCoin: 60 },
        no: { ownerId: b, limitPriceCoin: 40 },
      };
      const before = await snapshot();
      for (const input of [
        { ...ok, no: { ownerId: a, limitPriceCoin: 40 } },
        {
          ...ok,
          yes: { ownerId: mm, limitPriceCoin: 60 },
          no: { ownerId: mm, limitPriceCoin: 40 },
        },
        { ...ok, yes: { ownerId: randomUUID(), limitPriceCoin: 60 } },
        { ...ok, yesPriceCoin: 0 },
        { ...ok, yesPriceCoin: 100 },
        { ...ok, yesPriceCoin: 1.5 },
        { ...ok, yes: { ownerId: a, limitPriceCoin: 59 } },
        { ...ok, no: { ownerId: b, limitPriceCoin: 39 } },
        { ...ok, qty: 0 },
        { ...ok, fillId: '' },
      ]) {
        await expect(mint(input), JSON.stringify(input)).rejects.toSatisfy(
          (e) => contractCode(e) === 'refused',
        );
      }
      // A lock short of the price, or of the price and the excess it gives back.
      await expect(mint({ ...ok, qty: 9 })).rejects.toSatisfy(
        (e) => contractCode(e) === 'insufficient_coin',
      );
      await expect(
        mint({ ...ok, qty: 8, yes: { ownerId: a, limitPriceCoin: 70 } }),
      ).rejects.toSatisfy((e) => contractCode(e) === 'insufficient_coin');
      expect(await snapshot()).toEqual(before);
    });

    it('mints a fill once: a replay moves nothing, and the same id with another qty conflicts', async () => {
      // R30, ADR-0109 결정 5: the fill id keys both legs.
      const market = await createMarket(t.db);
      const a = await member(1_000n);
      const b = await member(1_000n);
      await lock(market.id, a, coin(500n));
      await lock(market.id, b, coin(500n));
      const terms = {
        marketId: market.id,
        qty: 2,
        yesPriceCoin: 30,
        yes: { ownerId: a, limitPriceCoin: 30 },
        no: { ownerId: b, limitPriceCoin: 70 },
      };
      const input = { ...terms, fillId: await mintRecordId(terms) };
      const [one, two] = await Promise.all([mint(input), mint(input)]);
      expect([one.outcome, two.outcome].sort()).toEqual(['duplicate', 'minted']);
      // Then the rest of both locks goes back (#119 releases an order's unspent lock in the same
      // processing), so the locks no longer cover 2 @ 30·70: only a key looked up before the
      // bounds (결정 5 '다시 온 체결', 10-15) still answers the replay with `duplicate`.
      await release(market.id, a, coin(440n));
      await release(market.id, b, coin(360n));
      const after = await snapshot();
      expect(await mint(input)).toEqual({ outcome: 'duplicate' });
      expect(await snapshot()).toEqual(after);
      await expect(mint({ ...input, qty: 1 })).rejects.toSatisfy(
        (e) => ledgerCode(e) === 'key_conflict',
      );
      expect(await snapshot()).toEqual(after);
      await expectFullCollateral(market.id);
    });

    it('lets a person hold YES and NO of one market at once, until settlement (R31)', async () => {
      const market = await createMarket(t.db);
      const both = await member(1_000n);
      const x = await member(1_000n);
      const y = await member(1_000n);
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: both, noHolderId: x, qty: 2 });
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: y, noHolderId: both, qty: 2 });
      expect(await positionOf(t.db, both, market.id, 'YES')).toMatchObject({ qty: 2 });
      expect(await positionOf(t.db, both, market.id, 'NO')).toMatchObject({ qty: 2 });
      await expectFullCollateral(market.id);
    });
  });

  describe('fill of existing contracts', () => {
    it('pays the seller out of the buyer’s lock and moves the seller’s locked contracts', async () => {
      // R19, issue AC 4: TRADE_FILL from the lock, the better price back to the buyer, the
      // collateral unchanged.
      const market = await createMarket(t.db);
      const seller = await member(1_000n);
      const x = await member(1_000n);
      const buyer = await member(1_000n);
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: seller,
        noHolderId: x,
        qty: 3,
      });
      await lock(market.id, seller, contracts('YES', 3));
      await lock(market.id, buyer, coin(210n));
      const terms = {
        marketId: market.id,
        outcome: 'YES' as const,
        qty: 3,
        priceCoin: 60,
        buyer: { ownerId: buyer, limitPriceCoin: 70 },
        sellerId: seller,
      };
      const fillId = await tradeRecordId(terms);
      const filled = await fill({ ...terms, fillId });
      expect(filled.outcome === 'filled' && filled.entry).toMatchObject({
        type: 'TRADE_FILL',
        amountCoin: 180n,
        marketId: market.id,
        refType: 'fill',
        refId: fillId,
        idempotencyKey: ledgerKeys.fill(fillId),
      });
      expect(await balanceOf(t.db, buyer)).toMatchObject({
        availableCoin: 820n,
        lockedCoin: 0n,
        ledgerCoin: 820n,
      });
      expect(await balanceOf(t.db, seller)).toMatchObject({
        availableCoin: 850n + 180n,
        lockedCoin: 0n,
      });
      expect(await positionOf(t.db, seller, market.id, 'YES')).toMatchObject({
        qty: 0,
        lockedQty: 0,
        costBasisCoin: 0n,
        realizedPnlCoin: 30n,
      });
      expect(await positionOf(t.db, buyer, market.id, 'YES')).toMatchObject({
        qty: 3,
        costBasisCoin: 180n,
      });
      expect(await collateralOf(market.id)).toBe(300n);
      await expectFullCollateral(market.id);
      // A replay moves nothing.
      const after = await snapshot();
      expect(
        await fill({
          marketId: market.id,
          fillId,
          outcome: 'YES',
          qty: 3,
          priceCoin: 60,
          buyer: { ownerId: buyer, limitPriceCoin: 70 },
          sellerId: seller,
        }),
      ).toEqual({ outcome: 'duplicate' });
      expect(await snapshot()).toEqual(after);
      // The same id with another Coin event — another qty × price, seller or market — conflicts
      // (ADR-0110 결정 5 '다시 온 체결'); outcome and a (price, qty) of the same product are #119's.
      const other = await createMarket(t.db);
      const settled = await snapshot();
      const replay = {
        marketId: market.id,
        fillId,
        outcome: 'YES' as const,
        qty: 3,
        priceCoin: 60,
        buyer: { ownerId: buyer, limitPriceCoin: 70 },
        sellerId: seller,
      };
      for (const changed of [{ qty: 2 }, { sellerId: x }, { marketId: other.id }]) {
        await expect(fill({ ...replay, ...changed })).rejects.toSatisfy(
          (e) => ledgerCode(e) === 'key_conflict',
        );
      }
      expect(await snapshot()).toEqual(settled);
    });

    it('fills once when the same fill comes twice at once', async () => {
      const market = await createMarket(t.db);
      const seller = await member(1_000n);
      const buyer = await member(1_000n);
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: seller,
        noHolderId: buyer,
        qty: 2,
      });
      await lock(market.id, seller, contracts('YES', 2));
      await lock(market.id, buyer, coin(120n));
      const terms = {
        marketId: market.id,
        outcome: 'YES' as const,
        qty: 2,
        priceCoin: 60,
        buyer: { ownerId: buyer, limitPriceCoin: 60 },
        sellerId: seller,
      };
      const input = { ...terms, fillId: await tradeRecordId(terms) };
      const [one, two] = await Promise.all([fill(input), fill(input)]);
      expect([one.outcome, two.outcome].sort()).toEqual(['duplicate', 'filled']);
      expect(await positionOf(t.db, buyer, market.id, 'YES')).toMatchObject({ qty: 2 });
      expect(await positionOf(t.db, seller, market.id, 'YES')).toMatchObject({
        qty: 0,
        lockedQty: 0,
      });
      expect(await balanceOf(t.db, buyer)).toMatchObject({ lockedCoin: 0n });
      await expectFullCollateral(market.id);
    });

    it('fills between a person and the 운영 마켓메이커 both ways, and refuses what it must', async () => {
      const { marketId, mm } = await marketWithMarketMaker(1_000n);
      const a = await member(1_000n);
      await mintTestPairs(t.db, { marketId, yesHolderId: mm, noHolderId: a, qty: 2 });
      // The 운영 마켓메이커 sells YES to a.
      await lock(marketId, mm, contracts('YES', 2));
      await lock(marketId, a, coin(100n));
      const sold = await fill({
        marketId,
        outcome: 'YES',
        qty: 1,
        priceCoin: 45,
        buyer: { ownerId: a, limitPriceCoin: 50 },
        sellerId: mm,
      });
      expect(sold.outcome === 'filled' && sold.seller.holder).toEqual(funds(marketId));
      // And buys NO from a.
      await lock(marketId, a, contracts('NO', 1));
      await lock(marketId, mm, coin(40n));
      const bought = await fill({
        marketId,
        outcome: 'NO',
        qty: 1,
        priceCoin: 40,
        buyer: { ownerId: mm, limitPriceCoin: 40 },
        sellerId: a,
      });
      expect(bought.outcome === 'filled' && bought.buyer.holder).toEqual(funds(marketId));
      await expectFullCollateral(marketId);

      const before = await snapshot();
      const base = {
        marketId,
        outcome: 'YES' as const,
        qty: 1,
        priceCoin: 45,
        buyer: { ownerId: a, limitPriceCoin: 50 },
        sellerId: mm,
      };
      for (const [input, code] of [
        [{ ...base, sellerId: a }, 'refused'],
        [{ ...base, buyer: { ownerId: mm, limitPriceCoin: 50 } }, 'refused'],
        [{ ...base, priceCoin: 0 }, 'refused'],
        [{ ...base, buyer: { ownerId: a, limitPriceCoin: 44 } }, 'refused'],
        [{ ...base, sellerId: randomUUID() }, 'refused'],
        [{ ...base, qty: 2 }, 'insufficient_contracts'],
        [{ ...base, outcome: 'NO' as const }, 'insufficient_contracts'],
        [{ ...base, buyer: { ownerId: a, limitPriceCoin: 99 } }, 'insufficient_coin'],
      ] as const) {
        await expect(fill(input), JSON.stringify(input)).rejects.toSatisfy(
          (e) => contractCode(e) === code,
        );
      }
      expect(await snapshot()).toEqual(before);
    });

    it('moves no contract into or out of a settled row (10-20)', async () => {
      // Settlement and the books skip a settled row: a contract written onto one would never be
      // paid and its collateral stranded. Unreachable while fills run only in OPEN markets — the
      // last line if a caller's status check is lost.
      const market = await createMarket(t.db);
      const a = await member(1_000n);
      const b = await member(1_000n);
      const c = await member(1_000n);
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: c, noHolderId: b, qty: 1 });
      await lock(market.id, c, contracts('YES', 1));
      await createPosition(t.db, {
        userId: a,
        marketId: market.id,
        outcome: 'YES',
        qty: 0,
        settled: true,
      });
      // Settled, yet still holding locked contracts: only the settled check refuses the sale.
      const d = await member(0n);
      await createPosition(t.db, {
        userId: d,
        marketId: market.id,
        outcome: 'YES',
        qty: 2,
        lockedQty: 2,
        settled: true,
      });
      await lock(market.id, a, coin(200n));
      await lock(market.id, b, coin(200n));
      const before = await snapshot();
      await expect(
        mint({
          marketId: market.id,
          qty: 1,
          yesPriceCoin: 60,
          yes: { ownerId: a, limitPriceCoin: 60 },
          no: { ownerId: b, limitPriceCoin: 40 },
        }),
      ).rejects.toSatisfy((e) => contractCode(e) === 'refused');
      expect(await snapshot()).toEqual(before);
      const sale = {
        marketId: market.id,
        outcome: 'YES' as const,
        qty: 1,
        priceCoin: 50,
        buyer: { ownerId: a, limitPriceCoin: 50 },
        sellerId: c,
      };
      await expect(fill(sale)).rejects.toSatisfy((e) => contractCode(e) === 'refused');
      expect(await snapshot()).toEqual(before);
      await expect(
        fill({ ...sale, buyer: { ownerId: b, limitPriceCoin: 50 }, sellerId: d }),
      ).rejects.toSatisfy((e) => contractCode(e) === 'insufficient_contracts');
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('마감 뒤 막음 (#120)', () => {
    /** A trade and a mint ready in `marketId`: c's locked YES, a's and b's Coin locks. */
    async function ready(marketId: string) {
      const a = await member(1_000n);
      const b = await member(1_000n);
      const c = await member(1_000n);
      await mintTestPairs(t.db, { marketId, yesHolderId: c, noHolderId: b, qty: 1 });
      await lock(marketId, c, contracts('YES', 1));
      await lock(marketId, a, coin(200n));
      await lock(marketId, b, coin(200n));
      const sale = {
        marketId,
        outcome: 'YES' as const,
        qty: 1,
        priceCoin: 50,
        buyer: { ownerId: a, limitPriceCoin: 50 },
        sellerId: c,
      };
      const pair = {
        marketId,
        qty: 1,
        yesPriceCoin: 60,
        yes: { ownerId: a, limitPriceCoin: 60 },
        no: { ownerId: b, limitPriceCoin: 40 },
      };
      return { sale, pair };
    }

    it('refuses both fill processings on a market not OPEN, nothing written', async () => {
      for (const status of ['paused', 'closed', 'provisional', 'settling', 'cancelled'] as const) {
        const market = await createMarket(t.db, { status });
        const { sale, pair } = await ready(market.id);
        const before = await snapshot();
        await expect(fill(sale), status).rejects.toSatisfy((e) => contractCode(e) === 'refused');
        await expect(mint(pair), status).rejects.toSatisfy((e) => contractCode(e) === 'refused');
        expect(await snapshot()).toEqual(before);
        await expectFullCollateral(market.id, status);
      }
      // The same terms fill while OPEN.
      const open = await createMarket(t.db);
      const { sale, pair } = await ready(open.id);
      expect(await fill(sale)).toMatchObject({ outcome: 'filled' });
      expect(await mint(pair)).toMatchObject({ outcome: 'minted' });
    });

    it('answers a fill recorded while OPEN `duplicate` after the close: the key comes first', async () => {
      const market = await createMarket(t.db);
      const { sale, pair } = await ready(market.id);
      const saleInput = { ...sale, fillId: await tradeRecordId(sale) };
      const pairInput = { ...pair, fillId: await mintRecordId(pair) };
      expect(await fill(saleInput)).toMatchObject({ outcome: 'filled' });
      expect(await mint(pairInput)).toMatchObject({ outcome: 'minted' });
      await t.db.update(markets).set({ status: 'closed' }).where(eq(markets.id, market.id));
      const before = await snapshot();
      expect(await fill(saleInput)).toEqual({ outcome: 'duplicate' });
      expect(await mint(pairInput)).toEqual({ outcome: 'duplicate' });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('the 운영 마켓메이커’s pair burn', () => {
    /** The 운영 마켓메이커 holds 3 YES (cost 180) and 3 NO (cost 90); a 3 NO, b 3 YES. */
    async function burnable(status: MarketStatus = 'open') {
      const { marketId, mm } = await marketWithMarketMaker(1_000n, status);
      const a = await member(1_000n);
      const b = await member(1_000n);
      await mintTestPairs(t.db, {
        marketId,
        yesHolderId: mm,
        noHolderId: a,
        qty: 3,
        yesPriceCoin: 60,
      });
      await mintTestPairs(t.db, {
        marketId,
        yesHolderId: b,
        noHolderId: mm,
        qty: 3,
        yesPriceCoin: 70,
      });
      return { marketId, mm, a, b };
    }

    it('burns unlocked pairs: both rows down, payout × qty from the collateral to the funds', async () => {
      // R21, R22, R25, issue AC 8, 10.
      const { marketId, a, b } = await burnable();
      const supply = await ledgerSupply(t.db);
      const fundsBefore = (await ledgerAccountBalance(t.db, funds(marketId)))!.availableCoin;
      const fillsBefore = await t.db.select().from(fills);
      const burnId = randomUUID();
      const burned = await burn(marketId, 2, burnId);
      expect(burned.outcome).toBe('burned');
      if (burned.outcome !== 'burned') return;
      expect(burned.entry).toMatchObject({
        type: 'PAIR_BURN_RETURN',
        amountCoin: 200n,
        refType: 'market',
        refId: marketId,
        idempotencyKey: ledgerKeys.pairBurn(marketId, burnId),
        marketId,
      });
      expect(burned.funds.availableCoin).toBe(fundsBefore + 200n);
      // VOID's split: each side realizes 50 × 2 minus the cost it releases.
      expect(burned.positions.YES).toMatchObject({
        qty: 1,
        costBasisCoin: 60n,
        realizedPnlCoin: 100n - 120n,
      });
      expect(burned.positions.NO).toMatchObject({
        qty: 1,
        costBasisCoin: 30n,
        realizedPnlCoin: 100n - 60n,
      });
      expect(await collateralOf(marketId)).toBe(400n);
      await expectFullCollateral(marketId);
      expect(await ledgerSupply(t.db)).toEqual(supply);
      // The people's holdings, a person's YES and NO among them, are not touched.
      expect(await positionOf(t.db, a, marketId, 'NO')).toMatchObject({ qty: 3 });
      expect(await positionOf(t.db, b, marketId, 'YES')).toMatchObject({ qty: 3 });
      // Not a fill (N01 §6): the burn writes none (the two rows are the mints' records).
      expect(await t.db.select().from(fills)).toEqual(fillsBefore);
      expect(fillsBefore).toHaveLength(2);
      expect(await t.db.select().from(priceTicks)).toEqual([]);
      expect(
        await t.db
          .select({ last: markets.lastPrice, volume: markets.volumeCoin, n: markets.tradeCount })
          .from(markets)
          .where(eq(markets.id, marketId)),
      ).toEqual([{ last: null, volume: 0n, n: 0 }]);
      // The same burn again is the burn it repeats, whatever the market is now.
      const after = await snapshot();
      expect(await burn(marketId, 2, burnId)).toEqual({ outcome: 'duplicate' });
      await expect(burn(marketId, 1, burnId)).rejects.toSatisfy(
        (e) => ledgerCode(e) === 'key_conflict',
      );
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await transitionMarket(tx, {
          marketId,
          from: 'open',
          to: 'closed',
          type: 'closed',
          actorId: null,
          at: new Date(),
        });
      });
      expect(await burn(marketId, 2, burnId)).toEqual({ outcome: 'duplicate' });
      const closed = await snapshot();
      expect(closed.positions).toEqual(after.positions);
      expect(closed.balances).toEqual(after.balances);
      expect(await burn(marketId, 1)).toEqual({ outcome: 'refused', reason: 'not_trading' });
    });

    it('burns no locked contract, and only up to the pairs it holds unlocked', async () => {
      const { marketId, mm } = await burnable();
      await lock(marketId, mm, contracts('YES', 3));
      const before = await snapshot();
      expect(await burn(marketId, 1)).toEqual({ outcome: 'refused', reason: 'insufficient_pairs' });
      await release(marketId, mm, contracts('YES', 2));
      expect(await burn(marketId, 3)).toEqual({ outcome: 'refused', reason: 'insufficient_pairs' });
      expect((await snapshot()).balances).toEqual(before.balances);
      expect(await burn(marketId, 2)).toMatchObject({
        outcome: 'burned',
        positions: { YES: { qty: 1, lockedQty: 1 }, NO: { qty: 1, lockedQty: 0 } },
      });
      await expect(burn(marketId, 0)).rejects.toSatisfy((e) => contractCode(e) === 'refused');
      await expect(burn(marketId, 1, '')).rejects.toSatisfy((e) => contractCode(e) === 'refused');
      await expectFullCollateral(marketId);
    });

    it('burns only while OPEN or PAUSED before the close, and not in a 담보·원장 장애 pause', async () => {
      // R23, #73 12항: never after close; decided under the market lock, by the clock too.
      const open = await burnable();
      const paused = await burnable();
      await createMarketPause(t.db, { marketId: paused.marketId, reason: 'basis_change' });
      expect(await burn(paused.marketId, 1)).toMatchObject({ outcome: 'burned' });
      const failing = await burnable();
      await createMarketPause(t.db, { marketId: failing.marketId, reason: 'ledger_failure' });
      expect(await burn(failing.marketId, 1)).toEqual({
        outcome: 'refused',
        reason: 'ledger_failure',
      });
      expect(await burn(open.marketId, 1)).toMatchObject({ outcome: 'burned' });
      for (const status of MARKET_STATUSES.filter((s) => s !== 'open' && s !== 'paused')) {
        const market = await createMarket(t.db, { status });
        expect(await burn(market.id, 1), status).toEqual({
          outcome: 'refused',
          reason: 'not_trading',
        });
      }
    });

    it('refuses a burn of an OPEN market whose close has come by the clock (#120’s 서버 시각)', async () => {
      // The worker has not closed it yet: the status alone would let the burn through.
      const { marketId } = await burnable();
      await t.db
        .update(markets)
        .set({ closeAt: new Date(Date.now() - 60_000), scheduledOpenAt: null })
        .where(eq(markets.id, marketId));
      const before = await snapshot();
      expect(await burn(marketId, 1)).toEqual({ outcome: 'refused', reason: 'close_passed' });
      expect(await snapshot()).toEqual(before);
    });

    it('burns nothing before the 운영 마켓메이커 account exists', async () => {
      const market = await createMarket(t.db);
      expect(await burn(market.id, 1)).toEqual({ outcome: 'refused', reason: 'no_market_maker' });
      await expect(burn(randomUUID(), 1)).rejects.toSatisfy((e) => contractCode(e) === 'refused');
    });

    it('never commits a burn after a close did: the two meet on the market lock', async () => {
      for (const first of ['close', 'burn'] as const) {
        const { marketId } = await burnable();
        let go!: () => void;
        const held = new Promise<void>((resolve) => (go = resolve));
        let started!: () => void;
        const inside = new Promise<void>((resolve) => (started = resolve));
        const close = async () =>
          t.db.transaction(async (tx) => {
            await lockMarket(tx, marketId);
            await transitionMarket(tx, {
              marketId,
              from: 'open',
              to: 'closed',
              type: 'closed',
              actorId: null,
              at: new Date(),
            });
            if (first === 'close') {
              started();
              await held;
            }
          });
        const burnHeld = async () =>
          t.db.transaction(async (tx) => {
            const done = await burnMarketMakerPairs(tx, {
              marketId,
              burnId: randomUUID(),
              qty: 1,
            });
            if (first === 'burn') {
              started();
              await held;
            }
            return done;
          });
        if (first === 'close') {
          const closing = close();
          await inside;
          const burning = burnHeld();
          await waitForLockWaiter(t.db.$client, 'the burn waits on the close');
          go();
          await closing;
          expect(await burning).toEqual({ outcome: 'refused', reason: 'not_trading' });
        } else {
          const burning = burnHeld();
          await inside;
          const closing = close();
          await waitForLockWaiter(t.db.$client, 'the close waits on the burn');
          go();
          expect(await burning).toMatchObject({ outcome: 'burned' });
          await closing;
        }
        await expectFullCollateral(marketId, first);
      }
    });

    it('orders a burn and a sell lock of the same contracts: whichever comes second is short', async () => {
      for (const first of ['lock', 'burn'] as const) {
        const { marketId, mm } = await burnable();
        let go!: () => void;
        const held = new Promise<void>((resolve) => (go = resolve));
        let started!: () => void;
        const inside = new Promise<void>((resolve) => (started = resolve));
        const lockAll = () =>
          t.db.transaction(async (tx) => {
            const done = await lockForOrder(tx, {
              marketId,
              ownerId: mm,
              lock: contracts('YES', 3),
            });
            if (first === 'lock') {
              started();
              await held;
            }
            return done;
          });
        const burnAll = () =>
          t.db.transaction(async (tx) => {
            const done = await burnMarketMakerPairs(tx, {
              marketId,
              burnId: randomUUID(),
              qty: 3,
            });
            if (first === 'burn') {
              started();
              await held;
            }
            return done;
          });
        const one = first === 'lock' ? lockAll() : burnAll();
        await inside;
        const two = first === 'lock' ? burnAll() : lockAll();
        await waitForLockWaiter(t.db.$client, `the second waits on the ${first}`);
        go();
        const [a, b] = await Promise.all([one, two]);
        if (first === 'lock') {
          expect(a).toMatchObject({ locked: true });
          expect(b).toEqual({ outcome: 'refused', reason: 'insufficient_pairs' });
        } else {
          expect(a).toMatchObject({ outcome: 'burned' });
          expect(b).toEqual({ locked: false, reason: 'insufficient_contracts' });
        }
        await expectFullCollateral(marketId, first);
      }
    });
  });

  it('leaves no lock on an ended order: locked = Σ live orders’ remaining locks (R12, AC 7)', async () => {
    // Order rows as #119 writes them (`createOrder`), their locks taken and given back through
    // contracts.ts.
    const market = await createMarket(t.db);
    const buyer = await member(1_000n);
    const seller = await member(1_000n);
    const x = await member(1_000n);
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: seller, noHolderId: x, qty: 3 });
    const buy = await createOrder(t.db, {
      marketId: market.id,
      userId: buyer,
      side: 'buy',
      limitPriceCoin: 60,
      qty: 5,
    });
    const sell = await createOrder(t.db, {
      marketId: market.id,
      userId: seller,
      side: 'sell',
      limitPriceCoin: 55,
      qty: 3,
    });
    // The exported rule the cancel (#178), the expiry (#120) and the reconciliation (#93) use.
    const factsOf = orderLockFactsOf;
    await lock(market.id, buyer, orderIntakeLock(factsOf(buy)));
    await lock(market.id, seller, orderIntakeLock(factsOf(sell)));
    // 2 fill at the resting sell's 55: the buyer gets (60 − 55) × 2 back.
    await fill({
      marketId: market.id,
      outcome: 'YES',
      qty: 2,
      priceCoin: 55,
      buyer: { ownerId: buyer, limitPriceCoin: 60 },
      sellerId: seller,
    });
    for (const row of [buy, sell]) {
      await t.db
        .update(orders)
        .set({ filledQty: 2, filledAmountCoin: 110n, status: 'partially_filled' })
        .where(eq(orders.id, row.id));
    }
    const expectLocksFollowOrders = async () => {
      const live = await t.db.select().from(orders).where(eq(orders.marketId, market.id));
      let coinLocked = 0n;
      let contractsLocked = 0;
      for (const row of live) {
        const held = orderRemainingLock(factsOf(row));
        if (held.kind === 'coin') coinLocked += held.amountCoin;
        else contractsLocked += held.qty;
      }
      expect((await balanceOf(t.db, buyer))!.lockedCoin).toBe(coinLocked);
      expect((await positionOf(t.db, seller, market.id, 'YES'))!.lockedQty).toBe(contractsLocked);
      return { coinLocked, contractsLocked };
    };
    expect(await expectLocksFollowOrders()).toEqual({ coinLocked: 180n, contractsLocked: 1 });
    // Cancel both: the remaining lock goes back, and the ended orders hold nothing.
    for (const [row, ownerId] of [
      [buy, buyer],
      [sell, seller],
    ] as const) {
      const [current] = await t.db.select().from(orders).where(eq(orders.id, row.id));
      await release(market.id, ownerId, orderRemainingLock(factsOf(current!)));
      await t.db
        .update(orders)
        .set({ status: 'cancelled', cancelReason: 'by_owner', endedAt: new Date() })
        .where(eq(orders.id, row.id));
    }
    expect(await expectLocksFollowOrders()).toEqual({ coinLocked: 0n, contractsLocked: 0 });
    expect(await balanceOf(t.db, buyer)).toMatchObject({ availableCoin: 890n, lockedCoin: 0n });
  });

  it('agrees with OPERATIONS.md’s read-only check of YES = NO and collateral = pairs × 100', async () => {
    // docs/OPERATIONS.md '계약과 담보': the doc's SQL as written, run as buddha_app (the doc's
    // psql role). A market the real paths wrote is balanced, with its sell lock shown; collateral
    // with no contracts (a raw leg only a test writes) comes first, unbalanced; a market with no
    // holding and no collateral account has no row.
    const { marketId: traded, mm } = await marketWithMarketMaker(1_000n);
    const a = await member(1_000n);
    const b = await member(1_000n);
    await mintTestPairs(t.db, { marketId: traded, yesHolderId: mm, noHolderId: a, qty: 3 });
    await mintTestPairs(t.db, { marketId: traded, yesHolderId: b, noHolderId: mm, qty: 3 });
    expect((await lock(traded, b, contracts('YES', 1))).locked).toBe(true);
    expect((await burn(traded, 2)).outcome).toBe('burned');
    const legOnly = await createMarket(t.db);
    await spendCoin(t.db, a, 150n, { marketId: legOnly.id });
    await createMarket(t.db);

    const doc = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('## 계약과 담보 (#118, ADR-0110)'));
    const query = /```sql\n([\s\S]*?)```/.exec(section.slice(0, section.indexOf('\n## ')))?.[1];
    expect(query).toBeDefined();
    const { rows } = await t.db.$client.query(query!);
    expect(rows).toEqual([
      {
        id: legOnly.id,
        status: 'open',
        yes: '0',
        no: '0',
        locked_yes: '0',
        locked_no: '0',
        collateral: '150',
        balanced: false,
      },
      {
        id: traded,
        status: 'open',
        yes: '4',
        no: '4',
        locked_yes: '1',
        locked_no: '0',
        collateral: '400',
        balanced: true,
      },
    ]);
    await expectFullCollateral(traded);
  });

  it('keeps the books through randomized sequences of locks, mints, fills, cancels and burns', async () => {
    // R27–R29, R32: after every step, per market unsettled YES = NO and collateral = pairs ×
    // 100; Coin conserved; nothing below 0; each account's lock the sum of its live orders' and
    // each holding's the sum of its live sells'. A step the model says fails fails, writing
    // nothing.
    const tally = new Map<string, number>();
    for (const seed of [1, 7, 42, 2026]) {
      await t.reset();
      for (const [kind, n] of await runRandomized(seed, 80)) {
        tally.set(kind, (tally.get(kind) ?? 0) + n);
      }
    }
    // Every kind of step ran, and every refusal was met, across the seeds.
    for (const kind of [
      'buy lock',
      'buy refused',
      'sell lock',
      'sell refused',
      'mint',
      'fill',
      'cancel',
      'burn',
      'burn refused',
    ]) {
      expect(tally.get(kind) ?? 0, kind).toBeGreaterThan(0);
    }
  });

  /** mulberry32: a small seeded PRNG, so a failing sequence replays. */
  function prng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    return { next, int, pick };
  }

  interface ModelOrder {
    marketId: string;
    ownerId: string;
    side: 'buy' | 'sell';
    outcome: Outcome;
    limit: number;
    qty: number;
    filled: number;
    live: boolean;
  }

  async function runRandomized(seed: number, steps: number): Promise<Map<string, number>> {
    const r = prng(seed);
    const tally = new Map<string, number>();
    const count = (kind: string) => tally.set(kind, (tally.get(kind) ?? 0) + 1);
    const marketIds = [(await createMarket(t.db)).id, (await createMarket(t.db)).id];
    let mm = '';
    for (const marketId of marketIds) mm = await fundMarketMakerFunds(t.db, marketId, 800n);
    const owners = [mm, await member(1_000n), await member(1_000n), await member(1_000n)];
    const book: ModelOrder[] = [];
    const factsOf = (order: ModelOrder): OrderLockFacts => ({
      side: order.side,
      outcome: order.outcome,
      limitPriceCoin: order.limit,
      qty: order.qty,
      filledQty: order.filled,
      budgetCoin: null,
      live: order.live,
    });
    const holderOf = (ownerId: string, marketId: string): LedgerAccountRef =>
      ownerId === mm ? funds(marketId) : { kind: 'user', userId: ownerId };
    const balanceFor = async (ownerId: string, marketId: string) =>
      (await ledgerAccountBalance(t.db, holderOf(ownerId, marketId)))!;
    const sameHolder = (o: ModelOrder, ownerId: string, marketId: string) =>
      o.ownerId === ownerId && (ownerId !== mm || o.marketId === marketId);
    const live = (filter: (o: ModelOrder) => boolean) => book.filter((o) => o.live && filter(o));
    const settle = (order: ModelOrder, qty: number) => {
      order.filled += qty;
      if (order.filled === order.qty) order.live = false;
    };

    const check = async (step: string) => {
      for (const marketId of marketIds) await expectFullCollateral(marketId, step);
      const supply = await ledgerSupply(t.db);
      expect(supply.heldCoin, step).toBe(supply.mintedCoin - supply.burnedCoin);
      expect(supply.carriedCoin, step).toBe(supply.heldCoin);
      const [low] = await t.db
        .select({
          available: sql<string>`min(${balances.availableCoin})::text`,
          locked: sql<string>`min(${balances.lockedCoin})::text`,
        })
        .from(balances);
      expect(BigInt(low!.available), step).toBeGreaterThanOrEqual(0n);
      expect(BigInt(low!.locked), step).toBeGreaterThanOrEqual(0n);
      for (const ownerId of owners) {
        for (const marketId of ownerId === mm ? marketIds : [marketIds[0]!]) {
          let expected = 0n;
          for (const o of book.filter((o) => sameHolder(o, ownerId, marketId))) {
            const held = orderRemainingLock(factsOf(o));
            if (held.kind === 'coin') expected += held.amountCoin;
          }
          expect((await balanceFor(ownerId, marketId)).lockedCoin, `${step}: coin lock`).toBe(
            expected,
          );
        }
      }
      for (const row of await t.db.select().from(positions)) {
        expect(row.qty, step).toBeGreaterThanOrEqual(row.lockedQty);
        expect(row.lockedQty, step).toBeGreaterThanOrEqual(0);
        const expected = live(
          (o) =>
            o.side === 'sell' &&
            o.ownerId === row.userId &&
            o.marketId === row.marketId &&
            o.outcome === row.outcome,
        ).reduce((sum, o) => sum + (o.qty - o.filled), 0);
        expect(row.lockedQty, `${step}: contract lock`).toBe(expected);
      }
    };

    for (let i = 0; i < steps; i += 1) {
      const step = `seed ${String(seed)} step ${String(i)}`;
      const roll = r.next();
      let marketId = r.pick(marketIds);
      // The 운영 마켓메이커 in about four steps of ten, so it holds both sides to burn.
      let ownerId = r.next() < 0.4 ? mm : r.pick(owners.slice(1));
      if (roll < 0.3) {
        // A buy's intake lock.
        const order: ModelOrder = {
          marketId,
          ownerId,
          side: 'buy',
          outcome: r.pick(['YES', 'NO'] as const),
          limit: r.int(1, 99),
          qty: r.int(1, 6),
          filled: 0,
          live: true,
        };
        const want = (orderIntakeLock(factsOf(order)) as { amountCoin: bigint }).amountCoin;
        const before = await balanceFor(ownerId, marketId);
        const fits = before.availableCoin >= want && before.ledgerCoin - before.lockedCoin >= want;
        const snap = fits ? null : await snapshot();
        const done = await lock(marketId, ownerId, orderIntakeLock(factsOf(order)));
        expect(done.locked, step).toBe(fits);
        if (fits) book.push(order);
        else expect(await snapshot(), step).toEqual(snap);
        count(fits ? 'buy lock' : 'buy refused');
      } else if (roll < 0.45) {
        // A sell's intake lock: mostly of a holding with contracts free, sometimes of any.
        let outcome = r.pick(['YES', 'NO'] as const);
        // In the order of `owners` and `marketIds`, not of their random ids, so the seed alone
        // fixes which row a draw picks.
        const held = (
          await t.db
            .select()
            .from(positions)
            .where(sql`${positions.qty} > ${positions.lockedQty}`)
        ).sort(
          (x, y) =>
            owners.indexOf(x.userId) - owners.indexOf(y.userId) ||
            marketIds.indexOf(x.marketId) - marketIds.indexOf(y.marketId) ||
            x.outcome.localeCompare(y.outcome),
        );
        if (held.length > 0 && r.next() < 0.75) {
          const chosen = r.pick(held);
          [ownerId, marketId, outcome] = [chosen.userId, chosen.marketId, chosen.outcome];
        }
        const row = await positionOf(t.db, ownerId, marketId, outcome);
        const free = row ? row.qty - row.lockedQty : 0;
        const qty = r.int(1, Math.max(1, free + 1));
        const order: ModelOrder = {
          marketId,
          ownerId,
          side: 'sell',
          outcome,
          limit: r.int(1, 70),
          qty,
          filled: 0,
          live: true,
        };
        const snap = qty <= free ? null : await snapshot();
        const done = await lock(marketId, ownerId, orderIntakeLock(factsOf(order)));
        expect(done.locked, step).toBe(qty <= free);
        if (qty <= free) book.push(order);
        else expect(await snapshot(), step).toEqual(snap);
        count(qty <= free ? 'sell lock' : 'sell refused');
      } else if (roll < 0.65) {
        // A pair mint: a live YES buy and a live NO buy of two owners whose limits meet.
        const pairs = live((o) => o.side === 'buy' && o.outcome === 'YES').flatMap((yes) =>
          live(
            (o) =>
              o.side === 'buy' &&
              o.outcome === 'NO' &&
              o.marketId === yes.marketId &&
              o.ownerId !== yes.ownerId &&
              yes.limit + o.limit >= 100,
          ).map((no) => [yes, no] as const),
        );
        if (pairs.length === 0) continue;
        const [yes, no] = r.pick(pairs);
        const qty = r.int(1, Math.min(yes.qty - yes.filled, no.qty - no.filled));
        const yesPrice = r.int(Math.max(1, 100 - no.limit), Math.min(99, yes.limit));
        const done = await mint({
          marketId: yes.marketId,
          qty,
          yesPriceCoin: yesPrice,
          yes: { ownerId: yes.ownerId, limitPriceCoin: yes.limit },
          no: { ownerId: no.ownerId, limitPriceCoin: no.limit },
        });
        expect(done.outcome, step).toBe('minted');
        settle(yes, qty);
        settle(no, qty);
        count('mint');
      } else if (roll < 0.8) {
        // A fill of existing contracts: a live sell and a live buy of another owner that meet.
        const matches = live((o) => o.side === 'sell').flatMap((sell) =>
          live(
            (o) =>
              o.side === 'buy' &&
              o.marketId === sell.marketId &&
              o.outcome === sell.outcome &&
              o.ownerId !== sell.ownerId &&
              o.limit >= sell.limit,
          ).map((buy) => [sell, buy] as const),
        );
        if (matches.length === 0) continue;
        const [sell, buy] = r.pick(matches);
        const qty = r.int(1, Math.min(sell.qty - sell.filled, buy.qty - buy.filled));
        const done = await fill({
          marketId: sell.marketId,
          outcome: sell.outcome,
          qty,
          priceCoin: sell.limit,
          buyer: { ownerId: buy.ownerId, limitPriceCoin: buy.limit },
          sellerId: sell.ownerId,
        });
        expect(done.outcome, step).toBe('filled');
        settle(sell, qty);
        settle(buy, qty);
        count('fill');
      } else if (roll < 0.9) {
        // A cancel: the remaining lock goes back.
        const open = live(() => true);
        if (open.length === 0) continue;
        const order = r.pick(open);
        await release(order.marketId, order.ownerId, orderRemainingLock(factsOf(order)));
        order.live = false;
        count('cancel');
      } else {
        // The 운영 마켓메이커's burn, mostly where it holds pairs unlocked, sometimes of more.
        const free = async (market: string, outcome: Outcome) => {
          const row = await positionOf(t.db, mm, market, outcome);
          return row ? row.qty - row.lockedQty : 0;
        };
        const pairsIn = async (market: string) =>
          Math.min(await free(market, 'YES'), await free(market, 'NO'));
        const burnable: string[] = [];
        for (const market of marketIds) if ((await pairsIn(market)) > 0) burnable.push(market);
        if (burnable.length > 0 && r.next() < 0.7) marketId = r.pick(burnable);
        const pairs = await pairsIn(marketId);
        const qty = r.int(1, pairs + 1);
        const snap = qty <= pairs ? null : await snapshot();
        const done = await burn(marketId, qty);
        if (qty <= pairs) {
          expect(done.outcome, step).toBe('burned');
        } else {
          expect(done, step).toEqual({ outcome: 'refused', reason: 'insufficient_pairs' });
          expect(await snapshot(), step).toEqual(snap);
        }
        count(qty <= pairs ? 'burn' : 'burn refused');
      }
      await check(step);
    }
    // Something happened: the sequence minted pairs at least once.
    const minted = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.type, 'PAIR_MINT_COLLATERAL')));
    expect(minted[0]!.n, `seed ${String(seed)}`).toBeGreaterThan(0);
    return tally;
  }
});
