import {
  ledgerEntryShapeError,
  type LedgerAccountKind,
  type LedgerEntryType,
  type LedgerRefType,
  type Outcome,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { isHumanAccount, marketMakerAccountId } from './account-types.js';
import type { Db } from './client.js';
import { balances } from './schema/balances.js';
import { ledgerAccounts } from './schema/ledger-accounts.js';
import { ledgerEntries } from './schema/ledger.js';
import type * as schema from './schema/index.js';
import { clockTimestamp } from './tx-helpers.js';

/*
 * 원장 쓰기 (#116, ADR-0109; ADR-0107 결정 2 #73): the one place a balance changes with its
 * event. Every writer of Coin — the start grant, the closure, the kept payment and coupon paths,
 * the settlement payout, and #118's pair mints, #119's fills, #93's corrections, #129's treasury
 * — calls `recordLedgerEntry` in its own transaction, and nothing else inserts a ledger entry or
 * changes a balance's total (ledger-writes.test.ts; the database checks it at every UPDATE and at
 * COMMIT, migration 0060). #118's order locks (available ↔ locked of one account, no event) are
 * added to this file.
 *
 * Lock order, which every caller keeps so two writers never wait on each other in a circle:
 * `lockMarket` (a market's writers) → the source's own rows (the 본인확인 record and the grant, a
 * coupon, positions, an order or fill, an approval request) → the ledger accounts' balance rows
 * in ascending account id (`lockLedgerAccounts`, with EVERY account the transaction will touch
 * before its first event: a writer of several events pre-locks them all and passes `at`) → the
 * clock (`clockTimestamp`), read after the last lock. A payment is the one exception, kept from
 * ADR-0042: its writers (the deposit, a refund's claw-back and its restore) take the user's
 * balance row BEFORE the payment row, and so must any later writer that takes both — a payment
 * row first would wait in a circle with a refund of the same payment.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type BalanceRow = typeof balances.$inferSelect;

/**
 * A ledger account by what it is: a person's own (by account id), the treasury, a market's
 * collateral or a market's 마켓메이커 자금 (owned by the 운영 마켓메이커, `marketMakerAccountId`).
 */
export type LedgerAccountRef =
  | { kind: 'user'; userId: string }
  | { kind: 'treasury' }
  | { kind: 'market_collateral'; marketId: string }
  | { kind: 'market_maker_funds'; marketId: string };

/**
 * Why `recordLedgerEntry` (or a lock) refused, nothing written:
 * - `insufficient_coin`: the paying bucket, or the account's ledger total, holds less than the
 *   amount;
 * - `refused`: the event is not one its type allows (LEDGER_ENTRY_RULES) — a caller's bug;
 * - `key_conflict`: the key was recorded before with other accounts, amount or market;
 * - `account_missing`: a person's account with no user ledger account (an unknown id, the 운영
 *   마켓메이커), or a 마켓메이커 자금 before the 운영 마켓메이커 account exists.
 */
export class LedgerEntryError extends Error {
  readonly code: 'insufficient_coin' | 'refused' | 'key_conflict' | 'account_missing';
  constructor(code: LedgerEntryError['code'], message: string) {
    super(message);
    this.name = 'LedgerEntryError';
    this.code = code;
  }
}

const marketOf = (ref: LedgerAccountRef | null): string | null =>
  ref !== null && (ref.kind === 'market_collateral' || ref.kind === 'market_maker_funds')
    ? ref.marketId
    : null;

/** A ledger account that exists already, or null — never makes one (a reader's lookup). */
export async function findLedgerAccount(
  executor: Reader,
  ref: LedgerAccountRef,
): Promise<LedgerAccountRow | null> {
  const where =
    ref.kind === 'user'
      ? and(eq(ledgerAccounts.kind, 'user'), eq(ledgerAccounts.ownerId, ref.userId))
      : ref.kind === 'treasury'
        ? eq(ledgerAccounts.kind, 'treasury')
        : and(eq(ledgerAccounts.kind, ref.kind), eq(ledgerAccounts.marketId, ref.marketId));
  const [row] = await executor.select().from(ledgerAccounts).where(where).limit(1);
  return row ?? null;
}

/**
 * The ledger account `ref` names, made when it is the treasury, a collateral or a 마켓메이커 자금
 * that no event named yet (its balance row at 0 comes with it, migration 0060). A person's own is
 * made with the account and never here: `account_missing` when there is none. Race-safe with no
 * lock: the partial unique indexes make a second maker insert nothing and read the first's row
 * once it commits.
 */
export async function ensureLedgerAccount(
  tx: Tx,
  ref: LedgerAccountRef,
): Promise<LedgerAccountRow> {
  const found = await findLedgerAccount(tx, ref);
  if (found) return found;
  if (ref.kind === 'user') {
    throw new LedgerEntryError('account_missing', `account ${ref.userId} has no ledger account`);
  }
  let values: typeof ledgerAccounts.$inferInsert;
  if (ref.kind === 'treasury') {
    values = { kind: 'treasury' };
  } else if (ref.kind === 'market_collateral') {
    values = { kind: 'market_collateral', marketId: ref.marketId };
  } else {
    const owner = await marketMakerAccountId(tx);
    if (owner === null) {
      throw new LedgerEntryError(
        'account_missing',
        `market ${ref.marketId}'s 마켓메이커 자금 needs the 운영 마켓메이커 account (the seed)`,
      );
    }
    values = { kind: 'market_maker_funds', ownerId: owner, marketId: ref.marketId };
  }
  await tx.insert(ledgerAccounts).values(values).onConflictDoNothing();
  const made = await findLedgerAccount(tx, ref);
  if (!made) throw new Error(`ledger account ${JSON.stringify(ref)} vanished after its insert`);
  return made;
}

/**
 * Locks the balance rows of `refs` (FOR UPDATE, in ascending account id, whatever order they are
 * given in), making a system account first used; returns each one's account and balance in the
 * order given. Re-locking a row the transaction holds is a no-op, so a caller that locked its
 * user's row earlier keeps its own order; one that writes several events calls this once with
 * every account first.
 */
export async function lockLedgerAccounts(
  tx: Tx,
  refs: readonly LedgerAccountRef[],
): Promise<{ account: LedgerAccountRow; balance: BalanceRow }[]> {
  const accounts: LedgerAccountRow[] = [];
  for (const ref of refs) accounts.push(await ensureLedgerAccount(tx, ref));
  if (accounts.length === 0) return [];
  const ids = [...new Set(accounts.map((account) => account.id))];
  const rows = await tx
    .select()
    .from(balances)
    .where(inArray(balances.accountId, ids))
    .orderBy(asc(balances.accountId))
    .for('update');
  const byId = new Map(rows.map((row) => [row.accountId, row]));
  return accounts.map((account) => {
    const balance = byId.get(account.id);
    if (!balance) throw new Error(`ledger account ${account.id} has no balance row`);
    return { account, balance };
  });
}

/**
 * Who holds a market's contracts as a ledger account: a person's own account, or — the 운영
 * 마켓메이커's positions — that market's 마켓메이커 자금 (ADR-0107 결정 2 #73 11항). Where a
 * settlement payout (and #119's fill) sends the Coin of a position's owner.
 */
export async function holderLedgerAccount(
  executor: Reader,
  ownerId: string,
  marketId: string,
): Promise<LedgerAccountRef> {
  return (await isHumanAccount(executor, ownerId))
    ? { kind: 'user', userId: ownerId }
    : { kind: 'market_maker_funds', marketId };
}

/** One event as one account sees it: signed (`+` in, `−` out) and that side's total after it. */
export function ledgerEntryForAccount(
  entry: LedgerEntryRow,
  accountId: number,
): { amountCoin: bigint; balanceAfterCoin: bigint } {
  if (entry.toAccountId === accountId) {
    return { amountCoin: entry.amountCoin, balanceAfterCoin: entry.toBalanceAfterCoin! };
  }
  if (entry.fromAccountId === accountId) {
    return { amountCoin: -entry.amountCoin, balanceAfterCoin: entry.fromBalanceAfterCoin! };
  }
  throw new Error(`ledger entry ${entry.id} does not touch account ${accountId}`);
}

/**
 * 중복 방지 키 (#116 수용 기준: 같은 요청 ID·주문 ID·체결 ID·정산 키를 두 번 기록해도 한 번만
 * 반영): unique per type (`ledger_entries_type_idempotency_key_unique`), so one source is one event.
 * Later writers follow the same rule — the source's own id, or its parts joined by ':' when one
 * source makes several events of a type: #118's PAIR_BURN_RETURN (a burn's id), #129's
 * BOT_ALLOCATION at an open (the review's approval request) and #181's BOT_RECALL.
 */
export const ledgerKeys = {
  /** START_GRANT: the grant (`start_grants.id`). */
  startGrant: (grantId: string) => grantId,
  /** CLOSURE_FORFEIT: the closed account itself — one per account. */
  closure: (userId: string) => userId,
  /** DEPOSIT: the payment. */
  deposit: (paymentId: string) => paymentId,
  /** BONUS: the coupon redemption. */
  couponRedemption: (redemptionId: string) => redemptionId,
  /** PAYMENT_CANCEL: the refund's admin action (a payment is refunded again after a reversal). */
  paymentCancel: (adminActionId: string) => adminActionId,
  /** PAYMENT_CANCEL_REVERSAL: the PAYMENT_CANCEL entry it puts back. */
  paymentCancelReversal: (cancelEntryId: number) => String(cancelEntryId),
  /**
   * SETTLEMENT_PAYOUT: the settlement key (market, judgement version, holder, outcome) — a
   * corrected judgement's version pays again under its own key (#126).
   */
  settlement: (marketId: string, judgementVersion: number, holderId: string, outcome: Outcome) =>
    `${marketId}:${judgementVersion}:${holderId}:${outcome}`,
  /** TRADE_FILL: the fill. */
  fill: (fillId: string) => fillId,
  /** PAIR_MINT_COLLATERAL: the fill that minted the pair, by the buyer's side (two buyers). */
  fillLeg: (fillId: string, outcome: Outcome) => `${fillId}:${outcome}`,
  /** TREASURY_MINT, BOT_ALLOCATION on 증액, RECONCILIATION_CORRECTION: the approved request. */
  approvalRequest: (approvalRequestId: string) => approvalRequestId,
} as const;

export interface LedgerEntryInput {
  type: LedgerEntryType;
  /** Positive. */
  amountCoin: bigint;
  /** null: a mint. */
  from: LedgerAccountRef | null;
  /** null: a burn. */
  to: LedgerAccountRef | null;
  /**
   * The event's market. Defaults to the market of a side that is a market's account (or none);
   * a fill between two people names it.
   */
  marketId?: string | null;
  refType: LedgerRefType;
  refId: string;
  /** From `ledgerKeys`: the same key of the same type twice is one event. */
  idempotencyKey: string;
  memo?: string | null;
  /** The from-account's bucket that pays: `locked` only where the type's rule allows it. */
  debitFrom?: 'available' | 'locked';
  /**
   * The event's instant, for a caller that locked every account already (`lockLedgerAccounts`)
   * and read the clock after; otherwise read here after the locks.
   */
  at?: Date;
}

export type RecordLedgerEntryResult =
  | { outcome: 'recorded'; entry: LedgerEntryRow; from: BalanceRow | null; to: BalanceRow | null }
  | { outcome: 'duplicate'; entry: LedgerEntryRow };

/**
 * Records one ledger event and moves its Coin, in the caller's transaction (`tx`), once per
 * (type, key): the one function that writes `ledger_entries` and changes a balance's total.
 * 1. The event is checked against its type's rule (`ledgerEntryShapeError`): `refused`.
 * 2. Its accounts are made if new and locked (`lockLedgerAccounts`), ascending.
 * 3. Its key is looked up after the locks: recorded before with the same accounts, amount and
 *    market — `duplicate`, nothing moves (a concurrent twin waited on a shared lock and sees it
 *    now); with others — `key_conflict`.
 * 4. The instant (`at`, or the clock after the last lock).
 * 5. The paying bucket must hold the amount, and so must the ledger total (Coin a gap added to
 *    the buckets is not the ledger's to pay) — `insufficient_coin`, nothing written; the CHECKs
 *    `>= 0` back it.
 * 6. The event, with each side's total after it — its ledger total (`balances.ledger_coin`) minus
 *    or plus the amount, never the buckets' sum — then each balance: the paying bucket (available,
 *    or locked) and `ledger_coin` of the from side, available and `ledger_coin` of the to side, in
 *    one UPDATE each. An account whose buckets already differ from its ledger (an owner-level
 *    write, ADR-0109 결정 12-8) keeps that difference and still takes the event (ADR-0107 결정 2
 *    #73 10항). One whose `ledger_coin` itself left its ledger takes none: the database refuses
 *    the event until the owner resets the copy (ADR-0109 결과 5).
 * The database re-checks the pair, the market and the chain at INSERT, the difference at every
 * UPDATE, and the ledger totals and the closed accounts at COMMIT (migration 0060). Throws
 * `LedgerEntryError` with the reasons above.
 */
export async function recordLedgerEntry(
  tx: Tx,
  input: LedgerEntryInput,
): Promise<RecordLedgerEntryResult> {
  const fromKind: LedgerAccountKind | null = input.from?.kind ?? null;
  const toKind: LedgerAccountKind | null = input.to?.kind ?? null;
  const marketId =
    input.marketId !== undefined ? input.marketId : (marketOf(input.from) ?? marketOf(input.to));
  const shapeError = ledgerEntryShapeError({
    type: input.type,
    amountCoin: input.amountCoin,
    fromKind,
    toKind,
    marketId,
    fromMarketId: marketOf(input.from),
    toMarketId: marketOf(input.to),
    ...(input.debitFrom === undefined ? {} : { debitFrom: input.debitFrom }),
  });
  if (shapeError !== null) throw new LedgerEntryError('refused', shapeError);
  if (input.idempotencyKey === '') {
    throw new LedgerEntryError('refused', `${input.type} needs an idempotency key`);
  }

  const sides = [input.from, input.to].filter((ref) => ref !== null);
  const locked = await lockLedgerAccounts(tx, sides);
  const from = input.from === null ? null : locked[0]!;
  const to = input.to === null ? null : locked[input.from === null ? 0 : 1]!;

  const [earlier] = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.type, input.type),
        eq(ledgerEntries.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (earlier) {
    const same =
      earlier.fromAccountId === (from?.account.id ?? null) &&
      earlier.toAccountId === (to?.account.id ?? null) &&
      earlier.amountCoin === input.amountCoin &&
      earlier.marketId === marketId;
    if (!same) {
      throw new LedgerEntryError(
        'key_conflict',
        `${input.type} ${input.idempotencyKey} was recorded as another event (ledger entry ${earlier.id})`,
      );
    }
    return { outcome: 'duplicate', entry: earlier };
  }

  const at = input.at ?? (await clockTimestamp(tx));
  const debitLocked = input.debitFrom === 'locked';
  if (from) {
    const held = debitLocked ? from.balance.lockedCoin : from.balance.availableCoin;
    if (held < input.amountCoin) {
      throw new LedgerEntryError(
        'insufficient_coin',
        `ledger account ${from.account.id} holds ${held} ${debitLocked ? 'locked' : 'available'} Coin, short of ${input.amountCoin}`,
      );
    }
    if (from.balance.ledgerCoin < input.amountCoin) {
      throw new LedgerEntryError(
        'insufficient_coin',
        `ledger account ${from.account.id}'s ledger total is ${from.balance.ledgerCoin} Coin, short of ${input.amountCoin}`,
      );
    }
  }
  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      type: input.type,
      amountCoin: input.amountCoin,
      fromAccountId: from?.account.id ?? null,
      toAccountId: to?.account.id ?? null,
      fromBalanceAfterCoin: from ? from.balance.ledgerCoin - input.amountCoin : null,
      toBalanceAfterCoin: to ? to.balance.ledgerCoin + input.amountCoin : null,
      marketId,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo ?? null,
      createdAt: at,
    })
    .returning();

  let fromBalance: BalanceRow | undefined;
  if (from) {
    [fromBalance] = await tx
      .update(balances)
      .set({
        ...(debitLocked
          ? { lockedCoin: sql`${balances.lockedCoin} - ${input.amountCoin}` }
          : { availableCoin: sql`${balances.availableCoin} - ${input.amountCoin}` }),
        ledgerCoin: sql`${balances.ledgerCoin} - ${input.amountCoin}`,
        // Explicit: the column's `$onUpdate` would write this host's clock, not the database's.
        updatedAt: at,
      })
      .where(eq(balances.accountId, from.account.id))
      .returning();
  }
  let toBalance: BalanceRow | undefined;
  if (to) {
    [toBalance] = await tx
      .update(balances)
      .set({
        availableCoin: sql`${balances.availableCoin} + ${input.amountCoin}`,
        ledgerCoin: sql`${balances.ledgerCoin} + ${input.amountCoin}`,
        updatedAt: at,
      })
      .where(eq(balances.accountId, to.account.id))
      .returning();
  }
  if (!entry || (from && !fromBalance) || (to && !toBalance)) {
    throw new Error(`${input.type} ${input.idempotencyKey} could not be recorded`);
  }
  return { outcome: 'recorded', entry, from: fromBalance ?? null, to: toBalance ?? null };
}
