import {
  MARKET_STATUSES,
  type MarketStatus,
  type MarketStatusEvent,
  type MarketTickEvent,
  type Outcome,
  type UserBalanceEvent,
  type UserPositionEvent,
  supersedes,
} from '@buddha/shared';
import { type InfiniteData } from '@tanstack/react-query';
import { type MarketListItem, type Me, type Position } from './api';

/**
 * The reducers every realtime writer shares (PLAN 8, 11.5), in two contracts.
 *
 * `apply*` answers the next value, or `undefined` meaning DO NOT WRITE: `setQueryData`
 * returns early on an updater that answers `undefined`, so a late or duplicate event costs no
 * cache write, leaves `dataUpdatedAt` where it was and restarts no `staleTime`. Ordering is by
 * the event's own key through `supersedes` (@buddha/shared realtime.ts) — never by `ts`, which
 * two serialised writes can share to the millisecond.
 *
 * `join*` is total, monotone and order-independent, and is registered as `structuralSharing`
 * in query-client.ts. That makes EVERY writer safe rather than only the socket handler: a
 * window-focus or reconnect refetch that started before a trade and lands after it can no
 * longer roll the probability backwards, and neither can a second tab's answer.
 *
 * Nothing here touches React, the DOM or the clock, so all of it runs under the node test
 * runner; `Throttle` takes `now` as a parameter for the same reason.
 */

/**
 * The volatile subset of a market: what a trade moves, plus what a transition moves. `Market`
 * (the detail), `MarketSummary` and `MarketListItem` (a card) all satisfy it structurally, so
 * one reducer serves the detail cache and every filtered list page.
 */
export interface LiveMarket {
  id: string;
  status: MarketStatus;
  lastPrice: number;
  pYesBp: number;
  volumeP: string;
  tradeCount: number;
  traderCount: number;
  resolvedResult: Outcome | null;
}

/** One page of `GET /markets` as the list hook keeps it. */
export interface MarketPage {
  items: MarketListItem[];
  nextCursor: string | null;
}

/** The infinite list cache; the page param is the cursor, absent on the first page. */
export type MarketPages = InfiniteData<MarketPage, string | undefined>;

/**
 * The five fields a `market:tick` moves. `TradeResult.market` (`MarketStats`) carries exactly
 * the same set under `id`, so the trade answer and the socket event can share this reducer —
 * and therefore share one `supersedes` rule, which is what makes whichever arrives second a
 * no-op instead of a rollback (an `Idempotency-Key` replay publishes no event at all).
 */
export type MarketTickPatch = Pick<
  MarketTickEvent,
  'marketId' | 'pYesBp' | 'lastPrice' | 'volumeP' | 'tradeCount' | 'traderCount'
>;

/**
 * `market:status` carries no ordering key, so rank by index in `MARKET_STATUSES` (A-M3-19) —
 * the one order a REST snapshot can also be compared against, which no event id could be. A
 * total order only while no transition repeats a status: it holds through M3 (draft → open →
 * closed → resolving → settled, and voided from open/closed/resolving), and M5's
 * `result_changed` repeats `resolving`, which must add `market_events.id` to the event AND to
 * the market DTOs before it publishes. The transition table in market-live.test.ts turns red
 * on exactly that day.
 */
export const statusRank = (status: MarketStatus): number => MARKET_STATUSES.indexOf(status);

/** Only a list row carries a sparkline; the detail and the admin row do not. */
function hasSparkline(row: object): row is { sparkline: number[] } {
  return 'sparkline' in row && Array.isArray(row.sparkline);
}

/** Only the detail carries a dispute deadline; a card never gains one from an event. */
function hasDisputeUntil(row: object): row is { disputeUntil: string | null } {
  return 'disputeUntil' in row;
}

/**
 * A new probability REPLACES the newest sample instead of being pushed: the samples sit on a
 * fixed hourly grid (decision-sparkline), so pushing would slide that grid left on every trade
 * and the drawn shape would crawl. The grid itself only moves on the next fetch (A-M4-2).
 */
function withLatestSample(sparkline: number[], pYesBp: number): number[] {
  return sparkline.length === 0 ? [pYesBp] : [...sparkline.slice(0, -1), pYesBp];
}

/**
 * `market:tick` — ordered by `tradeCount`. It never CREATES an entry: the event names the
 * market as `marketId` where the DTO has `id`, and carries no slug, title, category, closeAt
 * or traderCount, so a synthesised row would be a lie the screen could not tell from a load.
 */
export function applyTick<T extends LiveMarket>(
  held: T | undefined,
  event: MarketTickPatch,
): T | undefined {
  if (held === undefined || held.id !== event.marketId) return undefined;
  if (!supersedes(event.tradeCount, held.tradeCount)) return undefined;
  const next = {
    ...held,
    pYesBp: event.pYesBp,
    lastPrice: event.lastPrice,
    volumeP: event.volumeP,
    tradeCount: event.tradeCount,
    traderCount: event.traderCount,
  };
  if (!hasSparkline(held)) return next;
  return { ...next, sparkline: withLatestSample(held.sparkline, event.pYesBp) };
}

/**
 * `market:status` — rank order. The result is REPLACED, not merged, so a void clears the
 * result an earlier resolve proposed; the dispute deadline follows it, and only on a row that
 * already has that field.
 */
export function applyStatus<T extends LiveMarket>(
  held: T | undefined,
  event: MarketStatusEvent,
): T | undefined {
  if (held === undefined || held.id !== event.marketId) return undefined;
  if (statusRank(event.status) <= statusRank(held.status)) return undefined;
  const next = { ...held, status: event.status, resolvedResult: event.resolvedResult ?? null };
  if (!hasDisputeUntil(held)) return next;
  return { ...next, disputeUntil: event.disputeUntil ?? null };
}

/**
 * The same patch inside every page of one filtered list. A page nothing moved in keeps its
 * reference, so only the changed card re-renders; `undefined` when the market is not in this
 * list at all, which is the common case for a tick that arrives while another filter is shown.
 */
export function applyToPages(
  held: MarketPages | undefined,
  patch: (row: MarketListItem) => MarketListItem | undefined,
): MarketPages | undefined {
  if (held === undefined) return undefined;
  let moved = false;
  const pages = held.pages.map((page) => {
    let pageMoved = false;
    const items = page.items.map((row) => {
      const next = patch(row);
      if (next === undefined) return row;
      pageMoved = true;
      return next;
    });
    if (!pageMoved) return page;
    moved = true;
    return { ...page, items };
  });
  return moved ? { ...held, pages } : undefined;
}

/**
 * Take the newer of two snapshots of the same market, per ordering group. Descriptive fields
 * (title, rules, closeAt, category) always come from `incoming`: only a REST answer has them,
 * and only a REST answer can change them. `traderCount` is NOT one of them — a trade moves it,
 * so it rides with the price under `tradeCount`, or an older snapshot would drag the
 * participant count back while the probability beside it stayed new. Monotone, idempotent and — apart
 * from a tie, where `incoming` wins because `supersedes` is strict — order-independent.
 */
export function joinMarket<T extends LiveMarket>(held: T | undefined, incoming: T): T {
  if (held === undefined || held.id !== incoming.id) return incoming;
  let next = incoming;
  if (supersedes(held.tradeCount, incoming.tradeCount)) {
    next = {
      ...next,
      pYesBp: held.pYesBp,
      lastPrice: held.lastPrice,
      volumeP: held.volumeP,
      tradeCount: held.tradeCount,
      // In the ORDERED group, not the descriptive one: it moves with the same trade, so a
      // snapshot older than what is held must not drag it back with the price.
      traderCount: held.traderCount,
    };
    // The card's line has to end where its badge says it does: the hourly grid still comes
    // from the newer fetch, only its newest sample follows the probability we kept.
    if (hasSparkline(next)) {
      next = { ...next, sparkline: withLatestSample(next.sparkline, held.pYesBp) };
    }
  }
  if (statusRank(held.status) > statusRank(incoming.status)) {
    next = { ...next, status: held.status, resolvedResult: held.resolvedResult };
    if (hasDisputeUntil(held)) next = { ...next, disputeUntil: held.disputeUntil };
  }
  return next;
}

/**
 * The list join. The page SHAPE comes from `incoming` — rows move between pages and the sort
 * order changes, so a held page is never a container to merge into — while each incoming row
 * is joined against the held row of the same id, looked up through one Map rather than a scan
 * per row. `replaceEqualDeep` around this (query-client.ts) hands untouched pages their old
 * reference back, so rebuilding every page here costs no re-render.
 */
export function joinMarketPages(held: MarketPages | undefined, incoming: MarketPages): MarketPages {
  if (held === undefined) return incoming;
  const heldById = new Map<string, MarketListItem>();
  for (const page of held.pages) {
    for (const row of page.items) heldById.set(row.id, row);
  }
  return {
    ...incoming,
    pages: incoming.pages.map((page) => ({
      ...page,
      items: page.items.map((row) => joinMarket(heldById.get(row.id), row)),
    })),
  };
}

/**
 * A position row is identified by the pair `(marketId, outcome)` and by nothing else — the API
 * holds one row per pair — so every writer here keys on the same string rather than restating
 * the pair as its own comparison.
 */
const positionRowKey = (row: Pick<Position, 'marketId' | 'outcome'>): string =>
  `${row.marketId}:${row.outcome}`;

/**
 * What a `user:position` event may do to the cached list. `refetch` is the answer for a row
 * the cache does not hold: the event carries no marketSlug, marketTitle, marketStatus or
 * marketLastPrice, so a full row cannot be built — asking the API beats inventing one that the
 * portfolio would then render.
 */
export type PositionPatch =
  { kind: 'none' } | { kind: 'replace'; positions: Position[] } | { kind: 'refetch' };

/**
 * `user:position` — ordered by the row's `version`, which the REST snapshot carries too, so a
 * snapshot seeds the comparison.
 *
 * A list that holds NOTHING answers `refetch`, not `none`. It used to answer `none`, reasoning
 * that "the next mount fetches the change anyway" — but the caller only ever asks about a query
 * the cache already HOLDS (the handler walks `findAll`, which visits no key a screen has not
 * asked for), so an empty one is not an absent screen. It is a screen whose FIRST
 * `GET /me/positions` is in flight right now, and that request left before the trade this event
 * announces: its answer is about to land and stand. The mount that was supposed to fix it is the
 * mount already doing the fetching.
 *
 * That is a different tab from the one that traded, which is why the trade path cannot cover it
 * — `applyTradeResult` runs only in the trading tab — and why the handler must CANCEL before it
 * invalidates (`restartQueries`, query-client.ts): an invalidation alone waits on the request
 * already running rather than issuing one that knows about the trade.
 */
export function applyPositionEvent(
  held: Position[] | undefined,
  event: UserPositionEvent,
): PositionPatch {
  if (held === undefined) return { kind: 'refetch' };
  const key = positionRowKey(event);
  const index = held.findIndex((row) => positionRowKey(row) === key);
  // `findIndex` answered -1 when the row is not cached, and reading it back is undefined.
  const current = held[index];
  if (current === undefined) return { kind: 'refetch' };
  if (!supersedes(event.version, current.version)) return { kind: 'none' };
  const positions = [...held];
  positions[index] = {
    ...current,
    qty: event.qty,
    costBasisP: event.costBasisP,
    realizedPnlP: event.realizedPnlP,
    settled: event.settled,
    version: event.version,
    // The publisher's `ts` is the transaction's own instant (trade.service.ts), so it is the
    // instant this row changed — the same thing `updatedAt` shows on the portfolio.
    updatedAt: event.ts,
  };
  return { kind: 'replace', positions };
}

/**
 * The positions list join — `joinMarket`'s counterpart for `['positions', status]`, registered
 * as that key's `structuralSharing` in query-client.ts.
 *
 * Without it the version order held ONLY between events: `applyPositionEvent` compares versions
 * because two deliveries of one write must not undo each other, but an HTTP answer went into
 * the cache raw. So a `GET /me/positions` that left before another tab's trade — a mount, a
 * window-focus refetch, the invalidation a `market:status` or a trade triggers — landed after
 * the `user:position` event and rolled qty, cost basis and version back to the pre-trade row.
 * On the market detail that is a stale 매도 ceiling (`heldQtyOf`), and nothing refetches again
 * to correct it.
 *
 * The LIST comes from `incoming` — rows move between the open and settled lists as markets
 * finish, and only a REST answer knows the membership — and so do the fields only it carries
 * (marketTitle, marketSlug, marketStatus, marketLastPrice, resolvedResult). Only the six fields
 * a `user:position` event writes are kept from the held row, and only while its `version` is
 * strictly newer. Monotone, idempotent and order-independent, exactly like `joinMarket`.
 *
 * It is account-BLIND — no key carries a user id (PLAN 11.5) and the pair above is all it
 * matches on — so it is correct only because `SessionCacheGuard` answers an account change with
 * `resetQueries()`, which puts every positions query back to `data === undefined` and makes the
 * next answer win whole. Weakening that guard to anything lazier would graft one account's qty
 * and version onto another's row.
 */
export function joinPositions(held: Position[] | undefined, incoming: Position[]): Position[] {
  if (held === undefined) return incoming;
  const heldByRow = new Map<string, Position>();
  for (const row of held) heldByRow.set(positionRowKey(row), row);
  return incoming.map((row) => {
    const current = heldByRow.get(positionRowKey(row));
    if (current === undefined || !supersedes(current.version, row.version)) return row;
    return {
      ...row,
      qty: current.qty,
      costBasisP: current.costBasisP,
      realizedPnlP: current.realizedPnlP,
      settled: current.settled,
      version: current.version,
      updatedAt: current.updatedAt,
    };
  });
}

/**
 * What a `user:balance` event may do to the cached `Me`. A KIND rather than a value, the shape
 * `applyPositionEvent` already answers in, because the two outcomes are not both cache writes.
 */
export type BalancePatch = { kind: 'replace'; me: Me } | { kind: 'refetch' };

/**
 * `user:balance` — never invents a `Me` for a visitor who is not signed in, and never leaves a
 * tab that is still loading one with nothing.
 *
 * `refetch` is the answer for a cache that holds no `Me`. It cannot be `none`: the caller
 * CANCELS the in-flight `GET /me` before writing (that is how a snapshot served before this
 * event is kept from landing on top of it), and a cancel reverts the query to the state it
 * held before the fetch — for a first load, `pending` with no data and nothing left to restart
 * it. Answering `none` there stranded the balance chip and the 잔고 요약 on a skeleton until
 * the next window focus, on every refund, payout or other-tab trade that arrived while the
 * profile was still loading. The event's own numbers cannot fill that gap either: `Me` carries
 * the profile and the linked login methods too, so there is no `Me` to build from it.
 */
export function applyBalanceEvent(held: Me | undefined, event: UserBalanceEvent): BalancePatch {
  if (held === undefined) return { kind: 'refetch' };
  return {
    kind: 'replace',
    me: { ...held, balance: { availableP: event.availableP, lockedP: event.lockedP } },
  };
}

/**
 * REST `Balance` is `{ availableP, lockedP }` with no `ledgerEntryId` (wallet.ts), so unlike
 * tradeCount and version the key cannot be seeded from a snapshot — Q-M3-8(2), still open.
 * This therefore orders `user:balance` events AGAINST EACH OTHER only, per tab: a duplicate or
 * a late delivery is dropped, while a `GET /me` answer is a queryFn result and always wins the
 * write (the socket handler narrows that race with `cancelQueries` instead). Reset it on
 * reconnect and whenever the socket is rebuilt for a new session identity, because the events
 * it has seen belong to the connection that delivered them.
 */
export class BalanceOrder {
  private last: string | null = null;

  reset(): void {
    this.last = null;
  }

  accept(event: UserBalanceEvent): boolean {
    if (!supersedes(event.ledgerEntryId, this.last)) return false;
    this.last = event.ledgerEntryId;
    return true;
  }
}

/**
 * At most one action per key per window, used to bound the `market:trade` → fills
 * invalidation: a busy market can publish a fill per trade, and each one would otherwise cost
 * a request. `now` is a parameter so the caller owns the clock and the tests need no timers.
 */
export class Throttle {
  private readonly last = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  take(key: string, now: number): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }

  /**
   * How long `key` still has to wait, 0 once its window has passed. Paired with a refused
   * `take` this is what lets a caller give itself a TRAILING edge — sleep exactly this long,
   * then take again — instead of dropping the action: a leading-edge-only throttle loses the
   * last event of a burst, and `['market-fills', id]` has no other writer for somebody else's
   * trade, so a lost one stays missing. Reading the window rather than owning a timer keeps
   * this class clock-free and testable under the node runner.
   */
  retryDelay(key: string, now: number): number {
    const previous = this.last.get(key);
    if (previous === undefined) return 0;
    return Math.max(0, this.windowMs - (now - previous));
  }
}

/**
 * `ids` in slices of at most `size`, in order; empty in, empty out.
 *
 * The realtime protocol caps a `subscribe`/`unsubscribe` MESSAGE at `REALTIME_SUBSCRIBE_MAX`
 * ids while a socket may HOLD `REALTIME_ROOMS_MAX` of them (@buddha/shared realtime.ts), and
 * the gateway refuses an over-long message whole — it joins no room at all and answers on
 * `exception`. A client that wants the bigger number therefore has to send the smaller one
 * repeatedly, which the home grid needs after five 더 보기 (PAGE_LIMIT_DEFAULT 20) and
 * /portfolio needs for an account holding more than 100 markets, `GET /me/positions` having
 * no pagination. Pure and here rather than inside the room registry so the boundary is
 * testable without a socket.
 *
 * `size` is floored at 1 because a non-positive one would never advance the cursor: an
 * infinite loop in the tab is a worse answer than one id per message.
 */
export function chunkIds(ids: readonly string[], size: number): string[][] {
  const step = Math.max(1, size);
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += step) {
    chunks.push(ids.slice(start, start + step));
  }
  return chunks;
}
