import type { MarketCancelledByOperatorPayload } from '@buddha/shared';
import { and, eq, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { isHumanAccountTypeSql } from './account-types.js';
import type { Db } from './client.js';
import { transitionMarket } from './market-transitions.js';
import { expireLockedOrders, type ExpiredOrders, type LockedOrders } from './order-cancel.js';
import type * as schema from './schema/index.js';
import { fills, markets } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A transaction: what the cancel takes, as it expires orders (order-cancel.ts). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 거래 없는 시장의 취소 (#20, ADR-0117; ADR-0107 결정 5 '#20·#120 거래가 전혀 없던과 자동
 * CANCELLED', '#20 운영자의 취소 경로', 결정 4 '#120·#20'; ADR-0093 decision 1 #173 items 1·2·10):
 * the one judgement of '사용자 체결 0건' (`marketHasHumanFill`), which the close at `close_at`
 * (`closeMarketAtClose`, market-close.ts) and the approved early close (`endMarketPause`,
 * market-pause.ts) read under the market lock to pick CLOSED or CANCELLED in their own
 * transaction, and the one writer of SCHEDULED → CANCELLED (`cancelScheduledMarket`), the
 * operator's path by another admin's approval — as the open is `openScheduledMarket`'s (ADR-0100
 * 결정 2). No path here leaves OPEN, PAUSED or CLOSED by an operator, and none moves Coin but the
 * locks `expireLockedOrders` gives back: no ledger entry, position, collateral or statistic.
 */

/**
 * Whether `marketId` has at least one fill with a person's account on either side — the opposite
 * of '사용자 체결 0건' (ADR-0107 결정 5 '#20·#120'; 결정 1 #177 11–14항; ADR-0093 decision 1 #173
 * item 10). It reads #119's fill records and their copied account types (ADR-0112 결정 6) through
 * the one account-type rule (`isHumanAccountTypeSql`, #115): a person ↔ person fill, a person ↔
 * 운영 마켓메이커 fill and a pair mint (one fill) all count; orders that never filled — resting,
 * rejected, cancelled or expired — do not, nor does any bot preparation (there is none, #177 6항).
 * Every fill counts, abnormal or not (#177 14항): #132 must not narrow it. Never `trader_count`
 * (ADR-0116 결과 5 '#20'), which #132 will change — the same basis as `hasMarketFill`
 * (market-dispute.ts) per member, read from the fills here. Served by the prefix of the fills'
 * `(market_id, created_at, id)` index.
 *
 * Read it under the market's `lockMarket` to act on it: the intake writes its fills under that
 * lock and commits holding it, so a statement after the lock (READ COMMITTED) sees every fill
 * committed before, and none can follow once the market leaves OPEN (the intake's status check at
 * the fill instant, `assertTrading`).
 */
export async function marketHasHumanFill(reader: Reader, marketId: string): Promise<boolean> {
  const [fill] = await reader
    .select({ id: fills.id })
    .from(fills)
    .where(
      and(
        eq(fills.marketId, marketId),
        or(
          isHumanAccountTypeSql(fills.incomingAccountType),
          isHumanAccountTypeSql(fills.restingAccountType),
        ),
      ),
    )
    .limit(1);
  return fill !== undefined;
}

/**
 * Why `cancelScheduledMarket` left a market as it was (the API answers each with
 * MARKET_CANCEL_REFUSALS of @buddha/shared):
 * - `not_scheduled`: the market is not SCHEDULED — opened, sent back to a draft or cancelled
 *   since the request (`status` 'not scheduled');
 * - `stale`: it is SCHEDULED again, but not the SCHEDULED state the request was asked in: its
 *   `status_event_id` moved (sent back to a draft and approved again; `cancel` 'stale').
 */
export type CancelScheduledSkipReason = 'not_scheduled' | 'stale';

export interface CancelScheduledMarketInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<MarketRow, 'id' | 'status' | 'statusEventId'>;
  /** The market's live orders, `lockMarketOrders(tx, market.id)` after the row, before `now`. */
  orders: LockedOrders;
  /** The DB clock read after the locks (the approval's decision instant): the cancel's instant. */
  now: Date;
  /** The approving admin — never the requester (throws) — the event's actor. */
  approverId: string;
  /** The approved `market_cancel` request. */
  approvalId: string;
  /** Its requester, in the event's payload. */
  requestedBy: string;
  /** The request's reason: the cancel's public reason (#24), stored in the event's payload. */
  reason: string;
  /** The market's `status_event_id` the request pinned (`MarketCancelRequestPayload`). */
  statusEventId: number;
}

export type CancelScheduledMarketResult =
  | {
      cancelled: true;
      /** The market row read back after the writes: `cancelled`, its event's id and instant. */
      market: MarketRow;
      /** The `cancelled` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The orders it ended 만료 at `now` (none: a SCHEDULED market takes no order). */
      expired: ExpiredOrders;
    }
  | { cancelled: false; reason: CancelScheduledSkipReason };

/**
 * SCHEDULED → CANCELLED by an approved `market_cancel` request (#20, ADR-0117; ADR-0107 결정 5 '#20
 * 운영자의 취소 경로'; ADR-0093 decision 1 #173 items 2·10, decision 2 #172 item 6), in the
 * approval's transaction: a market approved for opening ends without opening — the operator's one
 * path to CANCELLED. It cancels a market that is SCHEDULED and still in the state the request
 * pinned, checked in that order (CancelScheduledSkipReason); otherwise it writes nothing and says
 * why. No time is checked: a SCHEDULED market whose open or close has come is cancelled as any
 * other. An approval by the requester is a caller's bug and throws.
 *
 * Call it under `lockMarket`, with `market` read `FOR UPDATE` after the lock, its orders locked
 * after that (`lockMarketOrders`) and `now` the DB clock read after the last lock. The worker's
 * open takes the same lock and checks the status again (`openScheduledMarket`), so a market is
 * never both opened and cancelled: whichever comes second skips (`not_scheduled`).
 *
 * The cancel is `transitionMarket`'s `cancelled` event — from `scheduled`, to `cancelled`, the
 * approver, payload `{cancelledAt, source: 'operator', reason, approvalId, requestedBy}`
 * (MarketCancelledPayload), at `now`, the market's `status_event_id`. The result type stays null.
 * Then every live order of the market ends 만료 at `now` (`expireLockedOrders`): a SCHEDULED market
 * takes none (the intake rejects '개장 전', #177 7·8항), so this finds nothing but rows a test or a
 * later path wrote, and no CANCELLED market keeps a live order. It writes no admin action (the
 * API's) and publishes nothing: the caller publishes `market:status` after COMMIT and removes the
 * delayed open and close jobs (both also skip a market not SCHEDULED, OPEN or PAUSED).
 */
export async function cancelScheduledMarket(
  tx: Tx,
  input: CancelScheduledMarketInput,
): Promise<CancelScheduledMarketResult> {
  const { market, orders, now, approverId, approvalId, requestedBy, reason } = input;
  if (
    orders.scope.kind !== 'market' ||
    orders.scope.marketId !== market.id ||
    orders.markets.length !== 1
  ) {
    throw new Error(`A cancel takes the orders lockMarketOrders locked of market ${market.id}`);
  }
  if (approverId === requestedBy) {
    throw new Error('A market cancel is approved by an admin other than its requester');
  }
  if (market.status !== 'scheduled') return { cancelled: false, reason: 'not_scheduled' };
  if (market.statusEventId !== input.statusEventId) return { cancelled: false, reason: 'stale' };

  const payload: MarketCancelledByOperatorPayload = {
    cancelledAt: now.toISOString(),
    source: 'operator',
    reason,
    approvalId,
    requestedBy,
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'scheduled',
    to: 'cancelled',
    type: 'cancelled',
    actorId: approverId,
    payload: { ...payload },
    at: now,
  });
  const expired = await expireLockedOrders(tx, orders, { at: now });
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was cancelled but could not be read back`);
  return { cancelled: true, market: row, eventId, expired };
}
