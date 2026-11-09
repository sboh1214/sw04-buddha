import {
  LIVE_ORDER_STATUSES,
  isLiveOrderStatus,
  isPreCloseMarketStatus,
  orderRemainingLock,
  type OrderCancelReason,
} from '@buddha/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { isHumanAccountTypeSql } from './account-types.js';
import type { Db } from './client.js';
import { lockOrderHolders, releaseForOrder, type PositionRow } from './contracts.js';
import { ledgerHeldMarketIds, ledgerHeldMarketSql } from './ledger-held-markets.js';
import { orderLockFactsOf, type OrderRow } from './orders.js';
import { balances, ledgerAccounts, markets, orders, positions, user } from './schema/index.js';
import { clockTimestamp, lockMarket, lockMarkets } from './tx-helpers.js';

/*
 * 주문 취소 (#178, ADR-0113; ADR-0107 결정 1 #177 7·8·9항, 결정 4 #119·#178 rows, 결정 5 '#119 일시
 * 중단'·'#178 탈퇴'·'#178·#143 관리자 권한' rows, 결정 6 owner answer 2026-11-06): the one cancel
 * processing every flow uses — the member's own cancel (and #129's quote refresh), the pause and
 * the end of a pause (market-pause.ts), the account restriction's approval and the closure (the
 * API's), the admin-role grant (#143's, to come). The second writer of `orders` beside the intake
 * (order-writes.test.ts), every write under the market's `lockMarket`.
 *
 * A cancel ends a live order (대기·부분 체결) as 취소 완료 with its reason, the whole remaining
 * quantity at once — no amend and no partial cancel (#177 9항) — and gives its remaining lock back
 * (`orderRemainingLock`: a buy's limit × (qty − filled) Coin, a sell's qty − filled contracts)
 * through contracts.ts `releaseForOrder` alone: no ledger entry, no fill, tick, price or volume,
 * the filled quantity and amount kept, the other orders' `arrival_seq` untouched. It finishes in
 * the caller's transaction, so `ended_at` is both the request and the completion instant
 * (ADR-0112 10-5): '취소 요청 중' is a screen state (#123), never a server one (#177 7항). The
 * order id is the dedupe key: an ended order (전량 체결, 취소 완료, 만료, 거절) is answered as it
 * is, and a repeat releases nothing. The reasons: 본인 취소 (`by_owner`: the member, #129's
 * refresh), 일시 중단 (`paused`: a pause, the end of a pause), 계정 제한 (`restricted`), 탈퇴
 * (`account_closed`) and 관리자 권한 (`admin_role`, #143); the intake writes the other two.
 *
 * The same core ends a live order as 만료 (#120, ADR-0115; ADR-0107 결정 1 #177 7항): a state, not a
 * cancel reason (8항) — the market's close at `close_at` (market-close.ts), a non-held early close
 * (market-pause.ts) — either one CLOSED or, with no fill a person's account is on, CANCELLED (#20)
 * — #20's SCHEDULED cancel (market-cancel.ts) and #93's recovery of a closed held market end every
 * live order of every account type so (`expireLockedOrders`), with the same single release, the
 * filled quantity and amount kept, and no cancel reason (migration 0062's `orders_status_check`).
 *
 * A market held for a ledger failure (ledger-held-markets.ts) takes no order lock or ledger
 * write until its recovery (결정 4 #178 rows): one order there is answered `held` with nothing
 * written, and a batch skips its orders and returns them, still locked (the owner's answer); only
 * the transaction that ends the hold (`endsHold`) ends them.
 *
 * Lock order: `lockMarket` (one market) or `lockMarkets` (an account's markets, ascending lock
 * key) → the live rows read under it → every owner's Coin account at once (`lockOrderHolders`,
 * ADR-0110 결정 4: a market's people and its 운영 마켓메이커 in one call; an account's, one call
 * per market for that one person, all before the first release — the 10-28 exception) → the
 * clock → the releases and the rows. A batch is two phases: `lockMarketOrders` or
 * `lockAccountOrders` takes every lock and reads the rows (`LockedOrders`), the caller reads its
 * instant after it, and `cancelLockedOrders` writes.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Db | Tx;

/** The reasons this processing writes; the intake's own two (#119) never come here. */
export type OrderCancelProcessReason = Exclude<OrderCancelReason, 'ioc_remainder' | 'self_trade'>;

/**
 * What a cancel changed that a person's screen follows, for the caller to publish after COMMIT:
 * each person's position row a sell's release wrote, as it stands at the end (the 운영 마켓메이커
 * left out). A Coin release records no ledger entry, so no balance is listed (ADR-0112 10-10).
 */
export interface CancelTouched {
  positions: PositionRow[];
}

export type CancelOrderResult =
  /** This call ended the order: its row as written. */
  | { kind: 'cancelled'; order: OrderRow; touched: CancelTouched }
  /** The order had ended (filled, cancelled, expired, rejected): as it is, nothing written. */
  | { kind: 'ended'; order: OrderRow }
  /** Live in a market held for a ledger failure: nothing written until its recovery. */
  | { kind: 'held'; order: OrderRow }
  /** No order of this owner by that id — another account's included, never read back. */
  | { kind: 'not_found' };

export interface CancelOrderInput {
  /** The order's owner: a person, or the 운영 마켓메이커 (#129). */
  ownerId: string;
  /** The order's id (a uuid: the API's param schema refuses anything else first). */
  orderId: string;
  /** `by_owner` for the member and the bot's refresh. */
  reason: OrderCancelProcessReason;
}

/** One market's live orders under its locks: phase 1 of a batch. */
export interface LockedMarketOrders {
  readonly marketId: string;
  /** Held for a ledger failure when read (ledger-held-markets.ts). */
  readonly held: boolean;
  /** Its live orders of the batch, in arrival order. */
  readonly orders: readonly OrderRow[];
}

/** The brand only `lockMarketOrders` and `lockAccountOrders` set (not exported). */
const LOCKED: unique symbol = Symbol('LockedOrders');

/**
 * Phase 1 of a batch cancel: every lock taken and the live rows read under them, in this
 * transaction. Required by `cancelLockedOrders`, `pauseMarket` and `endMarketPause`. Its brand
 * (`LOCKED`, not exported) is set only by `lockMarketOrders` and `lockAccountOrders`, so leaving
 * the argument out or building one by hand fails to compile. That is all the type guards: a copy
 * spread from a real one compiles, and a value made in another transaction does too, so the
 * contract that the locks are this transaction's and `held` was read under them is the callers'.
 * Reading the instant after it (the batch's `now`, not one read before the order locks) is the
 * caller's job too; every current caller does both.
 */
export interface LockedOrders {
  readonly [LOCKED]: true;
  /** The caller will leave held orders untouched; this batch must never end their hold. */
  readonly preservesHold?: true;
  readonly scope: { kind: 'market'; marketId: string } | { kind: 'account'; ownerId: string };
  readonly markets: readonly LockedMarketOrders[];
}

/** What a cancel batch did. */
export interface CancelledOrders {
  /** Every order it ended, as written, market by market. */
  cancelled: OrderRow[];
  /** Live orders it skipped in held markets: still live, still locked (the owner's answer). */
  held: OrderRow[];
  touched: CancelTouched;
}

/** What an expiry batch did (`expireLockedOrders`). */
export interface ExpiredOrders {
  /** Every order it ended as 만료, as written. */
  expired: OrderRow[];
  /** Live orders it skipped in a held market: still live and locked (#93's recovery ends them). */
  held: OrderRow[];
  /** People's position rows only (`touchedOf`), for #134's notice. */
  touched: CancelTouched;
}

/** How the core ends a live order: 취소 완료 with its reason, or 만료 (a state, never a reason). */
type OrderEnd = { status: 'cancelled'; reason: OrderCancelProcessReason } | { status: 'expired' };

const LIVE = inArray(orders.status, [...LIVE_ORDER_STATUSES]);

/**
 * The markets a batch ended an order in, each once in the batch's order: whose public book
 * changed, for the caller's `market:book` after COMMIT (#179). Skipped held orders changed nothing.
 */
export function cancelledMarketIds(batch: Pick<CancelledOrders, 'cancelled'>): string[] {
  return [...new Set(batch.cancelled.map((row) => row.marketId))];
}

function assertProcessReason(reason: OrderCancelReason): void {
  if (reason === 'ioc_remainder' || reason === 'self_trade') {
    throw new RangeError(`the intake writes '${reason}' itself; a cancel never does`);
  }
}

/**
 * Ends `rows` — live orders of `marketId`, read under its `lockMarket` with their owners' Coin
 * accounts locked (`lockOrderHolders`) — as `end` at `at`: 취소 완료 with its reason, or 만료 with
 * none (#120), each lock given back once. The UPDATE matches the row as it was read (status and
 * filled qty): no row means a writer worked without the market lock, a bug that throws, and the
 * caller's transaction rolls back. A lock above what is held (`ContractError` 'refused') throws
 * the same way.
 */
async function endOrders(
  tx: Tx,
  marketId: string,
  rows: readonly OrderRow[],
  end: OrderEnd,
  at: Date,
): Promise<{ ended: OrderRow[]; positions: PositionRow[] }> {
  const ended: OrderRow[] = [];
  const positions: PositionRow[] = [];
  const set =
    end.status === 'cancelled'
      ? { status: end.status, cancelReason: end.reason, endedAt: at, updatedAt: at }
      : { status: end.status, endedAt: at, updatedAt: at };
  for (const row of rows) {
    if (row.marketId !== marketId) throw new Error(`order ${row.id} is not of ${marketId}`);
    const lock = orderRemainingLock(orderLockFactsOf(row));
    const [written] = await tx
      .update(orders)
      .set(set)
      .where(
        and(
          eq(orders.id, row.id),
          eq(orders.status, row.status),
          eq(orders.filledQty, row.filledQty),
        ),
      )
      .returning();
    if (!written) throw new Error(`order ${row.id} changed outside its market's lock`);
    const released = await releaseForOrder(tx, { marketId, ownerId: row.userId, lock, at });
    if (released.position !== null) positions.push(released.position);
    ended.push(written);
  }
  return { ended, positions };
}

/** The people's rows of `positions`, the last write of each row kept (one `user` read). */
async function touchedOf(tx: Tx, positions: readonly PositionRow[]): Promise<CancelTouched> {
  if (positions.length === 0) return { positions: [] };
  const last = new Map<string, PositionRow>();
  for (const row of positions) last.set(`${row.userId}:${row.marketId}:${row.outcome}`, row);
  const named = [...new Set([...last.values()].map((row) => row.userId))];
  // The 운영 마켓메이커 has no screen to follow (the one rule tells it apart).
  const people = new Set(
    (
      await tx
        .select({ id: user.id })
        .from(user)
        .where(and(inArray(user.id, named), isHumanAccountTypeSql(user.accountType)))
    ).map((row) => row.id),
  );
  return { positions: [...last.values()].filter((row) => people.has(row.userId)) };
}

/**
 * 주문 취소 of one order by its owner (#178): the member's `POST /me/orders/:id/cancel` and #129's
 * quote refresh, in the caller's transaction. In order: the owner's order by id with no lock
 * (none → `not_found`; another account's is never read), `lockMarket` (its market never changes),
 * the row again (every writer holds that lock, so it is the truth), an ended order answered as
 * it is (`ended`), a live one in a held market answered `held` (the ended check first, so an
 * ended order there answers its final state), the owner's Coin account (`lockOrderHolders`, the
 * transaction's first balance row), the clock, then the release and the row (`cancelled`). Any
 * market status: a held CLOSED market's order answers `held`; elsewhere the close has expired
 * them (#120), so an own cancel there answers `ended` — and a live row left from before #120 in a
 * closed market, or a SETTLING market's resting sell, can still be cancelled.
 */
export async function cancelOrder(tx: Tx, input: CancelOrderInput): Promise<CancelOrderResult> {
  assertProcessReason(input.reason);
  const { ownerId, orderId } = input;
  const [found] = await tx
    .select({ marketId: orders.marketId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, ownerId)))
    .limit(1);
  if (!found) return { kind: 'not_found' };
  await lockMarket(tx, found.marketId);
  const [row] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!row) throw new Error(`order ${orderId} left the table`);
  if (!isLiveOrderStatus(row.status)) return { kind: 'ended', order: row };
  if ((await ledgerHeldMarketIds(tx, [row.marketId])).has(row.marketId)) {
    return { kind: 'held', order: row };
  }
  await lockOrderHolders(tx, row.marketId, [ownerId]);
  const at = await clockTimestamp(tx);
  const done = await endOrders(
    tx,
    row.marketId,
    [row],
    { status: 'cancelled', reason: input.reason },
    at,
  );
  return { kind: 'cancelled', order: done.ended[0]!, touched: await touchedOf(tx, done.positions) };
}

/**
 * Phase 1 of a market's batch (a pause, the end of a pause, the close's expiry, #20's SCHEDULED
 * cancel; #93 later): `lockMarket`, the market's live orders in arrival order, whether it is held,
 * then every owner's Coin account at once — the people's and the 운영 마켓메이커's 마켓메이커 자금 in one
 * `lockOrderHolders` (ADR-0110 결정 4) — even when nothing will be cancelled (a `ledger_failure`
 * pause): it locks rows and writes nothing. The scheduled close sets `preserveHold` because a
 * held market changes only its status: missing/broken balances must not prevent that exit.
 * Such a batch reads the live orders under the market lock without locking assets and cannot
 * be reused to release held orders. Recovery uses the default, complete asset lock path.
 */
export async function lockMarketOrders(
  tx: Tx,
  marketId: string,
  options: { preserveHold?: boolean } = {},
): Promise<LockedOrders> {
  await lockMarket(tx, marketId);
  const rows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.marketId, marketId), LIVE))
    .orderBy(asc(orders.arrivalSeq));
  const held = (await ledgerHeldMarketIds(tx, [marketId])).has(marketId);
  if (!held || !options.preserveHold) {
    await lockOrderHolders(
      tx,
      marketId,
      rows.map((row) => row.userId),
    );
  }
  return {
    [LOCKED]: true,
    ...(options.preserveHold ? { preservesHold: true as const } : {}),
    scope: { kind: 'market', marketId },
    markets: [{ marketId, held, orders: rows }],
  };
}

/**
 * Phase 1 of an account's batch (the restriction's approval, the closure; #143's role grant):
 * the markets of the person's live orders (read with no lock), all of them at once with
 * `lockMarkets` (ascending lock key), its live orders again under them, which are held, then the
 * person's Coin account in each market not held (`lockOrderHolders` per market, every one before
 * the first release: the ADR-0110 10-28 exception in its strict form). A held market takes no
 * balance-row lock: its orders are skipped. A person's only: the 운영 마켓메이커 is never the
 * subject of an account's processing.
 *
 * Precondition: the caller holds the person's profile row FOR UPDATE. An intake takes it FOR KEY
 * SHARE before its market lock (ADR-0112 10-16), so the set of markets with a live order can only
 * shrink while this runs. An order found again in a market not locked means the precondition was
 * broken, and this throws; that check is partial: an order committing after the re-read is missed
 * with no error, so the profile lock is what makes the batch complete, not this throw.
 */
export async function lockAccountOrders(
  tx: Tx,
  ownerId: string,
  options: { wait?: 'wait' | 'nowait' } = {},
): Promise<LockedOrders> {
  const marketIds = (
    await tx
      .selectDistinct({ marketId: orders.marketId })
      .from(orders)
      .where(and(eq(orders.userId, ownerId), LIVE))
  )
    .map((row) => row.marketId)
    .sort();
  await lockMarkets(tx, marketIds, options);
  const rows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.userId, ownerId), LIVE))
    .orderBy(asc(orders.arrivalSeq));
  const locked = new Set(marketIds);
  const stray = rows.find((row) => !locked.has(row.marketId));
  if (stray !== undefined) {
    throw new Error(
      `order ${stray.id} of ${ownerId} came in market ${stray.marketId} after its markets were ` +
        'locked: lock the profile FOR UPDATE first',
    );
  }
  const held = await ledgerHeldMarketIds(tx, marketIds);
  const markets: LockedMarketOrders[] = [];
  for (const marketId of marketIds) {
    const live = rows.filter((row) => row.marketId === marketId);
    if (live.length === 0) continue;
    markets.push({ marketId, held: held.has(marketId), orders: live });
  }
  if (options.wait === 'nowait') {
    const active = markets.filter((entry) => !entry.held);
    const ids = active.map((entry) => entry.marketId);
    if (ids.length > 0) {
      const accounts = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          or(
            and(eq(ledgerAccounts.kind, 'user'), eq(ledgerAccounts.ownerId, ownerId)),
            and(
              inArray(ledgerAccounts.marketId, ids),
              inArray(ledgerAccounts.kind, ['market_collateral', 'market_maker_funds']),
            ),
          ),
        );
      if (!accounts.some((account) => account.kind === 'user'))
        throw new Error(`account ${ownerId} has no ledger account`);
      const lockedBalances = await tx
        .select()
        .from(balances)
        .where(
          inArray(
            balances.accountId,
            accounts.map((account) => account.id),
          ),
        )
        .orderBy(asc(balances.accountId))
        .for('update', { noWait: true });
      if (lockedBalances.length !== accounts.length)
        throw new Error('An order account has no balance row');
      await tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, ownerId), inArray(positions.marketId, ids)))
        .orderBy(asc(positions.marketId), asc(positions.outcome))
        .for('update', { noWait: true });
      await tx
        .select()
        .from(orders)
        .where(
          inArray(
            orders.id,
            active.flatMap((entry) => entry.orders.map((order) => order.id)),
          ),
        )
        .orderBy(asc(orders.arrivalSeq))
        .for('update', { noWait: true });
    }
  }
  // Every balance row before the first release (the releases come in `cancelLockedOrders`).
  for (const entry of markets) {
    if (!entry.held) await lockOrderHolders(tx, entry.marketId, [ownerId]);
  }
  return { [LOCKED]: true, scope: { kind: 'account', ownerId }, markets };
}

/**
 * Phase 2 of a batch, either end: every order `locked` holds ended as `end` at `at`, market by
 * market; a held market's skipped and returned in `held` unless `endsHold`.
 */
async function endLockedOrders(
  tx: Tx,
  locked: LockedOrders,
  end: OrderEnd,
  options: { at: Date; endsHold?: boolean },
): Promise<{ ended: OrderRow[]; held: OrderRow[]; touched: CancelTouched }> {
  const endsHold = options.endsHold ?? false;
  if (endsHold && locked.scope.kind !== 'market') {
    throw new Error("only a market's batch ends its hold");
  }
  if (endsHold && locked.preservesHold) {
    throw new Error('a batch preserving a ledger hold cannot end it');
  }
  const ended: OrderRow[] = [];
  const held: OrderRow[] = [];
  const positions: PositionRow[] = [];
  for (const entry of locked.markets) {
    if (entry.held && !endsHold) {
      held.push(...entry.orders);
      continue;
    }
    const done = await endOrders(tx, entry.marketId, entry.orders, end, options.at);
    ended.push(...done.ended);
    positions.push(...done.positions);
  }
  return { ended, held, touched: await touchedOf(tx, positions) };
}

/**
 * Phase 2 of a batch: ends every order `locked` holds as 취소 완료 with `reason` at `at` — the
 * instant the caller read after phase 1 — each lock given back, market by market. A held market's
 * orders are skipped and returned in `held`, still live and locked (the owner's answer), unless
 * `endsHold`: the transaction that ends the market's hold (the pause end's approval,
 * `endMarketPause`) ends them too. #93's recovery of a market that closed meanwhile ends them as
 * 만료, not 취소 완료 (ADR-0107 decision 4): it takes `endsHold` only through
 * `expireLockedOrders`, never a cancel reason. Only a market's batch ends a hold: an account's
 * took no balance row in a held market.
 */
export async function cancelLockedOrders(
  tx: Tx,
  locked: LockedOrders,
  options: { reason: OrderCancelProcessReason; at: Date; endsHold?: boolean },
): Promise<CancelledOrders> {
  assertProcessReason(options.reason);
  const done = await endLockedOrders(
    tx,
    locked,
    { status: 'cancelled', reason: options.reason },
    options,
  );
  return { cancelled: done.ended, held: done.held, touched: done.touched };
}

/**
 * Phase 2 of a market's batch as 만료 (#120, ADR-0115; ADR-0107 결정 1 #177 7항 '마감·취소 때의 잔량', 결정 5
 * '#20·#120·#177 7항'): every live order of every account type `locked` holds — a person's, the 운영
 * 마켓메이커's — ended 만료 at `at`, the instant the caller read after phase 1, its remaining lock given
 * back once (`releaseForOrder`, as a cancel): no cancel reason, the filled quantity and amount
 * kept, no ledger entry, fill or tick. The close at `close_at`, a non-held early close (either
 * CLOSED or CANCELLED, #20), #20's SCHEDULED cancel and #93's recovery of a closed held market call
 * it, each after its transition in the same transaction: it throws unless `locked` is one market's
 * batch and that market has left trading (DRAFT…PAUSED refused — 만료 is a market's end, never an
 * account's). A market held for a ledger failure keeps its orders live and locked, returned in
 * `held` (ADR-0107 결정 4 #178 '복구 전에 마감이 오면'), unless `endsHold`: #93's recovery passes it.
 */
export async function expireLockedOrders(
  tx: Tx,
  locked: LockedOrders,
  options: { at: Date; endsHold?: boolean },
): Promise<ExpiredOrders> {
  if (locked.scope.kind !== 'market') {
    throw new Error("만료 is a market's end: an account's batch never expires an order");
  }
  const { marketId } = locked.scope;
  const [market] = await tx
    .select({ status: markets.status })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!market) throw new Error(`market ${marketId} does not exist`);
  if (isPreCloseMarketStatus(market.status)) {
    throw new Error(`market ${marketId} is ${market.status}: 만료 only after it leaves trading`);
  }
  const done = await endLockedOrders(tx, locked, { status: 'expired' }, options);
  return { expired: done.ended, held: done.held, touched: done.touched };
}

/**
 * The person's live orders in held markets, in arrival order: what waits for a recovery, and
 * refuses a closure (`orders_awaiting_recovery`, the owner's answer). Read under the markets'
 * locks to act on it (the closure), or with none for a check.
 */
export async function ordersAwaitingRecovery(reader: Reader, ownerId: string): Promise<OrderRow[]> {
  return reader
    .select()
    .from(orders)
    .where(and(eq(orders.userId, ownerId), LIVE, ledgerHeldMarketSql(orders.marketId)))
    .orderBy(asc(orders.arrivalSeq));
}
