'use client';

import {
  PAYOUT_PER_CONTRACT_COIN,
  POSITION_STATUSES,
  type MarketStatus,
  type PositionStatus,
  parseCoinAmount,
} from '@buddha/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Order, type Position, api, unwrap } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { ORDERS_KEY, POSITIONS_KEY } from '@/lib/market-keys';
import { statusRank } from '@/lib/market-live';

/**
 * The portfolio's two private lists and the arithmetic /portfolio renders (PLAN 11.3:
 * 잔고 요약 · 보유 포지션(현재가 기준 평가손익) · 정산 이력 · 주문 이력).
 *
 * The balance summary is deliberately NOT a query of its own: it comes from `useMe()`, which
 * the nav chip already keeps live off `user:balance`. A second query for the same balance
 * would be a second answer with no ordering key to tell the two apart (Q-M3-8(2)), so the
 * summary and the chip could disagree on the same screen.
 *
 * Both roots are in `PRIVATE_QUERY_ROOTS`, so neither is ever dehydrated into the HTML and
 * both wait for the session, exactly like `useMe` (use-me.ts): the routes need the cookie,
 * and a logged-out request would take a 401 that the retry rule refuses to retry — the screen
 * would render an error where it means to render "sign in".
 *
 * Every amount is a `bigint` parsed from the wire's decimal strings. Not for tidiness: the
 * totals sum many Postgres bigints, and ten positions at the MAX_COIN_AMOUNT bound already carry
 * past 2^53, where a double can no longer hold an odd number of Coin.
 */

/**
 * `['positions', 'open' | 'settled']`. Both hang off `POSITIONS_KEY`, which is what lets the
 * socket's `user:position` handler refresh the two lists with one invalidation: react-query
 * matches by key PREFIX, so `['positions']` covers both and never reaches `['orders']`.
 */
export const positionsKey = (status: PositionStatus) => [...POSITIONS_KEY, status] as const;

/**
 * Which list a cached `['positions', …]` key names, or `undefined` for a key that names none.
 *
 * The socket walks every query under the root and has to hand each one's status to
 * `applyPositionEvent` — that is what lets the reducer tell an absence that is a GAP from one
 * that is the list's own definition. Read from the key rather than tracked beside it: the key IS
 * where the status lives, and a cache entry the app never built (a bare root) must answer
 * `undefined` rather than be guessed at.
 */
export function listStatusOf(queryKey: readonly unknown[]): PositionStatus | undefined {
  const status = queryKey[POSITIONS_KEY.length];
  return POSITION_STATUSES.includes(status as PositionStatus)
    ? (status as PositionStatus)
    : undefined;
}

/**
 * Just enough of better-auth's `useSession().data` to answer "is anybody signed in":
 * `undefined` while the session is still loading, `null` once it says nobody is. Taken as a
 * parameter rather than read here so the gate is a value a test can pin — the hooks below
 * pass what `useSession()` gave them.
 */
type SessionLike = { user: unknown } | null;

/**
 * `GET /me/positions?status=`. A plain query, not an infinite one: the route answers `{ data }`
 * with no `meta` because the list is bounded by the markets one account has touched, so there
 * is no cursor to page on.
 */
export function positionsQueryOptions(status: PositionStatus, session?: SessionLike) {
  return {
    queryKey: positionsKey(status),
    queryFn: async (): Promise<Position[]> =>
      unwrap(await api.GET('/api/v1/me/positions', { params: { query: { status } } })).data,
    enabled: session != null,
  };
}

/**
 * `status: 'open'` is the holdings the portfolio marks to market; `'settled'` is the history
 * that shows 결과 · 실현 손익. `isPending` covers the session lookup as well (use-me.ts:29):
 * without it a signed-in reload flashes the empty state, because a disabled query reports
 * `isPending` with no data of its own.
 */
export function usePositions(status: PositionStatus) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(positionsQueryOptions(status, session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * Which of the two lists a given market's rows are in, from the market's own status.
 *
 * `GET /me/positions?status=` filters on `positions.settled`, and the only thing that ever
 * flips that flag is the market finishing: the worker's settlement writes `settled: true` on
 * every holder row together with the market's terminal status. So the market's status is an
 * exact reading of which list its positions moved to, and a screen that only ever asks for
 * `'open'` tells a holder who was paid out that they never participated. `voided` is terminal
 * the same way, though nothing voids a market since #125 (#152 and #126 bring VOID back).
 *
 * `closed` and `resolved` are deliberately NOT terminal: trading has stopped, but nothing has
 * been paid out, so those rows are still open holdings marked to the market's last price. The
 * worker pays out and writes `settled` in one transaction (ADR-0046); if #29 lets the Coin step
 * finish before the market is `settled`, this function has to change with it.
 */
export function positionListStatusFor(marketStatus: MarketStatus): PositionStatus {
  return marketStatus === 'settled' || marketStatus === 'voided' ? 'settled' : 'open';
}

/** One cursor page of `GET /me/orders`, the page shape every infinite list in this app holds. */
export interface OrdersPage {
  items: Order[];
  nextCursor: string | null;
}

/**
 * `GET /me/orders?cursor=` — newest first, one page per 더 보기 press (the `useLedger` idiom,
 * use-wallet.ts). Unlike the positions lists this one really is unbounded: an account
 * accumulates an order per trade forever.
 */
export function ordersInfiniteQueryOptions(session?: SessionLike) {
  return {
    queryKey: ORDERS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<OrdersPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/orders', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: OrdersPage) => last.nextCursor ?? undefined,
    enabled: session != null,
  };
}

export function useOrders() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(ordersInfiniteQueryOptions(session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

// ---- the arithmetic the portfolio renders ------------------------------------------------

/** The fields the arithmetic below reads. A `Position` satisfies every one of them. */
export type PositionMath = Pick<
  Position,
  'outcome' | 'marketLastPrice' | 'qty' | 'costBasisCoin' | 'realizedPnlCoin'
>;

/**
 * 현재가: what one contract of this position is worth right now, in Coin.
 *
 * `marketLastPrice` is the market's last YES fill price (1..99 Coin per contract), so the NO side
 * is its complement against the `PAYOUT_PER_CONTRACT_COIN` a winning contract pays — the same
 * complement `formatNoPrice` shows, so the number under "아니오 37%" and the value of a NO
 * position can never disagree. Valuing a NO position at the YES price is the one mistake this
 * function exists to make impossible, and it is silent: it produces a plausible number that is
 * wrong by 100 − 2·price per contract.
 *
 * `undefined` for a market with no fill (체결 없음, N02 §5): there is no price to mark to, and
 * the row shows a dash the way `averageCostCoin` answers for nothing held. A holding comes from a
 * fill, so this is the type's case more than a live one.
 */
export function markPriceCoin(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice'>,
): bigint | undefined {
  if (position.marketLastPrice === null) return undefined;
  const yesPriceCoin = BigInt(position.marketLastPrice);
  return position.outcome === 'YES' ? yesPriceCoin : PAYOUT_PER_CONTRACT_COIN - yesPriceCoin;
}

/**
 * Mark-to-market value: `qty × markPriceCoin`. Zero for a row that has been fully sold — the API
 * keeps it at qty 0 so its realised PnL stays visible (`applySell`).
 *
 * Meaningful only while the market still trades. Settlement never writes a price, so a settled
 * market's `lastPrice` is the last price something TRADED at, not the 100/0 it resolved to:
 * the 정산 이력 section renders `realizedPnlCoin` and never this. That is also why
 * `portfolioTotals` is given one list at a time — `usePositions('open')` for 총 평가 금액 and
 * 총 평가손익, `usePositions('settled')` for 총 실현 손익.
 */
export function positionValueCoin(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice' | 'qty'>,
): bigint | undefined {
  const mark = markPriceCoin(position);
  return mark === undefined ? undefined : BigInt(position.qty) * mark;
}

/**
 * 평가손익: what the holding is worth now minus what it cost. Negative is ordinary, and
 * `formatCoin` renders it with `MINUS_SIGN` (PLAN 11.1 principle 6) rather than an ASCII hyphen.
 * `undefined` with no price to mark to, like `positionValueCoin`.
 */
export function unrealizedPnlCoin(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice' | 'qty' | 'costBasisCoin'>,
): bigint | undefined {
  const value = positionValueCoin(position);
  return value === undefined ? undefined : value - parseCoinAmount(position.costBasisCoin);
}

/**
 * 평단: cost basis per held contract, rounded half-up in bigint the way `applySell` releases
 * cost, so the average on screen and the cost the API releases never round apart. `undefined`
 * when nothing is held — that row shows a dash, not a division by zero.
 */
export function averageCostCoin(
  position: Pick<PositionMath, 'qty' | 'costBasisCoin'>,
): bigint | undefined {
  if (position.qty === 0) return undefined;
  const held = BigInt(position.qty);
  return (parseCoinAmount(position.costBasisCoin) + held / 2n) / held;
}

export interface PortfolioTotals {
  /** Σ `positionValueCoin` — copy.portfolioValue. */
  valueCoin: bigint;
  /** Σ `costBasisCoin`, the figure the two PnL lines are read against. */
  costBasisCoin: bigint;
  /** `valueCoin − costBasisCoin` — copy.portfolioUnrealizedPnl. */
  unrealizedPnlCoin: bigint;
  /** Σ `realizedPnlCoin` — copy.portfolioRealizedPnl. */
  realizedPnlCoin: bigint;
}

/**
 * The summary figures, summed in bigint over one list.
 *
 * Deliberately independent of the balance: `availableCoin`/`lockedCoin` come from `useMe()` and
 * adding them here would double-count, because the Coin a position cost has already left the
 * balance. `undefined` sums to zeros so the summary can render while the list is still
 * loading instead of branching at every call site.
 *
 * A row with no price to mark to (`markPriceCoin` is `undefined`) is left out of the value and
 * of the cost the two PnL lines are read against: counting its cost alone would print a loss
 * nobody has. Its realised PnL still counts — that needs no price.
 */
export function portfolioTotals(positions: readonly PositionMath[] = []): PortfolioTotals {
  let valueCoin = 0n;
  let costBasisCoin = 0n;
  let realizedPnlCoin = 0n;
  for (const position of positions) {
    realizedPnlCoin += parseCoinAmount(position.realizedPnlCoin);
    const value = positionValueCoin(position);
    if (value === undefined) continue;
    valueCoin += value;
    costBasisCoin += parseCoinAmount(position.costBasisCoin);
  }
  return {
    valueCoin,
    costBasisCoin,
    unrealizedPnlCoin: valueCoin - costBasisCoin,
    realizedPnlCoin,
  };
}

/**
 * 총 실현 손익, which spans BOTH position lists.
 *
 * Realised PnL is booked the moment contracts are SOLD, and `applySell` writes it onto the
 * position row while leaving the row where it is: a market that is still open keeps its row in
 * `usePositions('open')`. Reading the settled list alone therefore told an account that had
 * just taken a 100 Coin profit that it had realised nothing at all — and it stayed 0 Coin until the
 * market itself finished, which may never happen. A row MOVES between the two lists when the
 * market settles or is voided (`positions.settled`, `positionListStatusFor`), carrying its
 * accumulated `realizedPnlCoin` with it, so it is never in both and this cannot double count.
 *
 * "Never in both" is an invariant the SOCKET has to keep too, and it did not. A settlement
 * publishes `user:position` with `settled: true`, and `applyPositionEvent` used to write that
 * flag back into `['positions', 'open']` — the list the row had just LEFT — so a market-detail tab, which
 * mounts only the open list, kept the holding in 보유 포지션 while /portfolio fetched the same
 * row into 정산 이력, and this sum printed 500 Coin for one 250 Coin row. The write refreshed
 * `dataUpdatedAt` as well, so the poisoned list sat inside `staleTime` and the next mount did not
 * correct it. The reducer now answers `refetch` when the flag MOVES (market-live.ts), which is
 * what makes the sentence above true rather than merely intended.
 *
 * The two other totals are open-only and stay that way: settlement writes no price, so a
 * settled row's `marketLastPrice` is the last price something TRADED at rather than the 100/0
 * it resolved to, and marking those rows to it would be fiction.
 */
export function realizedPnlAcross(...totals: readonly PortfolioTotals[]): bigint {
  return totals.reduce((sum, total) => sum + total.realizedPnlCoin, 0n);
}

/**
 * Which status the badge reads, given the row's OWN snapshot and the live `['market', id]` row
 * beside it.
 *
 * THE HAZARD is the one the four `structuralSharing` joins exist for, arriving at RENDER time
 * instead of through a cache write. `['market', id]` and `['positions', …]` are two independent
 * fetches and the market's can be the OLDER of the two — react-query keeps the row it already
 * had when a REFETCH fails, so a positions answer carrying 마감 could be overwritten on screen
 * by a market entry still saying 진행 중, with nothing scheduled to correct it. Ranked by
 * `statusRank`, the same order `applyStatus` and `joinMarket` compare on, so no reading here can
 * walk a badge backwards.
 *
 * A status that would move the row to the OTHER list is refused outright. Membership is the
 * server's `positions.settled` flag (`positionListStatusFor`), and a settlement publishes its own `user:position` that `applyPositionEvent` answers with `refetch` PRECISELY
 * because the flag moved — so both lists are re-asked and the terminal case is already delivered,
 * with no help needed here. That is a recent guarantee rather than an old one: while the reducer
 * wrote the flag in place, this sentence was a promise nothing kept, and the refusal below was
 * resting on it. Taking it anyway would draw an open holding badged
 * 정산 완료 while 평가 금액 and 총 평가 금액 still value the row at the last traded price, which is
 * the fiction `positionValueCoin` and 정산 이력 are both documented never to print. It is the same
 * rule `wroteAnOrder` (market-live.ts) states from the other side: a terminal transition is the
 * REST answer's business, not an event's.
 */
export function liveMarketStatus(held: MarketStatus, live: MarketStatus | undefined): MarketStatus {
  if (live === undefined) return held;
  if (statusRank(live) <= statusRank(held)) return held;
  return positionListStatusFor(live) === positionListStatusFor(held) ? live : held;
}

/**
 * The position as the screen must read it: the market's LIVE price and status where the tab
 * holds the row, and the position's own snapshot otherwise.
 *
 * `Position.marketLastPrice` is a join taken when the list was fetched, and nothing refreshes it
 * on somebody else's trade — `applyPositionEvent` (market-live.ts) patches qty, cost and realised
 * PnL from a `user:position` event, which is only ever this account's own change. The `['market',
 * id]` cache is the thing a `market:tick` writes, so reading the mark price from there is what
 * makes 현재가 and 평가손익 move within the second PLAN 11.1 asks for — and what keeps the
 * probability in a market's header from disagreeing with the 내 포지션 card below it.
 *
 * The same object is returned when nothing moved, so an untouched row keeps its reference.
 *
 * `marketStatus` is the same story and was the half that was missing. A transition publishes
 * `market:status`, which moves `['market', id]` and nothing else — no `user:position` is
 * published for it — so 보유 포지션 kept announcing a closed market as 진행 중 until an
 * unrelated positions refetch. The detail screen already made this call once, passing the live
 * `status` to `MyPosition` rather than trusting the row's copy; this is /portfolio doing the
 * same. Refetching the lists on a status event would be the wrong half: two private requests
 * per event per signed-in tab, to move one denormalized enum. WHICH of the two statuses wins is
 * `liveMarketStatus`'s decision, not a `??`: the live row may be the older of the two, and a
 * terminal one would badge a row the list it is in cannot value.
 *
 * `marketLastPrice` gets NO such guard, and the asymmetry is a decision rather than an oversight
 * — it is the first thing a reader of the two lines below will ask. Status can be ordered from
 * the VALUE: `statusRank` reads the position in `MARKET_STATUSES`, and transitions are monotone,
 * so "newer" is knowable without a counter. A price is not — it moves both ways, and nothing in
 * either row says which reading is later. `Position.version` cannot stand in: it bumps on writes
 * to the POSITION row (`$onUpdate`, migration 0010), and somebody else's trade moves
 * `markets.last_price` without touching it. Ordering them would mean widening the wire (a market
 * counter on `positionSchema` plus the join in `listPositions`), which is A-M4-33 — recorded
 * beside the two other snapshots missing an ordering key rather than bolted on here.
 *
 * The live row is the fresher of the two in the ordinary case: /portfolio joins every held
 * market's room, so `market:tick` patches it, while `marketLastPrice` is a join frozen when the
 * list was fetched. For it to be the OLDER one it has to have MISSED a move — `market:tick` goes
 * out `.volatile`, so a congested tab may simply lose one (A-M4-7); a first page load is
 * subscribed only after the SSR read (A-M4-8); past `REALTIME_ROOMS_MAX` some held markets are
 * in no room at all; and a failed refetch keeps the row it last answered.
 *
 * The second half is NOT rare, which a first draft of this comment got wrong: a positions answer
 * has to land after the miss for it to show, and one does on ANY of this account's own trades.
 * `user:position` is absent from `['positions', 'settled']`, so `applyPositionEvent` answers
 * `refetch` and the provider restarts the whole `['positions']` root — both lists, never
 * `['market', id]`. So the honest statement is "one missed tick plus any own trade", not a
 * compound failure. What bounds it is that any LATER tick repairs it (`setQueryData` even puts
 * an errored query back to `success` with the new price), and what the screen does about the
 * window is SAY so rather than reorder: see `marketsStale` (portfolio.tsx), the same notice the
 * home grid and the detail already render.
 *
 * Applied at RENDER time by both readers and never written back to `['positions', …]`:
 * `joinPositions` (market-live.ts) deliberately gives both fields to the REST answer, so a live
 * value stored in the row would be the one field with two owners.
 */
export function markToLiveMarket(
  position: Position,
  live: { lastPrice?: number | null; status?: MarketStatus },
): Position {
  // `undefined` is "no live row"; `null` is the live row saying 체결 없음, which it means.
  const marketLastPrice = live.lastPrice === undefined ? position.marketLastPrice : live.lastPrice;
  const marketStatus = liveMarketStatus(position.marketStatus, live.status);
  if (marketLastPrice === position.marketLastPrice && marketStatus === position.marketStatus) {
    return position;
  }
  return { ...position, marketLastPrice, marketStatus };
}

/**
 * Whether a market price this screen values a holding at has stopped being refreshed — the
 * question 보유 포지션's stale notice asks of every `['market', id]` query beside it.
 *
 * `isError` covers BOTH failures, and that is the point: they are different states and the
 * FIRST-LOAD one is the worse of the two. A failed refetch keeps the row it last answered
 * (`isRefetchError`, data retained). A first fetch that exhausts its retries has NO row at all
 * (`isLoadingError`, `data === undefined`), so `markToLiveMarket` falls back to
 * `position.marketLastPrice` — a join frozen when the positions list was fetched, plausible and
 * unlabelled. Measured: a first-fetch failure answers `isLoadingError: true` and
 * `isRefetchError: false`, so a condition written on the latter alone said nothing at all in
 * exactly the case with the least live data behind it.
 *
 * Nothing else repairs the absent-row case either: `applyTick` will not build a row and
 * `tickRestartsMarket` (market-live.ts) requires the query to be FETCHING, while an errored one
 * is idle — whereas a RETAINED row is repaired by the very next tick. So the worse half is also
 * the one that waits longest, and it waited with nothing on screen to say so.
 *
 * Named as the two flags rather than `isError` (which is their disjunction) so a test can state
 * WHICH state was missed instead of restating the call.
 */
export function priceIsStale(query: { isLoadingError: boolean; isRefetchError: boolean }): boolean {
  return query.isLoadingError || query.isRefetchError;
}

/** What a section can say about a list it needs: it has one, it is coming, or it failed. */
export type ListState = 'ready' | 'pending' | 'failed';

export function listState(query: { data: unknown; isPending: boolean }): ListState {
  if (query.data !== undefined) return 'ready';
  return query.isPending ? 'pending' : 'failed';
}

/**
 * The reading of a figure that needs SEVERAL lists at once — 총 실현 손익 needs both. A failure
 * anywhere makes the sum unknowable, and a list still loading makes it incomplete, so neither
 * may be reported as a number: a total drawn from one of two lists is not a smaller total, it
 * is a wrong one.
 */
export function combinedListState(...states: readonly ListState[]): ListState {
  if (states.includes('failed')) return 'failed';
  if (states.includes('pending')) return 'pending';
  return 'ready';
}
