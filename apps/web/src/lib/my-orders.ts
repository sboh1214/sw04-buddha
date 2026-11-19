import { type OrderStatus, PAGE_LIMIT_MAX } from '@buddha/shared';
import { type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import { ACCOUNT_CLOSURE_KEY } from './account-closure';
import { type MyFill, type Order, isApiError, isForAnotherAccount } from './api';
import { formatContracts } from './market-admin';
import { ORDERS_KEY, POSITIONS_KEY, marketBookKey, marketSellableKey } from './market-keys';
import { contractSideLabel, formatContractPrice } from './order-confirm';
import { orderReasonName, orderStatusLabel } from './order-reasons';
import { type CursorPage, isLiveOrder, joinOrder } from './order-join';
import { ME_KEY, restartQueries } from './query-client';

export {
  type CursorPage,
  type OrderPages,
  isLiveOrder,
  joinOrder,
  joinOrderPages,
  liveRowsOnly,
  orderRank,
  remainingQty,
  withOrderInPages,
} from './order-join';

/**
 * 대기 주문과 주문 상세 (#123, ADR-0141): the pure rules MY's 대기 주문, the detail's 내 대기 주문
 * and 내 거래 and an order's 주문 상세 draw by — the remaining quantity, the state history, the
 * join that keeps a late answer from rolling a row back, what a cancel's answer means, when
 * '취소 요청 중' shows, which orders may have ended while watched and the one notice each gets.
 * No React, no DOM, no clock: the node runner reaches every one of them (my-orders.test.ts).
 */

export type FillPages = InfiniteData<CursorPage<MyFill>, string | undefined>;

/** A page of the live list, 20 at a time (the API's default page). */
export const LIVE_ORDERS_PAGE = 20;
/**
 * The wallet's one page of the live orders (#302, ADR-0146): the most the API gives in a page
 * (`PAGE_LIMIT_MAX`, 100), so the lock watch (`useWalletLockWatch`) compares the account's newest
 * 100 live buys and sits in the rooms of their markets — still one request a reading, as the 20 of
 * #69 were. Its markets join in one `subscribe` message (`REALTIME_SUBSCRIBE_MAX`, 100) and stay
 * under a socket's rooms (`REALTIME_ROOMS_MAX`, 200). An account with more live orders than this
 * has its oldest ones out of the watch (ADR-0146 결과 5).
 */
export const WALLET_LIVE_ORDERS_PAGE = PAGE_LIMIT_MAX;
/** An order's fills, 100 at a time: most orders fill in fewer, so the history reads them whole. */
export const ORDER_FILLS_PAGE = 100;
/** 내 거래 on the detail, 20 at a time. */
export const MARKET_FILLS_PAGE = 20;
/** At most this many orders are read back at once to learn whether they ended (§2-4). */
export const ENDED_CHECK_MAX = 10;

/** One line of 상태 이력: when (the server's time) and what. */
export interface TimelineRow {
  id: string;
  at: string;
  label: string;
}

/** '체결 3계약 @40.00 Coin', with the state it left the order in when that is known. */
function fillLine(fill: Pick<MyFill, 'qty' | 'priceCoin'>, state: string | null): string {
  const line = `${copy.orderTimelineFill} ${formatContracts(fill.qty)} @${formatContractPrice(
    fill.priceCoin,
  )}`;
  return state === null ? line : `${line} · ${state}`;
}

/** '<상태>(<사유>)', or the state alone when it has no reason. */
export function stateWithReason(
  order: Pick<Order, 'status' | 'rejectReason' | 'cancelReason'>,
): string {
  const reason = orderReasonName(order);
  const state = orderStatusLabel(order.status);
  return reason === null ? state : `${state}(${reason})`;
}

/** Oldest first by id (a bigserial as a decimal string). */
function byFillId(a: Pick<MyFill, 'id'>, b: Pick<MyFill, 'id'>): number {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 상태 이력 (ADR-0141 결정 7), from the order row and its fills alone — there is no state log
 * (ADR-0135 결과 4 #123). `fills` as read so far, newest first as the API pages them;
 * `complete` once every page is read, false while a next page is left, and null while the list is
 * not read at all (its first read pending or failed) — then no line comes from fills: '이전 체결 …
 * 더 보기' points at a page that is there to read, never at a read still out or a list that failed.
 *
 * 1. A 거절 was never taken: one line, '거절(<이름>)' at its time.
 * 2. Otherwise '접수' at `createdAt`, then one line per fill, oldest first, '체결 q계약 @가격'.
 *    Each says the state it left the order in (부분 체결, 전량 체결) only when every fill is read and
 *    they add up to `filledQty` — what is known is the quantity, not the count, so a list read in
 *    part opens with '이전 체결 n계약 — 체결 목록에서 더 보기' and names no state.
 *    A budget order's fills name none: '체결' is already the line's word.
 * 3. An ended order adds '<상태>(<사유>)' at `endedAt` — but a quantity order's 전량 체결 whose last
 *    fill line already says so.
 */
export function orderTimeline(
  order: Order,
  fills: readonly MyFill[],
  complete: boolean | null,
): TimelineRow[] {
  if (order.status === 'rejected') {
    return [{ id: 'rejected', at: order.createdAt, label: stateWithReason(order) }];
  }
  const rows: TimelineRow[] = [
    { id: 'accepted', at: order.createdAt, label: copy.orderTimelineAccepted },
  ];
  if (complete === null) {
    if (order.endedAt !== null) {
      rows.push({ id: 'ended', at: order.endedAt, label: stateWithReason(order) });
    }
    return rows;
  }
  const read = fills.reduce((sum, fill) => sum + fill.qty, 0);
  const named = complete && read === order.filledQty && order.qty !== null;
  if (!complete && order.filledQty > read) {
    rows.push({
      id: 'earlier',
      at: order.createdAt,
      label: `${copy.orderTimelineEarlierHead} ${formatContracts(order.filledQty - read)} ${
        copy.orderTimelineEarlierTail
      }`,
    });
  }
  let filled = 0;
  for (const fill of [...fills].sort(byFillId)) {
    filled += fill.qty;
    const state = !named
      ? null
      : filled >= (order.qty ?? 0)
        ? copy.orderStatusFilled
        : copy.orderStatusPartiallyFilled;
    rows.push({ id: `fill-${fill.id}`, at: fill.createdAt, label: fillLine(fill, state) });
  }
  if (order.endedAt !== null && !(named && order.status === 'filled')) {
    rows.push({ id: 'ended', at: order.endedAt, label: stateWithReason(order) });
  }
  return rows;
}

/**
 * When the order and its fills disagree once every fill is read (two GETs, each re-read apart by
 * `user:position`): which to read again — the order when the fills add up to more (the order is
 * the older reading), the fills when to less. Null when they agree or the list is not all read.
 */
export function timelineStale(
  order: Pick<Order, 'filledQty' | 'status'>,
  fills: readonly Pick<MyFill, 'qty'>[],
  complete: boolean,
): 'order' | 'fills' | null {
  if (!complete || order.status === 'rejected') return null;
  const read = fills.reduce((sum, fill) => sum + fill.qty, 0);
  if (read === order.filledQty) return null;
  return read > order.filledQty ? 'order' : 'fills';
}

/** What a cancel's answer means for the screen (ADR-0141 결정 5). */
export type CancelOutcome =
  /** 200: the order in its final state — 취소 완료(본인 취소) when `own`, or the end it met first. */
  | { kind: 'done'; order: Order; own: boolean }
  /** 409 MARKET_NOT_OPEN: its market waits for a ledger recovery. */
  | { kind: 'held' }
  /** 404: no such order of this account's (any more). */
  | { kind: 'notFound' }
  /** 403 naming `expectedAccountId`: the cookie is another account's than the screen's. */
  | { kind: 'anotherAccount' }
  /** Any other 403 (a foreign Origin): an ordinary failure. */
  | { kind: 'forbidden' }
  /** 401: the session ended. */
  | { kind: 'signedOut' }
  /** The network, a 5xx or anything else: not known — the order is read again. */
  | { kind: 'unknown' };

/** The 판정표 of a cancel's answer: its order, or the error it failed with. */
export function cancelOutcomeOf(answer: { order: Order } | { error: unknown }): CancelOutcome {
  if ('order' in answer) {
    const { order } = answer;
    const own = order.status === 'cancelled' && order.cancelReason === 'by_owner';
    return { kind: 'done', order, own };
  }
  const { error } = answer;
  if (isApiError(error, 'MARKET_NOT_OPEN')) return { kind: 'held' };
  if (isApiError(error, 'NOT_FOUND')) return { kind: 'notFound' };
  if (isForAnotherAccount(error)) return { kind: 'anotherAccount' };
  if (isApiError(error, 'FORBIDDEN')) return { kind: 'forbidden' };
  if (isApiError(error, 'UNAUTHENTICATED')) return { kind: 'signedOut' };
  return { kind: 'unknown' };
}

/**
 * Whether a row or the detail says '취소 요청 중' (결정 4: a screen state, never 취소 완료): a cancel
 * of it is in flight and the order is still live. An order that ended meanwhile — filled first,
 * or the answer already written — shows its own state instead.
 */
export function showsCancelling(pending: boolean, order: { status: OrderStatus }): boolean {
  return pending && isLiveOrder(order);
}

/**
 * The order 주문 취소's confirmation draws (결정 4): the freshest reading the tab holds of
 * `orderId` — the list's row joined with the detail key's (`held`). A row that left the loaded
 * pages while the dialog was open (a newer order pushed it past them) leaves the row as it was
 * when the dialog opened (`opened`) in its place until the detail key answers.
 */
export function cancelTargetOrder(
  orderId: string | null,
  listed: Order | undefined,
  opened: Order | undefined,
  held: Order | undefined,
): Order | undefined {
  if (orderId === null) return undefined;
  const its = (order: Order | undefined) => (order?.id === orderId ? order : undefined);
  const drawn = its(listed) ?? its(opened);
  const fresh = its(held);
  if (drawn === undefined) return fresh;
  return fresh === undefined ? drawn : joinOrder(drawn, fresh);
}

/**
 * Where the focus goes once row `row` left a list (결정 4): the row now in its place, else the one
 * above it — null when no row is left (the list itself). Undefined when `row` was not drawn
 * before: nothing of this list held the focus.
 */
export function rowInPlaceOf(
  before: readonly string[],
  after: readonly string[],
  row: string,
): string | null | undefined {
  const at = before.indexOf(row);
  if (at < 0) return undefined;
  return after[Math.min(at, after.length - 1)] ?? null;
}

/** The live ids last seen, and whose (ADR-0141 결정 6). */
export interface LiveBaseline {
  accountId: string;
  ids: readonly string[];
}

/**
 * The orders that may have ended while watched: in the last live list seen and not in this one.
 * None without a baseline — the list's first read after the screen mounted makes it, so what
 * ended while the screen was away is not announced — and none when the account changed. A row
 * that only slid past the loaded pages (a new order above it) is a candidate too: the read back
 * tells.
 */
export function endedCandidates(
  prev: LiveBaseline | undefined,
  accountId: string,
  nextIds: readonly string[],
): string[] {
  if (prev === undefined || prev.accountId !== accountId) return [];
  const next = new Set(nextIds);
  return prev.ids.filter((id) => !next.has(id));
}

/**
 * Whether a list's or the detail's reading is one the screen watches from (결정 6): a read after it
 * mounted, or a fresh reading the cache held at mount, drawn as it was and not asked again (MY to
 * 대기 주문 inside the stale time) — what the reader saw. A held reading the mount reads again
 * (stale, or a read already on its way) is not: what ended while the screen was away is not told.
 */
export function watchedReading(query: {
  data: unknown;
  isFetchedAfterMount: boolean;
  isFetching: boolean;
  isStale: boolean;
}): boolean {
  return (
    query.isFetchedAfterMount || (query.data !== undefined && !query.isFetching && !query.isStale)
  );
}

/** The order ids each account was told of, kept for the tab's life (one notice per order). */
export type NoticeLog = Map<string, Set<string>>;

/**
 * Whether order `orderId` of `accountId` gets its notice now: the first of the two that learn it
 * ended — the cancel's answer or the read back of a row gone from the list — and only while
 * `accountId` is the account on screen (`shownAccountId`, `Me`'s id).
 */
export function noticeOnce(
  notified: NoticeLog,
  accountId: string,
  orderId: string,
  shownAccountId: string | undefined,
): boolean {
  if (shownAccountId !== accountId) return false;
  const seen = notified.get(accountId) ?? new Set<string>();
  if (seen.has(orderId)) return false;
  seen.add(orderId);
  notified.set(accountId, seen);
  return true;
}

/** The notice an ended order gets (결과 4 #123): one line, and a 본인 취소's quantities. */
export interface OrderNotice {
  title: string;
  description?: string;
}

/** '<시장> <계약> 주문 · <상태>(<사유>)'; '체결 n계약 · 취소 m계약' for a 본인 취소. */
export function endedNotice(order: Order): OrderNotice {
  const market = order.marketTitle ?? copy.postMarketNotPublic;
  const contract = contractSideLabel(order.outcome, order.side);
  const title = `${market} ${contract} ${copy.orderNoticeOrder} · ${stateWithReason(order)}`;
  if (order.status !== 'cancelled' || order.cancelReason !== 'by_owner') return { title };
  return {
    title,
    description: `${copy.orderNoticeFilled} ${formatContracts(order.filledQty)} · ${
      copy.orderNoticeCancelled
    } ${formatContracts(order.cancelledQty)}`,
  };
}

/** Several orders ended at once: '주문 n건이 끝났습니다. …', or with no count past what is read. */
export function endedManyText(count: number | null): string {
  return count === null
    ? copy.orderEndedSome
    : `${copy.orderEndedManyHead} ${String(count)}${copy.orderEndedManyTail}`;
}

/**
 * What an order's end moves besides the order (ADR-0141 결정 9; the bundle #66's `afterOrder`
 * calls, order-panel-provider.tsx): `['me']` alone (가용·주문 잠금 Coin), the market's 매도 가능액,
 * the holdings and every order list, that market's book, and 탈퇴's check of what still waits.
 * A buy's cancel publishes no `user:` event (ADR-0112 결정 8·10-10), so this is its one trigger.
 * Called from the cancel's mutation options — never a per-call callback, which an unmounted screen
 * would drop — and when a read back finds an order ended (§2-4). #66's and this one become one
 * after #66 merges.
 *
 * Restarted, not merely invalidated, like `afterOrder` (`restartQueries`): a FIRST read still in
 * flight left before the cancel committed, and an invalidation would only wait on it — its
 * pre-cancel answer landing as fresh (the row 대기 with 주문 취소 live on a list never read before,
 * 매도 가능 and 묶인 수량 from before a sell's cancel). The order join only guards a key that
 * already held the row. `['me']` always holds data, so its invalidation restarts a running read.
 */
export function refreshAfterOwnCancel(queryClient: QueryClient, marketId: string): void {
  void queryClient.invalidateQueries({ queryKey: ME_KEY, exact: true });
  void restartQueries(queryClient, marketSellableKey(marketId));
  void restartQueries(queryClient, POSITIONS_KEY);
  void restartQueries(queryClient, ORDERS_KEY);
  void restartQueries(queryClient, marketBookKey(marketId));
  void queryClient.invalidateQueries({ queryKey: ACCOUNT_CLOSURE_KEY });
}
