import {
  type MarketStatus,
  type MarketStatusEvent,
  type MarketTickEvent,
  type PositionStatus,
  type Outcome,
  type UserBalanceEvent,
  type UserPositionEvent,
  statusSupersedes,
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
  /** The last fill's price, 1..99, or `null` before the first fill (N02 §5's 체결 없음). */
  lastPrice: number | null;
  volumeCoin: string;
  tradeCount: number;
  traderCount: number;
  resolvedResult: Outcome | null;
  /**
   * The `market_events.id` of the transition that produced `status` — the ordering key of
   * `market:status` (A-M3-19, Q-M3-8(3), M5). Null only for a row written outside the
   * transition paths (a test factory), which falls back to rank in `statusSupersedes`.
   */
  statusEventId: string | null;
}

/** One page of `GET /markets` as the list hook keeps it. */
export interface MarketPage {
  items: MarketListItem[];
  nextCursor: string | null;
}

/** The infinite list cache; the page param is the cursor, absent on the first page. */
export type MarketPages = InfiniteData<MarketPage, string | undefined>;

/**
 * The four fields a `market:tick` moves, under the market's id. Nothing publishes the event
 * until the CLOB fills (#119); the reducers keep reading it so a fill arrives already wired.
 */
export type MarketTickPatch = Pick<
  MarketTickEvent,
  'marketId' | 'lastPrice' | 'volumeCoin' | 'tradeCount' | 'traderCount'
>;

/**
 * The status ORDER, in two forms.
 *
 * `statusSupersedes` (@buddha/shared realtime.ts) is what every writer of a market ROW compares
 * on since M5: `market:status` carries `statusEventId` — the `market_events.id` of the
 * transition, drawn under the market row lock — and every market DTO carries the same key, so a
 * REST snapshot seeds the comparison the way `tradeCount` does for a tick. That is what keeps
 * the deliberate repeat an admin edit publishes (A-M4-36) a drop — same id, not newer — so only
 * the REST answer that repeat triggers carries the edit; and it is what leaves `settled` on screen
 * when the API's `resolved` and the worker's `settled`, published moments apart (ADR-0046),
 * arrive in the other order.
 *
 * `statusRank` — position in `MARKET_STATUSES` — is re-exported for the one reader that holds NO
 * key: a position row (`liveMarketStatus`, use-portfolio.ts). `Position.marketStatus` is a join
 * with no event id beside it, and rank is the one order such a row can still join. It is the
 * FALLBACK inside `statusSupersedes` for the same reason, taken only when a side has no key.
 */
export { statusRank } from '@buddha/shared';

/** Only a list row carries a sparkline; the detail and the admin row do not. */
function hasSparkline(row: object): row is { sparkline: number[] } {
  return 'sparkline' in row && Array.isArray(row.sparkline);
}

/**
 * A new price REPLACES the newest sample instead of being pushed: the samples sit on a fixed
 * hourly grid (decision-sparkline), so pushing would slide that grid left on every trade and
 * the drawn shape would crawl. The grid itself only moves on the next fetch (A-M4-2). The
 * samples are tick basis points and a fill's price is a whole percent, hence the ×100; with no
 * fill there is no price to sample, and the line stays as fetched.
 */
function withLatestSample(sparkline: number[], lastPrice: number | null): number[] {
  if (lastPrice === null) return sparkline;
  const bp = lastPrice * 100;
  return sparkline.length === 0 ? [bp] : [...sparkline.slice(0, -1), bp];
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
    lastPrice: event.lastPrice,
    volumeCoin: event.volumeCoin,
    tradeCount: event.tradeCount,
    traderCount: event.traderCount,
  };
  if (!hasSparkline(held)) return next;
  return { ...next, sparkline: withLatestSample(held.sparkline, event.lastPrice) };
}

/**
 * Whether a `market:tick` may become a REQUEST for `['market', id]` — the whole of that decision,
 * so the handler holds none of it.
 *
 * Not the only place this app answers an event by asking, which an earlier draft of this line
 * claimed: `realtime-provider.tsx` states the rule and enumerates all of them. This is the
 * strictest of them, because a tick arrives many times a second while the others are rare.
 *
 * THE HAZARD: /portfolio opens one UNSEEDED `['market', id]` per held market (`useQueries`,
 * portfolio.tsx) and `useMarketSocket` has already joined every one of those rooms, so a tick can
 * arrive while the opening GET is on the wire. `applyTick` above answers `undefined` for a cache
 * with no row — it will not invent one — and the request, whose snapshot predates the trade, then
 * lands with the old price and STANDS: `staleTime` is 30s, the next tick on a quiet market may be
 * an hour away, and `markToLiveMarket` (use-portfolio.ts) gives that row precedence, so 현재가 ·
 * 평가 금액 · 총 평가 금액 are all marked to a price the market has left. The detail screen never
 * meets this, because `seedMarketDetail` fills the entry before the client renders.
 *
 * Four tests, each refusing a different way of turning an event into a request (PLAN 11.5's
 * "refetch 남발 금지"):
 *
 *  - the entry EXISTS: the home grid joins every card's room while keeping no `['market', id]`
 *    entry at all — it reads `['markets', filters]` — so without this every tick on the grid
 *    would invalidate a key nothing holds.
 *  - it holds NO data: `applyTick` answers `undefined` for TWO reasons and only "no row" may
 *    become a request. Restarting on "not superseded" would buy one per late or duplicate tick.
 *  - it is FETCHING: an ERRORED query holds no data either, and restarting it per tick would
 *    fight both the retry rule and the error UI. The hazard is an answer ON THE WIRE.
 *  - the WINDOW is free, and this bound is on the FIX rather than on the bug. The three tests
 *    above stay true for as long as the row is absent, and `restartQueries` CANCELS the request
 *    in flight — so a market ticking faster than its own request answers restarts it once per
 *    tick and never settles. Measured: ten ticks cost eleven requests unthrottled, two throttled.
 *
 * `throttle.take` is deliberately LAST: it is a short circuit, so a tick the cache could apply
 * never spends a market's window and cannot block a real race a moment later.
 */
export function tickRestartsMarket(
  state: { data: unknown; fetchStatus: string } | undefined,
  throttle: Throttle,
  marketId: string,
  now: number,
): boolean {
  if (state === undefined) return false;
  if (state.data !== undefined) return false;
  if (state.fetchStatus !== 'fetching') return false;
  return throttle.take(marketId, now);
}

/**
 * `market:status` — ordered by `statusEventId` through `statusSupersedes`, rank as the fallback
 * for a side with no key. The result is REPLACED, not merged, so the 판정 writes it and a later
 * event never keeps a result its own transition did not carry. The key is written with the
 * status, so the next event and the next REST answer are both compared against the transition
 * this one delivered.
 *
 * `undefined` for an event that is not NEWER covers two senders: a late or duplicate
 * transition, and the deliberate repeat an admin edit publishes (A-M4-36) — the same id the row
 * already holds. Both must write nothing — the event carries no `closeAt`, `title` or `rules`,
 * so applying it could only restate what is held; the refetch the handler fires beside it is
 * what delivers the edit.
 */
export function applyStatus<T extends LiveMarket>(
  held: T | undefined,
  event: MarketStatusEvent,
): T | undefined {
  if (held === undefined || held.id !== event.marketId) return undefined;
  if (!statusSupersedes(event, held)) return undefined;
  return {
    ...held,
    status: event.status,
    resolvedResult: event.resolvedResult ?? null,
    statusEventId: event.statusEventId,
  };
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
      lastPrice: held.lastPrice,
      volumeCoin: held.volumeCoin,
      tradeCount: held.tradeCount,
      // In the ORDERED group, not the descriptive one: it moves with the same trade, so a
      // snapshot older than what is held must not drag it back with the price.
      traderCount: held.traderCount,
    };
    // The card's line has to end where its pill says it does: the hourly grid still comes
    // from the newer fetch, only its newest sample follows the price we kept.
    if (hasSparkline(next)) {
      next = { ...next, sparkline: withLatestSample(next.sparkline, held.lastPrice) };
    }
  }
  // The status GROUP moves together: the result was written by the same transition as the
  // status and its key, so a snapshot older than what is held must not drag either back alone —
  // a `settled` kept by status but joined with a pre-판정 snapshot's null result would badge
  // 정산 완료 over no answer at all.
  if (statusSupersedes(held, incoming)) {
    next = {
      ...next,
      status: held.status,
      resolvedResult: held.resolvedResult,
      statusEventId: held.statusEventId,
    };
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
 * That is why the handler must CANCEL before it invalidates (`restartQueries`,
 * query-client.ts): an invalidation alone waits on the request already running rather than
 * issuing one that knows about the change.
 *
 * A row whose `settled` flag MOVED answers `refetch` for the same reason, and it is the second
 * thing this reducer refuses to invent. See the comment on that branch.
 *
 * `listStatus` — which of the two lists is being asked about — is what lets it tell an absence
 * that is a GAP from one that is the list's own definition. Optional: an unsuffixed
 * `['positions']` root would answer `undefined` and keep the old, safe reading.
 */
export function applyPositionEvent(
  held: Position[] | undefined,
  event: UserPositionEvent,
  listStatus?: PositionStatus,
): PositionPatch {
  // An UNSETTLED event says nothing about the settled list, and skipping it here is what stops a
  // storm. `refetch` is this reducer's answer for a row the cache does not hold, and on
  // /portfolio — where both lists are mounted — the settled list holds no unsettled row BY
  // DEFINITION, so every ordinary trade reported an expected absence as a gap and the handler
  // restarted the whole `['positions']` root. Measured: five of the account's own trades cost ten
  // requests, and the open list had already been patched in place for each of them.
  //
  // Sound because settlement is TERMINAL: `settled: true` is written by the settle path (the
  // worker's finalize) and `settled: false` only ever by the INSERT of a brand-new row on a fill
  // — never by an update. So a row this event describes as unsettled was never
  // in the settled list and cannot have left it, and there is nothing for that list to re-ask.
  //
  // Deliberately NOT the general form "ignore any list the event does not belong to". A SETTLED
  // event must still restart the OPEN list even when that list holds no such row, because its
  // first fetch may be in flight and about to land with the row still unsettled — which is the
  // membership guard below, seen from the other side.
  if (listStatus === 'settled' && !event.settled) return { kind: 'none' };
  if (held === undefined) return { kind: 'refetch' };
  const key = positionRowKey(event);
  const index = held.findIndex((row) => positionRowKey(row) === key);
  // `findIndex` answered -1 when the row is not cached, and reading it back is undefined.
  const current = held[index];
  if (current === undefined) return { kind: 'refetch' };
  if (!supersedes(event.version, current.version)) return { kind: 'none' };
  // A change of the `settled` flag is a change of MEMBERSHIP, not of a field: the flag is what
  // `GET /me/positions?status=` filters on, so the row this event describes has LEFT the list
  // being patched and joined the other one. Writing it back in place is what
  // `realizedPnlAcross` (use-portfolio.ts) documents as impossible — "a row MOVES between the
  // two lists … so it is never in both and this cannot double count" — and the double count is
  // exactly what it produced: a finished holding stayed in `['positions', 'open']` carrying its
  // realised PnL while 정산 이력 fetched the same row, and 총 실현 손익 printed the sum of one
  // row with itself. The write also refreshed `dataUpdatedAt`, so the poisoned list was inside
  // `staleTime` and the next mount did not correct it.
  //
  // `refetch` for the same reason an absent row takes it: the event cannot BUILD the row in its
  // new list. It carries no `resolvedResult` and no `marketStatus` (realtime.ts), so a client
  // that moved the row itself would draw 정산 이력 with 결과 — for a market that resolved 예.
  // Membership is the REST answer's, which is the rule `joinPositions` states from the other
  // side ("the LIST comes from `incoming`") and `liveMarketStatus` (use-portfolio.ts) states
  // from the third: a terminal transition is not an event's to apply.
  if (event.settled !== current.settled) return { kind: 'refetch' };
  const positions = [...held];
  positions[index] = {
    ...current,
    qty: event.qty,
    costBasisCoin: event.costBasisCoin,
    realizedPnlCoin: event.realizedPnlCoin,
    settled: event.settled,
    version: event.version,
    // The publisher's `ts` is the transaction's own instant, so it is the instant this row
    // changed — the same thing `updatedAt` shows on the portfolio.
    updatedAt: event.ts,
  };
  return { kind: 'replace', positions };
}

/**
 * Whether this event announces an order row that 주문 이력 does not hold yet.
 *
 * A fill writes one (the order and its fill commit together), and no `user:` event carries an
 * `Order`'s id, status, filledQty, amountCoin or priceAvgBp — so the list cannot be built from the
 * event and has to be asked for. A settlement writes NO order row at all (it moves positions and
 * balances only), so a refetch there could answer nothing the list does not already hold.
 *
 * The same rule `liveMarketStatus` (use-portfolio.ts) states from the other side: a terminal
 * transition is the REST answer's business. Exported apart from the socket handler because a
 * decision left inside an effect body is a decision this app's node-only vitest cannot reach.
 */
export function wroteAnOrder(event: UserPositionEvent): boolean {
  return !event.settled;
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
 * On the market detail that is a stale 내 포지션, and nothing refetches again to correct it.
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
      costBasisCoin: current.costBasisCoin,
      realizedPnlCoin: current.realizedPnlCoin,
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
    me: { ...held, balance: { availableCoin: event.availableCoin, lockedCoin: event.lockedCoin } },
  };
}

/**
 * REST `Balance` is `{ availableCoin, lockedCoin }` with no `ledgerEntryId` (wallet.ts), so unlike
 * tradeCount and version the key cannot be seeded from a snapshot — Q-M3-8(2), still open.
 * This therefore orders `user:balance` events AGAINST EACH OTHER only, per tab: a duplicate or
 * a late delivery is dropped, while a `GET /me` answer is a queryFn result and always wins the
 * write (the socket handler narrows that race with `cancelQueries` instead).
 *
 * There is deliberately NO `reset()`, and the absence is the guard. It used to have one, called
 * from `resnapshot()` on every reconnect and every `realtime:resync`, on the reading that "the
 * events it has seen belong to the connection that delivered them". That reading was wrong:
 * `ledger_entries.id` is a bigserial drawn while the ACCOUNT's balance row is held FOR UPDATE
 * (wallet.service.ts and the admin and settle paths all lock before they insert), so it is that account's commit order and has nothing to do with which socket carried
 * it. Clearing it discarded a bound that was still true and re-opened the one window this class
 * cannot order — its FIRST event, which `supersedes(x, null)` takes whatever it says — on every
 * reconnect. A new tab or a new identity still starts clean, because the provider builds a fresh
 * one; nothing else may.
 */
export class BalanceOrder {
  private last: string | null = null;

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
