import {
  type MarketResult,
  type MarketStatus,
  type MarketStatusEvent,
  type MarketTickEvent,
  type MarketStatsEvent,
  type PositionStatus,
  type UserBalanceEvent,
  type UserPositionEvent,
  isPublicMarketStatus,
  statusSupersedes,
  supersedes,
} from '@buddha/shared';
import {
  type InfiniteData,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  type Market,
  type MarketJudgementDelay,
  type MarketSummary,
  type Me,
  type Order,
  type Position,
} from './api';
import {
  MY_ORDERS_LIVE_KEY,
  MY_ORDER_DETAIL_KEY,
  MY_ORDER_HISTORY_KEY,
  SETTLEMENTS_KEY,
  marketBookKey,
  myOrderKey,
  sellableKey,
} from './market-keys';

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
 * (the detail) and `MarketSummary` (a card) both satisfy it structurally, so one reducer serves
 * the detail cache and every filtered list page.
 */
export interface LiveMarket {
  id: string;
  status: MarketStatus;
  /** The last fill's price, 1..99, or `null` before the first fill (N02 §5's 체결 없음). */
  lastPrice: number | null;
  /**
   * That fill's server time (#121, ADR-0116: the 시장가격's 갱신시각; the card draws it as '최근
   * 체결 <시각>' since #61, ADR-0136, and the detail header's is #64's), `null` exactly when
   * `lastPrice` is. It moves with the price under `tradeCount`.
   */
  lastFillAt: string | null;
  volumeCoin: string;
  tradeCount: number;
  traderCount: number;
  statsRevision: string;
  /** The result type (YES·NO·VOID, #174), or `null` before a judgement and on a cancelled market. */
  resolvedResult: MarketResult | null;
  /**
   * The `market_events.id` of the transition that produced `status` — the ordering key of
   * `market:status` (A-M3-19, Q-M3-8(3), M5). Null only for a row written outside the
   * transition paths (a test factory), which falls back to rank in `statusSupersedes`.
   */
  statusEventId: string | null;
  /**
   * The status displays the server computed for `status` at the read (ADR-0098, ADR-0104):
   * '판정 지연' (`judgementDelayed`), '이의 검토 중' (`disputeUnderReview`) and whether 판정 이의 are
   * taken (`disputeOpen`, the detail's submission link). Each holds for the status it was read
   * with only, so a status the row did not read them with carries them false (`applyStatus`), and
   * they move with the status group (`joinMarket`).
   */
  judgementDelayed: boolean;
  disputeUnderReview: boolean;
  disputeOpen: boolean;
  /**
   * The judgement version on view and its 이의 기한 (#152, #175): written by the same transition
   * as the status (`provisional`), so they move with the status group too (`joinMarket`).
   */
  judgementVersion: number | null;
  disputeDeadline: string | null;
  /**
   * The detail's 판정 지연 기록 (#142, ADR-0106: `Market.judgementDelay` — no card carries it, so
   * optional here): the current record's reason and next review time, read with the status like
   * the flags above — null unless the read found the market '판정 지연' — so it is reset with them
   * (`applyStatus`) and moves with the status group (`joinMarket`).
   */
  judgementDelay?: MarketJudgementDelay | null;
  /** Public history and completion instants are read with the same status snapshot (#24). */
  judgingRecord?: Market['judgingRecord'];
  /** Client-only: the held history predates a status event and must not read as current. */
  judgingRecordStale?: boolean;
  resolvedAt?: string | null;
  settledAt?: string | null;
}

/**
 * The display flags a status of its own read sets: none, for a status the row moved to by an
 * event (`applyStatus`) — the REST refetch the event fires beside it fills them in.
 */
const NO_STATUS_DISPLAY = {
  judgementDelayed: false,
  disputeUnderReview: false,
  disputeOpen: false,
} as const satisfies Pick<LiveMarket, 'judgementDelayed' | 'disputeUnderReview' | 'disputeOpen'>;

/** One page of `GET /markets` as the list hook keeps it. */
export interface MarketPage {
  items: MarketSummary[];
  nextCursor: string | null;
}

/** The infinite list cache; the page param is the cursor, absent on the first page. */
export type MarketPages = InfiniteData<MarketPage, string | undefined>;

/**
 * The fields a `market:tick` moves, under the market's id. The order intake publishes one after
 * the COMMIT of every intake that filled anything (#121, ADR-0116), with the values the intake
 * wrote; its `ts` is the last fill's server time, which becomes the row's `lastFillAt`.
 */
export type MarketTickPatch = Pick<
  MarketTickEvent,
  'marketId' | 'lastPrice' | 'volumeCoin' | 'tradeCount' | 'traderCount' | 'statsRevision' | 'ts'
>;

/**
 * The status ORDER, in two forms.
 *
 * `statusSupersedes` (@buddha/shared realtime.ts) is what every writer of a market ROW compares
 * on since M5: `market:status` carries `statusEventId` — the `market_events.id` of the
 * transition, drawn under the market row lock — and every market DTO carries the same key, so a
 * REST snapshot seeds the comparison the way `tradeCount` does for a tick. That is what keeps
 * the deliberate repeat an admin edit publishes (A-M4-36) a drop — same id, not newer — so only
 * the REST answer that repeat triggers carries the edit; it is what leaves `settled` on screen
 * when the worker's `settling` and `settled`, published moments apart (ADR-0046, #174), arrive in
 * the other order; and it is what lets PAUSED → OPEN through (#174), which goes back in rank.
 *
 * `statusRank` — position in `MARKET_STATUSES` — is re-exported for the one reader that holds NO
 * key: a position row (`liveMarketStatus`, use-portfolio.ts, which gives `paused` the step of
 * `open`). `Position.marketStatus` is a join with no event id beside it, and rank is the one order
 * such a row can still join. It is the FALLBACK inside `statusSupersedes` for the same reason,
 * taken only when a side has no key.
 */
export { statusRank } from '@buddha/shared';

/**
 * `market:tick` — ordered by `tradeCount`. It never CREATES an entry: the event names the
 * market as `marketId` where the DTO has `id`, and carries no slug, title, category or closeAt,
 * so a synthesised row would be a lie the screen could not tell from a load. `traderCount` does
 * ride with the price: the tick carries it under the same `tradeCount`, and the card and the
 * detail header show it. So does `lastFillAt`, from the tick's `ts` (#121).
 */
export function applyTick<T extends LiveMarket>(
  held: T | undefined,
  event: MarketTickPatch,
): T | undefined {
  if (held === undefined || held.id !== event.marketId) return undefined;
  const priceNewer = supersedes(event.tradeCount, held.tradeCount);
  const statsNewer = supersedes(event.statsRevision, held.statsRevision);
  if (!priceNewer && !statsNewer) return undefined;
  return {
    ...held,
    ...(priceNewer
      ? {
          lastPrice: event.lastPrice,
          lastFillAt: event.ts,
          volumeCoin: event.volumeCoin,
          tradeCount: event.tradeCount,
        }
      : {}),
    ...(statsNewer ? { traderCount: event.traderCount, statsRevision: event.statsRevision } : {}),
  };
}

/**
 * Whether a `market:tick` may become a REQUEST for `['market', id]` — the whole of that decision,
 * so the handler holds none of it.
 *
 * Not the only place this app answers an event by asking, which an earlier draft of this line
 * claimed: `realtime-provider.tsx` states the rule and enumerates all of them. This is the
 * strictest of them, because a tick arrives many times a second while the others are rare.
 *
 * THE HAZARD: MY opens one UNSEEDED `['market', id]` per held market (`useQueries`,
 * app/my/portfolio.tsx) and `useMarketSocket` has already joined every one of those rooms, so a
 * tick can arrive while the opening GET is on the wire. `applyTick` above answers `undefined` for a cache
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
 * for a side with no key. The result is REPLACED, not merged, so a judgement's approval writes it
 * (잠정 결과, #152) and a later event never keeps a result its own transition did not carry. The
 * key is written with the status, so the next event and the next REST answer are both compared
 * against the transition this one delivered.
 *
 * The display flags are RESET (`NO_STATUS_DISPLAY`, #175, ADR-0104): `judgementDelayed`,
 * `disputeUnderReview` and `disputeOpen` were read for the old status — a CLOSED market's delay,
 * a PROVISIONAL one's hold or open deadline — and none of them may label the status the event
 * brings (ADR-0098 8-11's reason, now that PROVISIONAL reads flags too). So is the detail's 판정
 * 지연 기록 (#142, ADR-0106), where the row carries one: a CLOSED market's record must not stand on
 * the 잠정 결과 the approval brings. The REST refetch the handler fires beside the event
 * (realtime-provider.tsx) fills them in for the new status.
 *
 * `undefined` for an event that is not NEWER covers two senders: a late or duplicate
 * transition, and the deliberate repeat an admin edit publishes (A-M4-36) — the same id the row
 * already holds. Both must write nothing — the event carries no `closeAt`, `title` or rule item
 * (#23), so applying it could only restate what is held; the refetch the handler fires beside it
 * is what delivers the edit.
 *
 * Nor does a status no member sees (#78, ADR-0099): a scheduled market sent back to a draft
 * publishes `draft`, and the card or the detail would otherwise call it 초안 — an admin's label —
 * on a member's screen. The row stays as it was; the handler's refetch beside it answers NOT_FOUND,
 * which the detail says (`marketRefreshNotice`), and a list drops it at its next read.
 */
export function applyStatus<T extends LiveMarket>(
  held: T | undefined,
  event: MarketStatusEvent,
): T | undefined {
  if (held === undefined || held.id !== event.marketId) return undefined;
  if (!isPublicMarketStatus(event.status)) return undefined;
  if (!statusSupersedes(event, held)) return undefined;
  return {
    ...held,
    status: event.status,
    resolvedResult: event.resolvedResult ?? null,
    statusEventId: event.statusEventId,
    ...NO_STATUS_DISPLAY,
    // A card has none to reset, and gains none.
    ...(held.judgementDelay === undefined ? {} : { judgementDelay: null }),
    ...(held.judgingRecord === undefined
      ? {}
      : {
          judgingRecordStale: true,
          judgingRecord: {
            ...held.judgingRecord,
            // Keep recorded history, but an old status's current flags cannot describe this event.
            payoutDelayed: false,
            delays: held.judgingRecord.delays.map((delay) => ({ ...delay, current: false })),
          },
        }),
  };
}

/**
 * The same patch inside every page of one filtered list. A page nothing moved in keeps its
 * reference, so only the changed card re-renders; `undefined` when the market is not in this
 * list at all, which is the common case for a tick that arrives while another filter is shown.
 */
export function applyToPages(
  held: MarketPages | undefined,
  patch: (row: MarketSummary) => MarketSummary | undefined,
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
 * (title, the rule items of #23, closeAt, category) always come from `incoming`: only a REST
 * answer has them, and only a REST answer can change them. `traderCount` is NOT one of them — a
 * trade moves it, so it rides with the price under `tradeCount`, or an older snapshot would drag
 * the participant count back while the probability beside it stayed new. Monotone, idempotent
 * and — apart from a tie, where `incoming` wins because `supersedes` is strict — order-independent.
 */
export function joinMarket<T extends LiveMarket>(held: T | undefined, incoming: T): T {
  if (held === undefined || held.id !== incoming.id) return incoming;
  let next = incoming;
  if (supersedes(held.tradeCount, incoming.tradeCount)) {
    next = {
      ...next,
      lastPrice: held.lastPrice,
      lastFillAt: held.lastFillAt,
      volumeCoin: held.volumeCoin,
      tradeCount: held.tradeCount,
    };
  }
  if (supersedes(held.statsRevision, incoming.statsRevision)) {
    next = { ...next, traderCount: held.traderCount, statsRevision: held.statsRevision };
  }
  // The status GROUP moves together: the result was written by the same transition as the
  // status and its key, so a snapshot older than what is held must not drag either back alone —
  // a `settled` kept by status but joined with a pre-판정 snapshot's null result would badge
  // 지급 완료 over no answer at all. The display flags ride with it (#175, ADR-0104): an older
  // snapshot's were read for its own status — a CLOSED market's '판정 지연' joined to the 잠정 결과
  // held would read 판정 지연 on PROVISIONAL, which a held market past its deadline now means. So
  // do the version and the 이의 기한: a pre-판정 snapshot's nulls would take the detail's deadline
  // row and link away, and hold the dispute screen on its skeleton, while `disputeOpen` says open.
  // The detail's 판정 지연 기록 rides with them too (#142, ADR-0106): read with the status, an older
  // snapshot's CLOSED-era record joined to the held 잠정 결과 would stand under its 판정 지연. A tie
  // — a record's own `market:status` repeat (A-M4-36) keeps the key — lets `incoming` bring it.
  if (statusSupersedes(held, incoming)) {
    next = {
      ...next,
      status: held.status,
      resolvedResult: held.resolvedResult,
      statusEventId: held.statusEventId,
      judgementDelayed: held.judgementDelayed,
      disputeUnderReview: held.disputeUnderReview,
      disputeOpen: held.disputeOpen,
      judgementVersion: held.judgementVersion,
      disputeDeadline: held.disputeDeadline,
      ...(held.judgementDelay === undefined ? {} : { judgementDelay: held.judgementDelay }),
      ...(held.judgingRecord === undefined
        ? {}
        : {
            judgingRecord: held.judgingRecord,
            // Older REST cannot freshen history from before this status. On a tie/newer
            // snapshot, incoming wins above: REST has no client-only marker, clearing it.
            judgingRecordStale: held.judgingRecordStale,
          }),
      ...(held.resolvedAt === undefined ? {} : { resolvedAt: held.resolvedAt }),
      ...(held.settledAt === undefined ? {} : { settledAt: held.settledAt }),
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
  const heldById = new Map<string, MarketSummary>();
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
 * marketLastPrice, so a full row cannot be built — asking the API beats inventing one that MY
 * would then render.
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
  // MY's summary — where both lists are mounted — the settled list holds no unsettled row BY
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
  // that moved the row itself would draw 정산 이력 with 결과 — for a market that resolved YES.
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
    // changed — what `updatedAt` means on a `GET /me/positions` row.
    updatedAt: event.ts,
  };
  return { kind: 'replace', positions };
}

/**
 * Whether this event announces an order row that 주문 이력 does not hold yet.
 *
 * A fill writes one (the order and its fill commit together), and no `user:` event carries an
 * `Order`'s id, status, filledQty or filledAmountCoin — so the list cannot be built from the event
 * and has to be asked for. A sell that only rests writes one too, and its lock is on the position
 * row, so that row is published (ADR-0112 결정 8: each position row the intake touched) and the list
 * is asked for then as well. A buy that only rests publishes nothing (ADR-0112: a lock alone moves
 * no ledger row), so it reaches the list on its next read. A settlement writes NO order row at all
 * (it moves positions and balances only), so a refetch there could answer nothing the list does not
 * already hold.
 *
 * The same rule `liveMarketStatus` (use-portfolio.ts) states from the other side: a terminal
 * transition is the REST answer's business. Exported apart from the socket handler because a
 * decision left inside an effect body is a decision this app's node-only vitest cannot reach.
 */
export function wroteAnOrder(event: UserPositionEvent): boolean {
  return !event.settled;
}

/**
 * Whether this event announces a settlement record 정산 목록 does not hold yet (#124, ADR-0143):
 * the other half of `wroteAnOrder`. A settlement retires the holding and writes its record in one
 * transaction (ADR-0118), and the event carries neither the record's result nor its payout, cost
 * or times — so the record cannot be built from it and the list is asked for. A trade writes none.
 */
export function wroteASettlement(event: UserPositionEvent): boolean {
  return event.settled;
}

/**
 * The 정산 기록 lists a settling `user:position` reads again (#124, ADR-0143): every filter's entry
 * of the account this socket is (`mySettlementsKey`'s last part), and no entry another account's
 * `Me` keyed — as the positions' handler patches only its own. One market's settlement sends an
 * event per holding; `restartQueries` cancels the read the first one started and asks once more,
 * and only a list on screen asks at all.
 */
export function ownSettlementKeys(client: QueryClient, accountId: string | undefined): QueryKey[] {
  if (accountId === undefined) return [];
  return client
    .getQueryCache()
    .findAll({ queryKey: SETTLEMENTS_KEY })
    .filter((query) => query.queryKey.at(-1) === accountId)
    .map((query) => query.queryKey);
}

/**
 * The 거래·정산 이력 주문 lists a round of the account's live orders reads again with them (#124,
 * ADR-0143 결정 9): every filter's entry of this account (`myOrderHistoryKey`'s last part), as
 * `ownSettlementKeys` picks. A live order a `market:book` or a `market:status` ended — another
 * tab's cancel, a restriction's or an admin grant's bulk cancel, a pause, a recovery approval, a
 * close's expiry — sends no `user:` event for a buy, so `ORDERS_KEY`'s restart on `user:position`
 * never reaches the row it now is; without this, MY's summary drops the order from its live
 * preview and its 주문 이력 preview does not take it in until the next read. Only a list on screen
 * asks (`refetchType` 'active'). /my/history holds no market room, so there it waits for a read.
 */
export function ownOrderHistoryKeys(
  client: QueryClient,
  accountId: string | undefined,
): QueryKey[] {
  if (accountId === undefined) return [];
  return client
    .getQueryCache()
    .findAll({ queryKey: MY_ORDER_HISTORY_KEY })
    .filter((query) => query.queryKey.at(-1) === accountId)
    .map((query) => query.queryKey);
}

/**
 * Whether this event puts a market back among the ones MY marks to a live price (#67, ADR-0142):
 * the open list holds the event's contract at 0, holds no contract of that market at 1 or more,
 * and the event takes it to 1 or more. The caller then reads `['market', id]` again
 * (`restartQueries`).
 *
 * MY joins and reads only the markets held at 1 or more (`useHoldings`, app/my/portfolio.tsx), so
 * a sold-out market's room is left and its entry keeps the last price MY saw. A buy back from
 * another tab publishes its `market:tick` to a room this tab is no longer in, the event here
 * carries no price, and the entry — written by the last tick, so inside `staleTime` for 30 s — is
 * taken as fresh by the observer that mounts again: the holding would be valued at the price from
 * before its own fill until some later tick. Marked stale here, that mount reads it once.
 *
 * `false` for everything a request would buy nothing for:
 *  - a market already held at 1 or more (either contract): MY is in its room, the tick arrives;
 *  - a row the list does not hold, or a list with no answer: `applyPositionEvent` reads the list
 *    again, and that answer carries the market's price with its fill count
 *    (`markToLiveMarket` takes the later pair);
 *  - a late or duplicate delivery (`version`), a sell, and a settlement.
 */
export function positionReopensMarket(
  held: Position[] | undefined,
  event: UserPositionEvent,
): boolean {
  if (held === undefined || event.settled || event.qty < 1) return false;
  const key = positionRowKey(event);
  let current: Position | undefined;
  for (const row of held) {
    if (row.marketId !== event.marketId) continue;
    if (row.qty >= 1) return false;
    if (positionRowKey(row) === key) current = row;
  }
  if (current === undefined || current.settled) return false;
  return supersedes(event.version, current.version);
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
 * The pair above is all it matches on. Since #67 each list is keyed by the account it is read
 * for (`positionsKey`, ADR-0142), so one entry only ever holds one account's rows; before that it
 * was correct only because `SessionCacheGuard` answers an account change with `resetQueries()`,
 * which still puts every positions query back to `data === undefined` and makes the next answer
 * win whole.
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
 * `applyPositionEvent` already answers in, because the outcomes are not all cache writes:
 * `replace` writes `me`, `refetch` writes nothing and asks for the profile, and
 * `replaceAndRefetch` does both — the figure moves at once, and the part of the profile the event
 * cannot speak for is asked again.
 */
export type BalancePatch =
  { kind: 'replace'; me: Me } | { kind: 'replaceAndRefetch'; me: Me } | { kind: 'refetch' };

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
 *
 * `replaceAndRefetch` is the answer for a `Me` whose start Coin is waiting (`startGrant.status`
 * `pending`, #70, ADR-0071). The worker pays such a grant once an admin enters the amount, and
 * that payment reaches the tab only as this event — which carries two amounts, a ledger id and a
 * time, not what the entry was. So the event may be the grant's payment and cannot say so: the
 * balance is written now, and the profile is asked again for `startGrant`, or the wallet would
 * go on saying 시작 Coin은 준비되는 대로 지급됩니다 above the balance that already holds it. While
 * nothing waits — every account but one whose amount is still undecided — this is the plain
 * `replace` and costs no request.
 */
export function applyBalanceEvent(held: Me | undefined, event: UserBalanceEvent): BalancePatch {
  if (held === undefined) return { kind: 'refetch' };
  const me: Me = {
    ...held,
    balance: { availableCoin: event.availableCoin, lockedCoin: event.lockedCoin },
  };
  return held.startGrant?.status === 'pending'
    ? { kind: 'replaceAndRefetch', me }
    : { kind: 'replace', me };
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
 * The ledger id sequence is drawn while the ACCOUNT's balance row is held FOR UPDATE;
 * #93 restoration reserves a correction event id from the same sequence without a ledger row.
 * Wallet, admin and settlement writers lock before allocation, so this is that account's commit order and has nothing to do with which socket carried
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
 * One leading-and-trailing window shared by every market, that keeps each market offered inside
 * it (#123, ADR-0141 결정 10, `refreshOwnOrders`): a refused market waits for the next round
 * instead of being dropped behind the market that scheduled the trailing one — the user may
 * have left MY for that other market's order detail meanwhile. Clock-free like `Throttle`: the
 * caller owns the clock and the trailing timer, which offers nothing new when it fires.
 */
export class MarketWindow {
  private readonly throttle: Throttle;
  private readonly held = new Set<string>();

  constructor(windowMs: number) {
    this.throttle = new Throttle(windowMs);
  }

  /**
   * Keeps `marketId` (lower-cased) for the next round. The markets that round reads, every one
   * offered since the last round, when the window lets it through now; else how long until it
   * will.
   */
  offer(marketId: string | undefined, now: number): { markets: string[] } | { wait: number } {
    if (marketId !== undefined) this.held.add(marketId.toLowerCase());
    if (!this.throttle.take('all', now)) return { wait: this.throttle.retryDelay('all', now) };
    const markets = [...this.held];
    this.held.clear();
    return { markets };
  }

  /** Forgets the markets kept: the socket that earned them is gone. */
  clear(): void {
    this.held.clear();
  }
}

/**
 * The 매도 가능액 read-again window for `market:book` (#67, ADR-0142): every market whose sellable a
 * book change may have moved waits here in the order it was signalled, and one is read every
 * `gapMs` — whatever the number of held markets, at most 60 / gap reads a minute. `MarketWindow`'s
 * every-market round would cost a read per held market per round: ten bot markets at 10 s are 60 a
 * minute, past the tab's 50 (ADR-0138). The price is a delay of up to gap × N; the order panel
 * reads its own quote again, so no Coin is ever decided on it (ADR-0140 결정 2-13).
 *
 * A market read again by another path since it was signalled — `user:position`, `market:status`,
 * an own order's end, a focus or a reconnect — is skipped (`readSince`, or `drop`), unless a read
 * was already in flight at the signal (`mark`'s `inFlight`): that answer is older than the change
 * however late it lands. Clock-free like
 * `Throttle`: the caller owns the clock, the timer, and the pause while the tab is hidden.
 */
export class SellableRotation {
  private readonly gapMs: number;
  /**
   * Lower-cased market id → when it was last signalled, and whether a read of it was in flight
   * then. Its place in the line is its first signal's (a Map keeps a key where it was set first);
   * the time is the last signal's, so a read between two signals does not skip the second
   * (`readSince`).
   */
  private readonly waiting = new Map<string, { at: number; inFlight: boolean }>();
  private lastReadAt: number | undefined;

  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }

  /**
   * Keeps `marketId` for a read: its place in the line is its first signal's, the time it is
   * compared on (`readSince`) its last signal's. `inFlight`: a read of that market's sellable was
   * on its way when the signal came. Its answer lands AFTER the signal but was taken BEFORE the
   * change, so an answer's time cannot clear this mark — the market is read in its turn (at most
   * one read more), as `invalidateOwn` reads the account's orders once more after a GET that left
   * before the change (#123, ADR-0141 결정 10). Only the last signal's flag counts: a read that
   * lands after a signal sent with none in flight left after it, and covers the earlier changes.
   */
  mark(marketId: string, now: number, inFlight = false): void {
    this.waiting.set(marketId.toLowerCase(), { at: now, inFlight });
  }

  /** Forgets `marketId`: it was read again by another path. */
  drop(marketId: string): void {
    this.waiting.delete(marketId.toLowerCase());
  }

  /** Forgets every market (a reconnect read them all; a socket that is gone). */
  clear(): void {
    this.waiting.clear();
  }

  get size(): number {
    return this.waiting.size;
  }

  /**
   * The market to read now — the longest waiting one not read since its signal (`readSince`) — or
   * how long until one may be read, or null when none waits. A market it returns is taken out.
   */
  next(
    now: number,
    readSince: (marketId: string, markedAt: number) => boolean = () => false,
  ): { marketId: string } | { wait: number } | null {
    for (const [id, mark] of this.waiting) {
      if (!mark.inFlight && readSince(id, mark.at)) this.waiting.delete(id);
    }
    if (this.waiting.size === 0) return null;
    if (this.lastReadAt !== undefined && now - this.lastReadAt < this.gapMs) {
      return { wait: this.gapMs - (now - this.lastReadAt) };
    }
    const [first] = this.waiting.keys();
    if (first === undefined) return null;
    this.waiting.delete(first);
    this.lastReadAt = now;
    return { marketId: first };
  }
}

/**
 * Whether a `market:book` in `marketId` puts the account's 매도 가능액 there in the read-again
 * window (#67, ADR-0142): the tab holds the account's sellable of that market with a contract it
 * holds — unlocked, which a book change can price differently, or locked in resting sells, which
 * a book change can UNLOCK. An account restriction's approval and an admin grant cancel the
 * account's resting orders and publish `market:book` alone (no `market:status`, no `user:`
 * event), so a holding all in resting sells read again only on its own change would keep its
 * 매도 잠금 after those sells were gone. A visitor and a member who holds nothing there (the
 * detail's sellable says 0 for both) add no request (R5); the window's gap caps the reads a
 * minute whatever the number of markets in it.
 *
 * A FIRST read still on its way (the entry exists, is fetching, and holds no answer) counts too:
 * whether the account holds anything there is not known yet, and that read left before this change,
 * so its answer would be drawn as current with no later signal behind it. The caller marks it
 * `inFlight` (its `fetchStatus` is 'fetching'), so the window reads it once more in its turn; if the
 * answer says 0 held, that one read is the whole cost, and the gap still bounds it.
 */
export function bookRestartsSellable(
  client: QueryClient,
  marketId: string,
  accountId: string | undefined,
): boolean {
  if (accountId === undefined) return false;
  const state = client.getQueryState<{ contracts?: readonly { qty: number }[] }>(
    sellableKey(marketId, accountId),
  );
  if (state === undefined) return false;
  if (state.data === undefined) return state.fetchStatus === 'fetching';
  return state.data.contracts?.some((contract) => contract.qty > 0) ?? false;
}

/**
 * The keys one round of the account's orders reads again (#123, ADR-0141 결정 10): its live lists
 * and the detail of each of its live orders on any of `marketIds` (`ownLiveOrderIds`). The live
 * lists' prefix does not cover a detail, and a buy cancelled elsewhere sends no `user:` event, so
 * a detail left out stays drawn live. And the account's ended-order lists (`ownOrderHistoryKeys`,
 * #124): the order that left the live list is a row there now.
 */
export function ownOrdersRefreshKeys(
  client: QueryClient,
  marketIds: Iterable<string>,
  accountId: string | undefined,
): QueryKey[] {
  const orderIds = new Set<string>();
  for (const marketId of marketIds) {
    for (const orderId of ownLiveOrderIds(client, marketId, accountId)) orderIds.add(orderId);
  }
  return [
    MY_ORDERS_LIVE_KEY,
    ...[...orderIds].map((orderId) => myOrderKey(orderId, accountId)),
    ...ownOrderHistoryKeys(client, accountId),
  ];
}

/**
 * The keys of the account's orders a `market:status` restarts (#123, ADR-0141 결정 10): with a
 * live order of the account held on that market, the live lists and those orders' details; and,
 * held or not, each of the account's FIRST reads still on its way — a live list of that market
 * or of every market (`'all'`), or any order's detail (its market is not known before it
 * answers). Such a read left before the pause or the close, so it would land as fresh and draw an
 * expired or held order 대기, with no `user:` event behind it for a buy. `restartQueries` cancels
 * exactly those and asks again; a status is rare, so the request it adds is too. With a held
 * order, the account's ended-order lists too (`ownOrderHistoryKeys`, #124).
 */
export function ownOrdersStatusKeys(
  client: QueryClient,
  marketId: string,
  accountId: string | undefined,
): QueryKey[] {
  if (accountId === undefined) return [];
  const market = marketId.toLowerCase();
  const own = ownLiveOrderIds(client, marketId, accountId);
  const firstRead = (query: Query) =>
    query.state.data === undefined &&
    query.state.fetchStatus === 'fetching' &&
    query.queryKey.at(-1) === accountId;
  const cache = client.getQueryCache();
  const keys: QueryKey[] = [];
  if (own.length > 0) {
    // The prefix restart takes the first reads among the lists too.
    keys.push(MY_ORDERS_LIVE_KEY);
    // The held order may end here (만료, 취소 완료): its ended-order row (#124).
    keys.push(...ownOrderHistoryKeys(client, accountId));
  } else {
    for (const query of cache.findAll({ queryKey: MY_ORDERS_LIVE_KEY, predicate: firstRead })) {
      const scope = query.queryKey[2];
      if (scope === market || scope === 'all') keys.push(query.queryKey);
    }
  }
  const details = new Set(own.map((orderId) => orderId.toLowerCase()));
  for (const orderId of details) keys.push(myOrderKey(orderId, accountId));
  for (const query of cache.findAll({ queryKey: MY_ORDER_DETAIL_KEY, predicate: firstRead })) {
    const orderId = query.queryKey[2];
    if (typeof orderId === 'string' && !details.has(orderId)) keys.push(query.queryKey);
  }
  return keys;
}

/**
 * `ids` in slices of at most `size`, in order; empty in, empty out.
 *
 * The realtime protocol caps a `subscribe`/`unsubscribe` MESSAGE at `REALTIME_SUBSCRIBE_MAX`
 * ids while a socket may HOLD `REALTIME_ROOMS_MAX` of them (@buddha/shared realtime.ts), and
 * the gateway refuses an over-long message whole — it joins no room at all and answers on
 * `exception`. A client that wants the bigger number therefore has to send the smaller one
 * repeatedly, which the home grid needs after five 더 보기 (PAGE_LIMIT_DEFAULT 20) and
 * MY needs for an account holding more than 100 markets, `GET /me/positions` having
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

/** Participant freshness changes independently of price and trade count. Never fabricates a row. */
export function applyStats<T extends LiveMarket>(
  held: T | undefined,
  event: MarketStatsEvent,
): T | undefined {
  if (!held || held.id !== event.marketId || !supersedes(event.statsRevision, held.statsRevision))
    return undefined;
  return { ...held, traderCount: event.traderCount, statsRevision: event.statsRevision };
}

/** One page of an order list as the live lists hold it (`OrderPages`, lib/my-orders.ts). */
interface HeldOrderPages {
  pages?: readonly { items?: readonly Order[] }[];
}

/**
 * The ids of `accountId`'s live orders on `marketId` this tab holds (#123, ADR-0141 결정 10): in
 * a live list of that account (`['orders', 'live', …, accountId]`) or an order's detail of it
 * (`['orders', 'detail', id, accountId]`). Empty for no account.
 */
export function ownLiveOrderIds(
  client: QueryClient,
  marketId: string,
  accountId: string | undefined,
): string[] {
  if (accountId === undefined) return [];
  const market = marketId.toLowerCase();
  const own = (order: Order) =>
    order.marketId.toLowerCase() === market &&
    (order.status === 'open' || order.status === 'partially_filled');
  const ids = new Set<string>();
  const cache = client.getQueryCache();
  for (const query of cache.findAll({ queryKey: MY_ORDERS_LIVE_KEY })) {
    if (query.queryKey.at(-1) !== accountId) continue;
    const data = query.state.data as HeldOrderPages | undefined;
    for (const page of data?.pages ?? []) {
      for (const order of page.items ?? []) if (own(order)) ids.add(order.id);
    }
  }
  for (const query of cache.findAll({ queryKey: MY_ORDER_DETAIL_KEY })) {
    if (query.queryKey.at(-1) !== accountId) continue;
    const order = query.state.data as Order | undefined;
    if (order !== undefined && own(order)) ids.add(order.id);
  }
  return [...ids];
}

/**
 * Whether a `market:book` in `marketId` reads the account's orders again (ADR-0141 결정 10): the
 * tab holds a live order of `accountId` there (`ownLiveOrderIds`) and no screen of it reads that
 * market's book — the market detail does, and there the 50-a-minute budget the book already spends
 * (ADR-0138) leaves nothing for it, so the detail's 내 대기 주문 waits for a fill's `user:position`,
 * a `market:status`, a focus or a reconnect. The signal says only that some order there changed,
 * the account's or anybody's: on MY and an order's detail it is how a cancel by an account
 * restriction, an admin role or another tab is seen.
 */
export function bookRestartsOwnOrders(
  client: QueryClient,
  marketId: string,
  accountId: string | undefined,
): boolean {
  if (ownLiveOrderIds(client, marketId, accountId).length === 0) return false;
  const book = client.getQueryCache().find({ queryKey: marketBookKey(marketId), exact: true });
  return (book?.getObserversCount() ?? 0) === 0;
}
