import {
  ORDER_FILLED_NOTIFICATION,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  serializeCoinAmount,
  type MatchFill,
  type NotificationTarget,
  type OrderExpiryCause,
  type OrderFilledParams,
  type OrdersCancelledParams,
  type OrdersExpiredParams,
} from '@buddha/shared';
import type { NotificationInput } from './notifications.js';
import type { FillRow, LiveBookOrder, OrderRow } from './orders.js';

/*
 * 거래 알림 (#134, ADR-0158; N05 §4, 52-2…52-6, 134-1…134-3): the inputs of the three 거래 types,
 * built from the rows their events already wrote. Pure functions: each producer's transaction owner
 * passes their output to its ONE `createNotifications` call, last in the transaction (ADR-0157
 * 결정 4), so the later producers of the same transactions append inputs instead of making a
 * second call: #54's close, pause, resume and cancel notices (market-notifications.ts, ADR-0159 —
 * after these, in the same array) and #135's restriction notice.
 *
 * Who calls them: the intake (`placeOrder` returns `notifications`; the API's `OrderService.place`
 * and the cycle's `finish()` deliver them), the close at `close_at` (`closeMarketAtClose`), the
 * pause and its approved end (market-pause.service.ts), a SCHEDULED market's cancel (its expiry is
 * always empty; #54's watcher notice rides on it), the admin-role grant, the restriction's
 * approval and the recovery of a closed held market (the API's services). The paths that never
 * notify — a member's own cancel, the intake's own results, the closure, the bootstrap seed — are
 * pinned in order-notifications.test.ts.
 *
 * A throw here, or an input the definitions refuse, rolls the event back (ADR-0157 결정 4의 7): a
 * close would stay undone, a fill refused. So the builders never produce what the definitions
 * refuse, and their tests run every producer's real row shapes through `createNotifications`.
 */

/** A fill's event key: one notice per fill and recipient (53-4). */
export const fillEventKey = (fillId: number): string => `fill:${String(fillId)}`;
/**
 * A market event's (`market_events.id`: a pause, its approved end, a close, a cancel, a
 * supplement) event key — #134's order notices and #54's market notices alike.
 */
export const marketEventKey = (eventId: number): string => `market_event:${String(eventId)}`;
/** An admin action's (`admin_actions.id`: the admin-role grant) event key. */
export const adminActionEventKey = (id: string): string => `admin_action:${id}`;
/** A moderation action's (`moderation_actions.id`: a restriction's approval) event key. */
export const moderationActionEventKey = (id: string): string => `moderation_action:${id}`;
/** A reconciliation hold's (its recovery) event key. */
export const reconciliationHoldEventKey = (id: string): string => `reconciliation_hold:${id}`;

/** One fill of a resting order, as the intake wrote it (orders.ts `placeOrder`, step 7). */
export interface RestingFill {
  /** The fill row: its id keys the event. */
  readonly fill: Pick<FillRow, 'id'>;
  /** The resting order as the book read it: its owner, its contract and its direction. */
  readonly resting: Pick<LiveBookOrder, 'id' | 'owner' | 'outcome' | 'side'>;
  /** The planned fill: its quantity, the resting order's own price, what the order has left. */
  readonly planned: Pick<MatchFill, 'qty' | 'restingPriceCoin' | 'restingRemainingQty'>;
  /** The resting order after this fill, as written: its quantity and filled quantity (134-3). */
  readonly order: { readonly qty: number; readonly filledQty: number };
}

export interface RestingFillNotices {
  /** The market's title at the intake (ADR-0157 결정 3: public, stored at the event). */
  readonly marketTitle: string;
  /** The intake's instant: every fill's, and the notice's 발생 시각. */
  readonly at: Date;
  readonly fills: readonly RestingFill[];
}

/**
 * `order_filled` (52-2, 52-6, 134-1·134-3): one input per fill whose RESTING order is a person's —
 * never the incoming order's (its fills, IOC remainder, self-trade stop and rejection are the
 * placing request's own result, 52-2) and never the 운영 마켓메이커's (no inbox). Merged by the
 * resting order: its unread notice gathers its fills (52-6).
 *
 * The price is the resting order's own (`restingPriceCoin`: the fill price, N01 §4, and what the
 * order's `filled_amount_coin` adds), never the fill row's `priceCoin`/`amountCoin`, `outcome` or
 * `side` — those are the incoming order's (a pair mint's are 100 − the resting price, and its
 * outcome is the other contract). So a notice's `amountCoin / qty` is always the order's limit.
 */
export function restingFillNotificationInputs({
  marketTitle,
  at,
  fills,
}: RestingFillNotices): NotificationInput[] {
  return fills
    .filter(({ resting }) => resting.owner.human)
    .map(({ fill, resting, planned, order }) => {
      const params: OrderFilledParams = {
        marketTitle,
        outcome: resting.outcome,
        side: resting.side,
        qty: String(planned.qty),
        amountCoin: serializeCoinAmount(BigInt(planned.restingPriceCoin) * BigInt(planned.qty)),
        fullyFilled: planned.restingRemainingQty === 0,
        orderQty: String(order.qty),
        orderFilledQty: String(order.filledQty),
      };
      return {
        userId: resting.owner.id,
        type: ORDER_FILLED_NOTIFICATION.type,
        eventKey: fillEventKey(fill.id),
        mergeKey: resting.id,
        occurredAt: at,
        target: { kind: 'order', orderId: resting.id },
        params,
      };
    });
}

/** A market as a notice names it: its id (the history's filter) and its title at the event. */
export interface NoticeMarket {
  readonly id: string;
  readonly title: string;
}

/**
 * The event that ended a batch of resting orders, as its transaction owner names it (52-3·52-4):
 * - a pause's cancel (`paused` — the pause, its approved end, the ledger-failure recovery): a
 *   market event;
 * - the admin-role grant's (`admin_role`) and the restriction's (`restricted`): an account event
 *   across markets;
 * - an expiry (거래 마감 `closed` or 시장 취소 `cancelled`, the market's status after it, 52-5).
 */
export type OrderEndNotice =
  | {
      kind: 'cancelled';
      reason: 'paused';
      market: NoticeMarket;
      eventKey: string;
      occurredAt: Date;
    }
  | { kind: 'cancelled'; reason: 'admin_role' | 'restricted'; eventKey: string; occurredAt: Date }
  | {
      kind: 'expired';
      cause: OrderExpiryCause;
      market: NoticeMarket;
      eventKey: string;
      occurredAt: Date;
    };

/** Whether a row ended the way the notice says: 취소 완료 with its reason, or 만료. */
const endedAs = (row: OrderRow, notice: OrderEndNotice): boolean =>
  notice.kind === 'cancelled'
    ? row.status === 'cancelled' && row.cancelReason === notice.reason
    : row.status === 'expired';

/**
 * `orders_cancelled` and `orders_expired` (52-3, 52-4, 52-5): one input per member with ended
 * orders in `ended`, sorted by member — `orderCount` N their rows, `marketCount` M their distinct
 * markets; leading to the order itself when N = 1, else to their ended orders of the notice's
 * market (all markets for an account event, `marketId` null). Nothing for no rows.
 *
 * Pass the rows the batch ENDED (`cancelled` or `expired`), never its `held` ones: those stay live
 * and are notified when the recovery or the held market's end ends them. The 운영 마켓메이커's rows
 * pass through and the write path's gate skips it (53-5: no inbox) — a row carries no account
 * type, and one more input per batch is cheaper than a read. Throws (a caller bug: the event rolls
 * back) on a row that did not end as the notice says, or of another market for a market notice.
 */
export function orderEndNotificationInputs(
  ended: readonly OrderRow[],
  notice: OrderEndNotice,
): NotificationInput[] {
  const market = notice.kind === 'expired' || notice.reason === 'paused' ? notice.market : null;
  const byMember = new Map<string, OrderRow[]>();
  for (const row of ended) {
    if (!endedAs(row, notice)) {
      throw new Error(
        `order ${row.id} is ${row.status}/${row.cancelReason ?? '-'}, not the notice's end`,
      );
    }
    if (market !== null && row.marketId !== market.id) {
      throw new Error(`order ${row.id} is not of market ${market.id}`);
    }
    const rows = byMember.get(row.userId) ?? [];
    rows.push(row);
    byMember.set(row.userId, rows);
  }
  return [...byMember.keys()].sort().map((userId) => {
    const rows = byMember.get(userId)!;
    const target: NotificationTarget =
      rows.length === 1
        ? { kind: 'order', orderId: rows[0]!.id }
        : { kind: 'order_history', marketId: market?.id ?? null };
    const common = { userId, eventKey: notice.eventKey, occurredAt: notice.occurredAt, target };
    if (notice.kind === 'expired') {
      const params: OrdersExpiredParams = {
        marketTitle: notice.market.title,
        cause: notice.cause,
        orderCount: rows.length,
      };
      return { ...common, type: ORDERS_EXPIRED_NOTIFICATION.type, params };
    }
    const params: OrdersCancelledParams = {
      reason: notice.reason,
      orderCount: rows.length,
      marketCount: new Set(rows.map((row) => row.marketId)).size,
      marketTitle: market?.title ?? null,
    };
    return { ...common, type: ORDERS_CANCELLED_NOTIFICATION.type, params };
  });
}
