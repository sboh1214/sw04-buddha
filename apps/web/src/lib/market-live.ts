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
  'marketId' | 'pYesBp' | 'lastPrice' | 'volumeP' | 'tradeCount'
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
 * (title, rules, closeAt, traderCount, category) always come from `incoming`: only a REST
 * answer has them, and only a REST answer can change them. Monotone, idempotent and — apart
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
 * What a `user:position` event may do to the cached list. `refetch` is the answer for a row
 * the cache does not hold: the event carries no marketSlug, marketTitle, marketStatus or
 * marketLastPrice, so a full row cannot be built — asking the API beats inventing one that the
 * portfolio would then render.
 */
export type PositionPatch =
  { kind: 'none' } | { kind: 'replace'; positions: Position[] } | { kind: 'refetch' };

/**
 * `user:position` — ordered by the row's `version`, which the REST snapshot carries too, so a
 * snapshot seeds the comparison. Nothing cached means nothing to correct: the next mount
 * fetches the change anyway, so an event for an empty cache is a no-op rather than a refetch.
 */
export function applyPositionEvent(
  held: Position[] | undefined,
  event: UserPositionEvent,
): PositionPatch {
  if (held === undefined) return { kind: 'none' };
  const index = held.findIndex(
    (row) => row.marketId === event.marketId && row.outcome === event.outcome,
  );
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

/** `user:balance` — never invents a `Me` for a visitor who is not signed in. */
export function applyBalance(held: Me | undefined, event: UserBalanceEvent): Me | undefined {
  if (held === undefined) return undefined;
  return { ...held, balance: { availableP: event.availableP, lockedP: event.lockedP } };
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
