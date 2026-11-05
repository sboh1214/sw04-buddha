import {
  applyBuy,
  applyPairBurn,
  applySell,
  isContractPrice,
  pairPrices,
  PAYOUT_PER_CONTRACT_COIN,
  priceImprovementCoin,
  type OrderLock,
  type Outcome,
  type PositionState,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import { marketMakerAccountId } from './account-types.js';
import type { Db } from './client.js';
import {
  findLedgerAccount,
  findLedgerEntry,
  holderLedgerAccount,
  LedgerEntryError,
  ledgerKeys,
  lockCoin,
  lockLedgerAccounts,
  recordLedgerEntry,
  releaseCoin,
  type BalanceRow,
  type LedgerAccountRef,
  type LedgerEntryInput,
  type LedgerEntryRow,
} from './ledger.js';
import { currentMarketPause } from './market-pause.js';
import { markets, positions } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/*
 * 완전 담보 계약의 자산 이동 (#118, ADR-0110; ADR-0107 결정 1 #177 1·3·6·11항, 결정 2 #73 1·11·12항):
 * the one place a contract is made, changes owner or is removed outside settlement, and where an
 * order's lock is taken and given back. Contracts are made only by `applyPairMintFill` (two
 * opposite-outcome buys, D17), change owner only by `applyTradeFill`, and are removed only by
 * `burnMarketMakerPairs` and settlement (`market-finalize`) — never one side alone, so every
 * market keeps unsettled YES = unsettled NO and its collateral = unsettled pairs × payout
 * (contract-writes.test.ts guards the writers). There is no same-owner pair mint and no person's
 * burn or redeem (#177 6항).
 *
 * Each function runs in the caller's transaction and takes `lockMarket` itself — a no-op when the
 * caller holds it, and a caller takes it before any balance row. Lock order: `lockMarket` → the
 * market row (the burn) → positions FOR UPDATE → the Coin accounts (`lockLedgerAccounts`, every
 * account the call touches, ascending) → the ledger key → the clock (or the caller's `at`). A
 * processing that touches several accounts — an intake and the fills it makes (#119), a bulk cancel
 * or an expiry (#178, #120, #20) — works out every owner it will touch first and calls
 * `lockOrderHolders` with all of them BEFORE any `lockForOrder`, `releaseForOrder` or fill: a
 * transaction that already holds one owner's balance row and then asks for a lower one waits in a
 * circle with another market's processing of the same two people (40P01, ADR-0110 결정 4). The calls
 * after it re-lock rows already held. Positions locked after the accounts never wait: a market's
 * positions are only written under its `lockMarket`. One processing over several markets (an
 * account's cancels) takes them all first with `lockMarkets` (ascending lock key, not market id:
 * the key is a 32-bit hash two markets can share), before any balance row, then each market's
 * `lockOrderHolders` and releases in turn. So the rule is "every owner's row before the first
 * lock, release or fill", not "`lockOrderHolders` is the first balance-row lock": from the second
 * market on, `lockOrderHolders` comes after a release with the person's row held, and never waits
 * — its owner is the person already held (one Coin account in every market), and the one row it
 * adds is that market's collateral, written only under the market's `lockMarket`, which
 * `lockMarkets` holds. A later call that adds a new owner's row (or a 마켓메이커 자금, one row per
 * market) is the deadlock again (contracts.test.ts shows both).
 * Every check runs before the first write, so a throw leaves nothing to undo — but it is a caller's
 * bug, and the caller's transaction rolls back on it. Every Coin move between two accounts is one
 * `recordLedgerEntry`; locks and releases are no event (#73 1항). A fill or a burn run again finds
 * its ledger key before any bound is judged and answers `duplicate` with nothing moved, or
 * `key_conflict` when its Coin event differs (accounts, amount, market). That pins a mint's price
 * and qty (its two legs) and a burn's qty, but not a trade fill's outcome or (price, qty) of the
 * same product: the fill row (#119) is what holds them, and #119 checks a replay against it.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type PositionRow = typeof positions.$inferSelect;

/**
 * A contract move a caller should never ask for, nothing written:
 * - `refused`: malformed input (a price off the grid, a limit below the price, no fill id, the
 *   same owner on both sides, an unknown owner), a release above the lock, a settled row, or a
 *   holding past `POSITION_QTY_MAX`;
 * - `insufficient_contracts`: a fill's seller holds fewer locked contracts than it sells;
 * - `insufficient_coin`: a fill's buyer holds less locked Coin (or ledger total) than it pays and
 *   gets back.
 * Inside a fill a shortfall means the order lock is not there — a caller's bug; at intake the same
 * shortfalls are returned (`lockForOrder`). Coin shortfalls of the ledger itself stay
 * `LedgerEntryError`.
 */
export class ContractError extends Error {
  readonly code: 'refused' | 'insufficient_contracts' | 'insufficient_coin';
  constructor(code: ContractError['code'], message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

const ZERO_POSITION: PositionState = { qty: 0, costBasisCoin: 0n, realizedPnlCoin: 0n };

function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new ContractError('refused', `qty must be a positive integer, got ${String(qty)}`);
  }
}

function assertId(name: string, id: string): void {
  if (id === '') throw new ContractError('refused', `${name} must not be empty`);
}

/** `fn`'s result, its RangeError a `refused` (the shared rules' refusal of a malformed input). */
function refusing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) throw new ContractError('refused', error.message);
    throw error;
  }
}

/** The row of (owner, market, outcome), FOR UPDATE, or null when there is none. */
async function lockPosition(
  tx: Tx,
  ownerId: string,
  marketId: string,
  outcome: Outcome,
): Promise<PositionRow | null> {
  const [row] = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, ownerId),
        eq(positions.marketId, marketId),
        eq(positions.outcome, outcome),
      ),
    )
    .for('update');
  return row ?? null;
}

/**
 * The Coin account of `ownerId` in `marketId` (`holderLedgerAccount`): a person's own, or the
 * market's 마켓메이커 자금 for the 운영 마켓메이커 (#73 11항) — and `refused` for an id that is
 * neither, which `holderLedgerAccount` alone would take for the 운영 마켓메이커.
 */
async function resolveHolder(tx: Tx, ownerId: string, marketId: string): Promise<LedgerAccountRef> {
  const ref = await holderLedgerAccount(tx, ownerId, marketId);
  if (ref.kind === 'market_maker_funds' && ownerId !== (await marketMakerAccountId(tx))) {
    throw new ContractError(
      'refused',
      `account ${ownerId} is neither a person's nor the 운영 마켓메이커`,
    );
  }
  return ref;
}

function stateOf(row: PositionRow | null): PositionState {
  if (row === null) return ZERO_POSITION;
  if (row.settled) {
    throw new ContractError('refused', `position ${row.userId} ${row.outcome} is settled`);
  }
  return { qty: row.qty, costBasisCoin: row.costBasisCoin, realizedPnlCoin: row.realizedPnlCoin };
}

/** Inserts the bought row, or updates it to `next` — one write per row, `version` bumped. */
async function writeBuy(
  tx: Tx,
  row: PositionRow | null,
  key: { ownerId: string; marketId: string; outcome: Outcome },
  next: PositionState,
  at: Date,
): Promise<PositionRow> {
  if (row === null) {
    const [made] = await tx
      .insert(positions)
      .values({
        userId: key.ownerId,
        marketId: key.marketId,
        outcome: key.outcome,
        qty: next.qty,
        costBasisCoin: next.costBasisCoin,
        realizedPnlCoin: next.realizedPnlCoin,
        updatedAt: at,
      })
      .returning();
    return made!;
  }
  return updatePosition(tx, row, { ...next, lockedQty: row.lockedQty }, at);
}

async function updatePosition(
  tx: Tx,
  row: PositionRow,
  next: PositionState & { lockedQty: number },
  at: Date,
): Promise<PositionRow> {
  const [updated] = await tx
    .update(positions)
    .set({
      qty: next.qty,
      lockedQty: next.lockedQty,
      costBasisCoin: next.costBasisCoin,
      realizedPnlCoin: next.realizedPnlCoin,
      updatedAt: at,
    })
    .where(
      and(
        eq(positions.userId, row.userId),
        eq(positions.marketId, row.marketId),
        eq(positions.outcome, row.outcome),
      ),
    )
    .returning();
  return updated!;
}

/** A buyer's locked Coin must cover what it pays and what is released to it at this fill. */
function assertBuyerCovers(balance: BalanceRow, paidCoin: bigint, releasedCoin: bigint): void {
  if (balance.lockedCoin < paidCoin + releasedCoin || balance.ledgerCoin < paidCoin) {
    throw new ContractError(
      'insufficient_coin',
      `ledger account ${balance.accountId} holds ${balance.lockedCoin} locked Coin (ledger ${balance.ledgerCoin}), short of ${paidCoin} paid and ${releasedCoin} released`,
    );
  }
}

/** Records `inputs` again for a replay: `duplicate` each, or `key_conflict` when one differs. */
async function rerecord(tx: Tx, inputs: LedgerEntryInput[]): Promise<void> {
  for (const input of inputs) {
    const again = await recordLedgerEntry(tx, input);
    if (again.outcome !== 'duplicate') {
      // The first leg was found, so the rest must have been recorded with it in one transaction.
      throw new LedgerEntryError(
        'key_conflict',
        `${input.type} ${input.idempotencyKey} is missing beside its recorded twin`,
      );
    }
  }
}

// ---- a. order locks -----------------------------------------------------------------------

export type OrderLockResult =
  | {
      locked: true;
      holder: LedgerAccountRef;
      /** The Coin account after a Coin lock; null for contracts. */
      balance: BalanceRow | null;
      /** The position after a contract lock; null for Coin. */
      position: PositionRow | null;
    }
  | { locked: false; reason: 'insufficient_coin' | 'insufficient_contracts' };

export interface OrderLockInput {
  marketId: string;
  /** The order's owner: a person, or the 운영 마켓메이커. */
  ownerId: string;
  /** What to lock or release (`orderIntakeLock`, `orderRemainingLock` or a remainder). */
  lock: OrderLock;
  at?: Date;
}

function assertLock(lock: OrderLock, allowZero: boolean): void {
  const amount = lock.kind === 'coin' ? lock.amountCoin : lock.qty;
  const whole = lock.kind === 'coin' ? typeof amount === 'bigint' : Number.isInteger(amount);
  if (!whole || amount < (allowZero ? 0 : 1)) {
    throw new ContractError('refused', `a lock of ${String(amount)} is not one an order holds`);
  }
}

/**
 * Takes `lock` (`orderIntakeLock`, #119) for `ownerId` in `marketId` (ADR-0107 결정 1 #177 3항, 결정 2
 * #73 1·11항): Coin from available to locked of the holder's account (`lockCoin`: a person's own,
 * or the market's 마켓메이커 자금), or contracts into the position's `locked_qty`, within the
 * holding not locked yet (no row, or a settled one, holds nothing). A shortfall is RETURNED with
 * nothing written — '잔액 부족' and '보유량 부족' (#177 8항) — so #119 writes its rejected order in a
 * healthy transaction. No key: the order row and #119's request id make it once. No status check:
 * #119's intake refuses a market that is not OPEN. `refused` for a lock of nothing.
 */
export async function lockForOrder(tx: Tx, input: OrderLockInput): Promise<OrderLockResult> {
  assertLock(input.lock, false);
  await lockMarket(tx, input.marketId);
  if (input.lock.kind === 'contracts') {
    const { qty, outcome } = input.lock;
    const row = await lockPosition(tx, input.ownerId, input.marketId, outcome);
    const holder = await resolveHolder(tx, input.ownerId, input.marketId);
    if (row === null || row.settled || row.qty - row.lockedQty < qty) {
      return { locked: false, reason: 'insufficient_contracts' };
    }
    const at = input.at ?? (await clockTimestamp(tx));
    const position = await updatePosition(
      tx,
      row,
      { ...stateOf(row), lockedQty: row.lockedQty + qty },
      at,
    );
    return { locked: true, holder, balance: null, position };
  }
  const holder = await resolveHolder(tx, input.ownerId, input.marketId);
  // A 마켓메이커 자금 with no allocation yet (#129) holds nothing: the shortfall, and no account
  // made for it — `lockLedgerAccounts` would make one, and the caller commits a refusal.
  if (holder.kind === 'market_maker_funds' && (await findLedgerAccount(tx, holder)) === null) {
    return { locked: false, reason: 'insufficient_coin' };
  }
  const [{ balance }] = (await lockLedgerAccounts(tx, [holder])) as [
    Awaited<ReturnType<typeof lockLedgerAccounts>>[number],
  ];
  const amount = input.lock.amountCoin;
  if (balance.availableCoin < amount || balance.ledgerCoin - balance.lockedCoin < amount) {
    return { locked: false, reason: 'insufficient_coin' };
  }
  const locked = await lockCoin(tx, holder, amount, input.at ? { at: input.at } : {});
  return { locked: true, holder, balance: locked, position: null };
}

/**
 * Gives back `lock` — at most what is locked: `orderRemainingLock` at a cancel or an expiry (#178,
 * #120, #20), an IOC, budget or self-trade remainder (#119). Zero is a no-op. Any market status and
 * any account (`releaseCoin` keeps a gap). Above the lock: `refused`, nothing written.
 */
export async function releaseForOrder(
  tx: Tx,
  input: OrderLockInput,
): Promise<{ holder: LedgerAccountRef; balance: BalanceRow | null; position: PositionRow | null }> {
  assertLock(input.lock, true);
  await lockMarket(tx, input.marketId);
  if (input.lock.kind === 'contracts') {
    const { qty, outcome } = input.lock;
    const row = qty === 0 ? null : await lockPosition(tx, input.ownerId, input.marketId, outcome);
    const holder = await resolveHolder(tx, input.ownerId, input.marketId);
    if (qty === 0) return { holder, balance: null, position: null };
    if (row === null || row.lockedQty < qty) {
      throw new ContractError(
        'refused',
        `${input.ownerId} has ${String(row?.lockedQty ?? 0)} ${outcome} locked, below the release of ${String(qty)}`,
      );
    }
    const at = input.at ?? (await clockTimestamp(tx));
    const position = await updatePosition(
      tx,
      row,
      {
        qty: row.qty,
        costBasisCoin: row.costBasisCoin,
        realizedPnlCoin: row.realizedPnlCoin,
        lockedQty: row.lockedQty - qty,
      },
      at,
    );
    return { holder, balance: null, position };
  }
  const holder = await resolveHolder(tx, input.ownerId, input.marketId);
  const amount = input.lock.amountCoin;
  if (amount === 0n) return { holder, balance: null, position: null };
  const [{ balance }] = (await lockLedgerAccounts(tx, [holder])) as [
    Awaited<ReturnType<typeof lockLedgerAccounts>>[number],
  ];
  if (balance.lockedCoin < amount) {
    throw new ContractError(
      'refused',
      `ledger account ${balance.accountId} has ${balance.lockedCoin} locked Coin, below the release of ${amount}`,
    );
  }
  const released = await releaseCoin(tx, holder, amount, input.at ? { at: input.at } : {});
  return { holder, balance: released, position: null };
}

/**
 * Locks, once and in ascending account id, the Coin account of every owner a processing in
 * `marketId` will touch and the market's collateral (ADR-0109 결정 4: every account before the
 * first event). Every owner's row before the first lock, release or fill of the transaction: call
 * it before `lockForOrder`, `releaseForOrder` and the fills, with the incoming order's owner and
 * every counterparty (or every owner of a bulk cancel or expiry), so the processing never waits
 * in a circle with another market's. In a one-market processing that makes it the first
 * balance-row lock; called after one of them with a new owner, it waits holding the first owner's
 * row — the deadlock it is there to prevent (contracts.test.ts shows both). One exception, an
 * account's cancels across markets (#178, #143): after `lockMarkets` over all of them, each
 * market's call may follow the previous market's releases, for the same person only — it re-locks
 * that person's row and adds only the market's collateral, written only under the `lockMarket`
 * already held (module header). Takes `lockMarket` first. Returns each owner's account.
 *
 * Makes no account: the market's collateral and a 마켓메이커 자금 not made yet are left out
 * (ADR-0110 10-24) — a refused intake commits with nothing but its rejected order, and the
 * collateral appears at the market's first pair mint. Leaving them out keeps the lock order: the
 * collateral the mint makes later in the transaction is only written under the market's
 * `lockMarket`, which this holds, and a 마켓메이커 자금 with no account holds nothing to lock or
 * pay (its only other writer, #129's allocation, takes no owner's row).
 */
export async function lockOrderHolders(
  tx: Tx,
  marketId: string,
  ownerIds: readonly string[],
): Promise<Map<string, LedgerAccountRef>> {
  await lockMarket(tx, marketId);
  const holders = new Map<string, LedgerAccountRef>();
  for (const ownerId of new Set(ownerIds)) {
    holders.set(ownerId, await resolveHolder(tx, ownerId, marketId));
  }
  const refs: LedgerAccountRef[] = [];
  for (const ref of [{ kind: 'market_collateral', marketId } as const, ...holders.values()]) {
    if (ref.kind === 'user' || (await findLedgerAccount(tx, ref)) !== null) refs.push(ref);
  }
  await lockLedgerAccounts(tx, refs);
  return holders;
}

// ---- b. pair mint from two opposite-outcome buys ------------------------------------------

/** One buyer of a fill. */
export interface BuyLeg {
  /** A person, or the 운영 마켓메이커 (its market's 마켓메이커 자금 pays). */
  ownerId: string;
  /**
   * Its limit: (limit − its price) × qty goes back to it at this fill. null for a Coin-amount
   * buy: the difference stays in its budget lock until #119 releases the unspent budget.
   */
  limitPriceCoin: number | null;
}

export interface PairMintFillInput {
  marketId: string;
  /** The fill row's id (#119, `String(fills.id)`): both legs' key, `ledgerKeys.fillLeg`. */
  fillId: string;
  qty: number;
  /** The YES buyer's price, the fill's (#177 11항); the NO buyer pays the payout minus it. */
  yesPriceCoin: number;
  yes: BuyLeg;
  no: BuyLeg;
  at?: Date;
}

interface FilledSide {
  holder: LedgerAccountRef;
  balance: BalanceRow;
  position: PositionRow;
}

export type PairMintFillResult =
  | {
      outcome: 'minted';
      entries: Record<Outcome, LedgerEntryRow>;
      legs: Record<Outcome, FilledSide>;
    }
  | { outcome: 'duplicate' };

function assertLimit(leg: BuyLeg, priceCoin: number): void {
  if (leg.limitPriceCoin === null) return;
  if (!isContractPrice(leg.limitPriceCoin) || leg.limitPriceCoin < priceCoin) {
    throw new ContractError(
      'refused',
      `limit ${String(leg.limitPriceCoin)} cannot fill at ${String(priceCoin)}`,
    );
  }
}

const releaseOf = (leg: BuyLeg, priceCoin: number, qty: number): bigint =>
  leg.limitPriceCoin === null ? 0n : priceImprovementCoin(leg.limitPriceCoin, priceCoin, qty);

/**
 * 쌍 발행 (D17; N01 §4; ADR-0107 결정 2 #73 1항): one fill of a YES buy against a NO buy, which #117
 * matches and #119 records. Each buyer pays its price × qty out of its lock into the market's
 * collateral (PAIR_MINT_COLLATERAL, `fillLeg(fillId, outcome)`, ref `fill`) — together exactly qty
 * × payout — gets back its excess limit (N01 §4: a YES buy at 65 against a NO buy waiting at 40
 * pays 60, and 5 goes back to its available), and holds qty more of its outcome, the cost being
 * what it paid (`applyBuy`). No treasury or operating account is touched unless the 운영
 * 마켓메이커 is a buyer, from its own 마켓메이커 자금. No fill row, tick or market statistic: #119
 * writes the one fill at the YES price. `refused` for the same owner on both legs (self-trade, and
 * no same-owner mint, #177 5·6항), an unknown owner, prices off the grid or a limit below its price;
 * `insufficient_coin` when a lock does not hold what this fill takes from it.
 */
export async function applyPairMintFill(
  tx: Tx,
  input: PairMintFillInput,
): Promise<PairMintFillResult> {
  assertId('fillId', input.fillId);
  assertQty(input.qty);
  const prices = refusing(() => pairPrices(input.yesPriceCoin));
  assertLimit(input.yes, prices.YES);
  assertLimit(input.no, prices.NO);
  if (input.yes.ownerId === input.no.ownerId) {
    throw new ContractError('refused', 'a pair is minted between two owners only');
  }
  const { marketId, qty } = input;
  const legs = { YES: input.yes, NO: input.no };
  const outcomes = ['YES', 'NO'] as const;

  await lockMarket(tx, marketId);
  const rows = {
    YES: await lockPosition(tx, legs.YES.ownerId, marketId, 'YES'),
    NO: await lockPosition(tx, legs.NO.ownerId, marketId, 'NO'),
  };
  const holders = {
    YES: await resolveHolder(tx, legs.YES.ownerId, marketId),
    NO: await resolveHolder(tx, legs.NO.ownerId, marketId),
  };
  const collateral: LedgerAccountRef = { kind: 'market_collateral', marketId };
  const [, yesAccount, noAccount] = await lockLedgerAccounts(tx, [
    collateral,
    holders.YES,
    holders.NO,
  ]);
  const balances = { YES: yesAccount!.balance, NO: noAccount!.balance };
  const entryOf = (outcome: Outcome, at?: Date): LedgerEntryInput => ({
    type: 'PAIR_MINT_COLLATERAL',
    amountCoin: BigInt(prices[outcome]) * BigInt(qty),
    from: holders[outcome],
    to: collateral,
    refType: 'fill',
    refId: input.fillId,
    idempotencyKey: ledgerKeys.fillLeg(input.fillId, outcome),
    debitFrom: 'locked',
    ...(at ? { at } : {}),
  });

  if (await findLedgerEntry(tx, 'PAIR_MINT_COLLATERAL', ledgerKeys.fillLeg(input.fillId, 'YES'))) {
    await rerecord(tx, [entryOf('YES'), entryOf('NO')]);
    return { outcome: 'duplicate' };
  }

  const plan = outcomes.map((outcome) => {
    const paid = BigInt(prices[outcome]) * BigInt(qty);
    const release = releaseOf(legs[outcome], prices[outcome], qty);
    assertBuyerCovers(balances[outcome], paid, release);
    const next = refusing(() => applyBuy(stateOf(rows[outcome]), qty, paid));
    return { outcome, release, next };
  });

  const at = input.at ?? (await clockTimestamp(tx));
  const entries = {} as Record<Outcome, LedgerEntryRow>;
  const filled = {} as Record<Outcome, FilledSide>;
  for (const { outcome, release, next } of plan) {
    const done = await recordLedgerEntry(tx, entryOf(outcome, at));
    if (done.outcome !== 'recorded') throw new Error(`${outcome} leg of ${input.fillId} replayed`);
    let balance = done.from!;
    if (release > 0n) balance = await releaseCoin(tx, holders[outcome], release, { at });
    const position = await writeBuy(
      tx,
      rows[outcome],
      { ownerId: legs[outcome].ownerId, marketId, outcome },
      next,
      at,
    );
    entries[outcome] = done.entry;
    filled[outcome] = { holder: holders[outcome], balance, position };
  }
  return { outcome: 'minted', entries, legs: filled };
}

// ---- c. fill of existing contracts --------------------------------------------------------

export interface TradeFillInput {
  marketId: string;
  /** The fill row's id (#119, `String(fills.id)`): the key, `ledgerKeys.fill`. */
  fillId: string;
  outcome: Outcome;
  qty: number;
  /** The fill price (the resting order's). */
  priceCoin: number;
  buyer: BuyLeg;
  /** The seller, whose sell order locked the contracts (`lockForOrder`). */
  sellerId: string;
  at?: Date;
}

export type TradeFillResult =
  | { outcome: 'filled'; entry: LedgerEntryRow; buyer: FilledSide; seller: FilledSide }
  | { outcome: 'duplicate' };

/**
 * 체결 (N01 §3·§4; ADR-0107 결정 2 #73 1항): one fill of contracts the seller holds, which #117
 * matches and #119 records. price × qty goes from the buyer's lock to the seller's available
 * (TRADE_FILL, `fill(fillId)`, ref `fill`, the market named), the buyer gets back its better-price
 * difference, and qty contracts leave the seller's lock for the buyer's holding — the seller's row
 * by `applySell` (its cost released, its PnL realized), the buyer's by `applyBuy`. The collateral
 * does not move. `refused` for the same owner on both sides (self-trade, and the 운영 마켓메이커's
 * one bundle, #73 11항), an unknown owner, a price off the grid or a limit below it;
 * `insufficient_contracts` when the seller's lock is short (no contract moves unlocked);
 * `insufficient_coin` when the buyer's is.
 */
export async function applyTradeFill(tx: Tx, input: TradeFillInput): Promise<TradeFillResult> {
  assertId('fillId', input.fillId);
  assertQty(input.qty);
  if (!isContractPrice(input.priceCoin)) {
    throw new ContractError('refused', `${String(input.priceCoin)} is not a contract price`);
  }
  assertLimit(input.buyer, input.priceCoin);
  if (input.buyer.ownerId === input.sellerId) {
    throw new ContractError('refused', 'a fill is between two owners only');
  }
  const { marketId, outcome, qty } = input;

  await lockMarket(tx, marketId);
  const sellerRow = await lockPosition(tx, input.sellerId, marketId, outcome);
  const buyerRow = await lockPosition(tx, input.buyer.ownerId, marketId, outcome);
  const buyerHolder = await resolveHolder(tx, input.buyer.ownerId, marketId);
  const sellerHolder = await resolveHolder(tx, input.sellerId, marketId);
  const [buyerAccount] = await lockLedgerAccounts(tx, [buyerHolder, sellerHolder]);
  const paid = BigInt(input.priceCoin) * BigInt(qty);
  const entryInput = (at?: Date): LedgerEntryInput => ({
    type: 'TRADE_FILL',
    amountCoin: paid,
    from: buyerHolder,
    to: sellerHolder,
    marketId,
    refType: 'fill',
    refId: input.fillId,
    idempotencyKey: ledgerKeys.fill(input.fillId),
    debitFrom: 'locked',
    ...(at ? { at } : {}),
  });

  if (await findLedgerEntry(tx, 'TRADE_FILL', ledgerKeys.fill(input.fillId))) {
    await rerecord(tx, [entryInput()]);
    return { outcome: 'duplicate' };
  }

  if (sellerRow === null || sellerRow.settled || sellerRow.lockedQty < qty) {
    throw new ContractError(
      'insufficient_contracts',
      `${input.sellerId} has ${String(sellerRow?.lockedQty ?? 0)} ${outcome} locked, short of ${String(qty)}`,
    );
  }
  const release = releaseOf(input.buyer, input.priceCoin, qty);
  assertBuyerCovers(buyerAccount!.balance, paid, release);
  const sellerNext = applySell(stateOf(sellerRow), qty, paid);
  const buyerNext = refusing(() => applyBuy(stateOf(buyerRow), qty, paid));

  const at = input.at ?? (await clockTimestamp(tx));
  const done = await recordLedgerEntry(tx, entryInput(at));
  if (done.outcome !== 'recorded') throw new Error(`fill ${input.fillId} replayed`);
  let buyerBalance = done.from!;
  if (release > 0n) buyerBalance = await releaseCoin(tx, buyerHolder, release, { at });
  const sellerPosition = await updatePosition(
    tx,
    sellerRow,
    { ...sellerNext, lockedQty: sellerRow.lockedQty - qty },
    at,
  );
  const buyerPosition = await writeBuy(
    tx,
    buyerRow,
    { ownerId: input.buyer.ownerId, marketId, outcome },
    buyerNext,
    at,
  );
  return {
    outcome: 'filled',
    entry: done.entry,
    buyer: { holder: buyerHolder, balance: buyerBalance, position: buyerPosition },
    seller: { holder: sellerHolder, balance: done.to!, position: sellerPosition },
  };
}

// ---- d. the 운영 마켓메이커's pair burn ---------------------------------------------------

/**
 * Why `burnMarketMakerPairs` burned nothing, in the order it is judged:
 * - `no_market_maker`: the database has no 운영 마켓메이커 account yet (the seed makes it);
 * - `not_trading`: the market is not OPEN or PAUSED (#73 12항: never after close);
 * - `ledger_failure`: its lasting pause is for 담보·원장 장애 — the collateral the reconciliation
 *   doubts is not paid out while it lasts (ADR-0110 10-9, reversible). A failure #93 records on a
 *   market already paused for another reason (#73 10항) is not read yet: #93 adds it here;
 * - `insufficient_pairs`: qty is above the pairs the 운영 마켓메이커 holds unlocked —
 *   min(YES − locked YES, NO − locked NO);
 * - `close_passed`: OPEN or PAUSED, but its close has come by the database clock (#120's 서버 시각),
 *   which a market reaches before the worker closes it.
 */
export type PairBurnRefusal =
  'no_market_maker' | 'not_trading' | 'ledger_failure' | 'insufficient_pairs' | 'close_passed';

export type PairBurnResult =
  | {
      outcome: 'burned';
      entry: LedgerEntryRow;
      /** The market's 마켓메이커 자금 after the return. */
      funds: BalanceRow;
      positions: Record<Outcome, PositionRow>;
    }
  | { outcome: 'duplicate' }
  | { outcome: 'refused'; reason: PairBurnRefusal };

export interface PairBurnInput {
  marketId: string;
  /** The caller's (#129) id of this burn: the key, `ledgerKeys.pairBurn(marketId, burnId)`. */
  burnId: string;
  qty: number;
}

/**
 * 쌍 소각 (ADR-0107 결정 2 #73 1·12항, 결정 1 #177 6·11항): burns `qty` YES·NO pairs the 운영
 * 마켓메이커 holds unlocked in `marketId` — both rows down by qty, each released at what VOID pays
 * it (`applyPairBurn`) — and returns qty × payout from the market's collateral to its 마켓메이커
 * 자금 (PAIR_BURN_RETURN, ref `market`). No owner parameter: only the 운영 마켓메이커 burns, and the
 * return never reaches a person's account (#73 3항). Only while the market trades (OPEN or PAUSED,
 * before its close by the clock), decided under `lockMarket`, which the close also takes, so no
 * burn commits after a close did. Not a fill: no fill row, tick or market statistic (N01 §6). The
 * same burn id again answers `duplicate` whatever the market is now (`key_conflict` with another
 * qty). #129 calls it; nothing in #118 does. `refused` (thrown) for a bad qty or burn id, or a
 * market that does not exist.
 */
export async function burnMarketMakerPairs(tx: Tx, input: PairBurnInput): Promise<PairBurnResult> {
  assertId('burnId', input.burnId);
  assertQty(input.qty);
  const { marketId, qty } = input;

  await lockMarket(tx, marketId);
  const [market] = await tx
    .select({ status: markets.status, closeAt: markets.closeAt })
    .from(markets)
    .where(eq(markets.id, marketId))
    .for('update');
  if (!market) throw new ContractError('refused', `market ${marketId} does not exist`);
  const owner = await marketMakerAccountId(tx);
  if (owner === null) return { outcome: 'refused', reason: 'no_market_maker' };
  const yes = await lockPosition(tx, owner, marketId, 'YES');
  const no = await lockPosition(tx, owner, marketId, 'NO');
  const collateral: LedgerAccountRef = { kind: 'market_collateral', marketId };
  const funds: LedgerAccountRef = { kind: 'market_maker_funds', marketId };
  const entryInput = (at?: Date): LedgerEntryInput => ({
    type: 'PAIR_BURN_RETURN',
    amountCoin: BigInt(qty) * PAYOUT_PER_CONTRACT_COIN,
    from: collateral,
    to: funds,
    refType: 'market',
    refId: marketId,
    idempotencyKey: ledgerKeys.pairBurn(marketId, input.burnId),
    ...(at ? { at } : {}),
  });

  // The key before every state: a replay after the close, or after the pairs are gone, is the
  // burn it repeats. `lockMarket` orders every burn of this market, and the key names it.
  if (await findLedgerEntry(tx, 'PAIR_BURN_RETURN', ledgerKeys.pairBurn(marketId, input.burnId))) {
    await rerecord(tx, [entryInput()]);
    return { outcome: 'duplicate' };
  }
  if (market.status !== 'open' && market.status !== 'paused') {
    return { outcome: 'refused', reason: 'not_trading' };
  }
  if ((await currentMarketPause(tx, marketId))?.reason === 'ledger_failure') {
    return { outcome: 'refused', reason: 'ledger_failure' };
  }
  const unlocked = (row: PositionRow | null) =>
    row === null || row.settled ? 0 : row.qty - row.lockedQty;
  if (qty > Math.min(unlocked(yes), unlocked(no))) {
    return { outcome: 'refused', reason: 'insufficient_pairs' };
  }
  // Only now the two Coin accounts (they exist: the pairs were minted into this collateral, the
  // 운영 마켓메이커's legs out of these funds), and the clock after them, the return's instant.
  await lockLedgerAccounts(tx, [collateral, funds]);
  const now = await clockTimestamp(tx);
  if (now.getTime() >= market.closeAt.getTime()) {
    return { outcome: 'refused', reason: 'close_passed' };
  }
  const after = applyPairBurn(stateOf(yes), stateOf(no), qty);

  const done = await recordLedgerEntry(tx, entryInput(now));
  if (done.outcome !== 'recorded') throw new Error(`burn ${input.burnId} replayed`);
  const burned = {
    YES: await updatePosition(tx, yes!, { ...after.YES, lockedQty: yes!.lockedQty }, now),
    NO: await updatePosition(tx, no!, { ...after.NO, lockedQty: no!.lockedQty }, now),
  };
  return { outcome: 'burned', entry: done.entry, funds: done.to!, positions: burned };
}
