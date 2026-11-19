'use client';

import {
  PAYOUT_PER_CONTRACT_COIN,
  POSITION_STATUSES,
  type MarketStatus,
  type PositionStatus,
  parseCoinAmount,
  statusSupersedes,
} from '@buddha/shared';
import { useQuery } from '@tanstack/react-query';
import { type Market, type Order, type Position, api, unwrap } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { POSITIONS_KEY } from '@/lib/market-keys';
import { type LiveMarket, statusRank } from '@/lib/market-live';

/**
 * The account's two position lists and the arithmetic MY renders (PLAN 11.3's portfolio, which
 * #16 moved into MY: 잔고 요약 · 보유 포지션(현재가 기준 평가손익) · 정산 이력 · 주문 이력). The order
 * lists are #123's (use-my-orders.ts) and the history's (#124, use-my-history.ts).
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
 * `['positions', 'open' | 'settled', accountId]`. Both hang off `POSITIONS_KEY`, which is what lets
 * the socket's `user:position` handler refresh the two lists with one invalidation: react-query
 * matches by key PREFIX, so `['positions']` covers both and never reaches `['orders']`.
 *
 * The account the screen shows (`Me`'s id) is the last part (#67, ADR-0142; ADR-0090 결정 4-2,
 * ADR-0140 결정 2-22): a holding row carries a sell button, and `['me']` can turn from A to B
 * before the session does, so A's holdings are never drawn as B's. `undefined` while that account
 * is not known: the query is off then.
 */
export const positionsKey = (status: PositionStatus, accountId: string | undefined) =>
  [...POSITIONS_KEY, status, accountId] as const;

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
 * `GET /me/positions?status=`. A plain query, not an infinite one: the route answers `{ data }`
 * with no `meta` because the list is bounded by the markets one account has touched, so there
 * is no cursor to page on. Read only once the account it is keyed by is known (`GET /me`).
 */
export function positionsQueryOptions(status: PositionStatus, accountId: string | undefined) {
  return {
    queryKey: positionsKey(status, accountId),
    queryFn: async (): Promise<Position[]> =>
      unwrap(await api.GET('/api/v1/me/positions', { params: { query: { status } } })).data,
    enabled: accountId !== undefined,
  };
}

/**
 * `status: 'open'` is the holdings the portfolio marks to market; `'settled'` is the history
 * that shows 결과 · 실현 손익. `isPending` covers the session lookup as well (use-me.ts:29):
 * without it a signed-in reload flashes the empty state, because a disabled query reports
 * `isPending` with no data of its own.
 *
 * `accountId` is MY's account (`useMe().data?.id`): while it is undefined the query is off and the
 * caller draws `GET /me`'s wait or failure (`ProfileUnavailable`), as #123's lists do — so every
 * holdings list's first request waits for `GET /me` (ADR-0142).
 */
export function usePositions(status: PositionStatus, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(positionsQueryOptions(status, accountId));
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
 * `'open'` tells a holder who was paid out that they never participated. `cancelled` is terminal
 * too and lists with the finished ones: it ends a market no user traded in (ADR-0093 decision 1,
 * item 10), so a user holds nothing there — and should a row ever exist, it belongs with the
 * markets that are over, never among holdings marked to a price that no longer trades.
 *
 * Everything before `settled` is deliberately NOT terminal — `paused`, `closed`, `provisional`,
 * `resolved` and `settling` included: trading has stopped or the payout is under way, but nothing
 * has been paid out, so those rows are still open holdings marked to the market's last price.
 * The worker pays out and writes `settled` in one transaction (ADR-0046) that also takes the
 * market from `settling` to `settled`; if a step added later lets the Coin step finish before the
 * market is `settled`, this function has to change with it.
 *
 * The open list is not what MY's 보유 계약 draws (ADR-0135 F4, #67): that tab shows the rows held
 * at 1 contract or more (`heldGroups`). A row sold out of stays in the open list all the same —
 * 총 실현 손익 counts it, and the detail's 내 포지션 shows it as '보유 없음' with its 실현 손익.
 */
export function positionListStatusFor(marketStatus: MarketStatus): PositionStatus {
  return marketStatus === 'settled' || marketStatus === 'cancelled' ? 'settled' : 'open';
}

/**
 * Where a status sits in the lifecycle for `liveMarketStatus`: its `statusRank`, except that
 * `paused` shares `open`'s step. OPEN ↔ PAUSED is the one pair a market that has traded moves
 * along both ways (ADR-0093 decision 1, item 3; `MARKET_LIFECYCLE_TRANSITIONS`), so neither of
 * the two can be called the later reading from the value alone. Every other edge a held market
 * can take goes forward in `MARKET_STATUSES` order — the other ways back (review → draft,
 * scheduled → draft) are before any trade, where nobody holds anything.
 */
function lifecycleStep(status: MarketStatus): number {
  return statusRank(status === 'paused' ? 'open' : status);
}

// ---- the arithmetic the portfolio renders ------------------------------------------------

/** The fields the arithmetic below reads. A `Position` satisfies every one of them. */
export type PositionMath = Pick<
  Position,
  'outcome' | 'marketLastPrice' | 'qty' | 'costBasisCoin' | 'realizedPnlCoin'
>;

/**
 * 최근 체결가 of the contract (#67, ADR-0135 결정 4): what one contract of this position is worth
 * at the market's last fill, in Coin.
 *
 * `marketLastPrice` is the market's last YES fill price (1..99 Coin per contract), so the NO side
 * is its complement against the `PAYOUT_PER_CONTRACT_COIN` a winning contract pays — the same
 * complement `formatNoPrice` shows, so the number under "NO 37%" and the value of a NO
 * position can never disagree. Valuing a NO position at the YES price is the one mistake this
 * function exists to make impossible, and it is silent: it produces a plausible number that is
 * wrong by 100 − 2·price per contract.
 *
 * `undefined` for a market with no fill (체결 없음, N02 §5): there is no price to mark to, and
 * the row shows a dash the way `averageCostBp` answers for nothing held. A holding comes from a
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
 * `portfolioTotals` is given one list at a time — the open rows for 총 참고 평가 and 총 미실현 손익,
 * both lists for 총 실현 손익.
 */
export function positionValueCoin(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice' | 'qty'>,
): bigint | undefined {
  const mark = markPriceCoin(position);
  return mark === undefined ? undefined : BigInt(position.qty) * mark;
}

/**
 * 미실현 손익 (ADR-0135 F1): 참고 평가 minus 잔여 원가. Negative is ordinary, and
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
 * 평균 매입가 (#67, ADR-0142; ADR-0135 결과 4): cost basis per held contract in basis points of a
 * Coin (3333 = 33.33 Coin, `formatPricePerContract`), rounded half-up in bigint — the same rule as
 * `orderAveragePriceBp`. Shown to two decimals: 33·33·34 Coin for one contract each is 33.33, not
 * the 33 a whole-Coin average said. The server releases cost in whole Coin (`applySell`), so after
 * a partial sell the average may move inside a Coin (33.33 → 33.50 when one of the three goes for
 * a released 33); 미실현 손익 is read off the remaining cost (`unrealizedPnlCoin`), never off this
 * average, so the rounding never reaches a PnL. `undefined` when nothing is held — that row shows a
 * dash, not a division by zero.
 */
export function averageCostBp(
  position: Pick<PositionMath, 'qty' | 'costBasisCoin'>,
): number | undefined {
  if (position.qty === 0) return undefined;
  const held = BigInt(position.qty);
  return Number((parseCoinAmount(position.costBasisCoin) * 100n + held / 2n) / held);
}

/**
 * 주문 이력's 평균가 in basis points of a Coin (6300 = 63.00 Coin, `formatPricePerContract`): what
 * the order's fills cost per contract at its own side's prices (#119 `filledAmountCoin`), rounded
 * half-up in bigint. `undefined` while nothing filled — a resting, refused or unfilled order shows
 * a dash, not a division by zero.
 */
export function orderAveragePriceBp(
  order: Pick<Order, 'filledQty' | 'filledAmountCoin'>,
): number | undefined {
  if (order.filledQty === 0) return undefined;
  const filled = BigInt(order.filledQty);
  return Number((parseCoinAmount(order.filledAmountCoin) * 100n + filled / 2n) / filled);
}

export interface PortfolioTotals {
  /** Σ `positionValueCoin` — copy.portfolioValue (총 참고 평가). */
  valueCoin: bigint;
  /** Σ `costBasisCoin`, the figure the two PnL lines are read against. */
  costBasisCoin: bigint;
  /** `valueCoin − costBasisCoin` — copy.portfolioUnrealizedPnl (총 미실현 손익). */
  unrealizedPnlCoin: bigint;
  /** Σ `realizedPnlCoin` — copy.portfolioRealizedPnl. */
  realizedPnlCoin: bigint;
}

/**
 * The summary figures, summed in bigint over one list.
 *
 * Deliberately independent of the balance: `availableCoin`/`lockedCoin` come from `useMe()` and
 * adding them here would double-count, because the Coin a position cost has already left the
 * balance. Nor does a start grant or a 재지급 reach it: they move the ledger, never a position
 * (N02 §8, N04 §3; ADR-0135 F5 and 결정 4 — no 총 자산 line). `undefined` sums to zeros so the
 * summary can render while the list is still loading instead of branching at every call site.
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
 * market settles (`positions.settled`, `positionListStatusFor`), carrying its
 * accumulated `realizedPnlCoin` with it, so it is never in both and this cannot double count.
 *
 * "Never in both" is an invariant the SOCKET has to keep too, and it did not. A settlement
 * publishes `user:position` with `settled: true`, and `applyPositionEvent` used to write that
 * flag back into `['positions', 'open']` — the list the row had just LEFT — so a market-detail tab, which
 * mounts only the open list, kept the holding in 보유 포지션 while /portfolio fetched the same
 * row into 정산 이력, and this sum printed 500 Coin for one 250 Coin row. The write refreshed
 * `dataUpdatedAt` as well, so the poisoned list sat inside `staleTime` and the next mount did not
 * correct it. The reducer now answers `refetch` when the flag MOVES (market-live.ts), which is
 * what makes the sentence above true rather than merely intended. And for the moment a
 * settlement's two answers land out of order — the settled list before the open one — the open
 * copy is left out before either sum (`dedupeAcrossLists`, #67).
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
 * had when a REFETCH fails, so a positions answer carrying 거래 마감 could be overwritten on
 * screen by a market entry still saying 거래 중, with nothing scheduled to correct it.
 *
 * With the transition key on both sides (`keys`: the live row's `statusEventId` and, since #67,
 * the position's `marketStatusEventId`, ADR-0142) the two are compared on it (`statusSupersedes`),
 * as every other writer of a market row is: the later transition wins, OPEN ↔ PAUSED included.
 * Without a key on either side (a test factory's row, a caller that has none), by VALUE
 * (`lifecycleStep`): the statuses are not a total order — OPEN ↔ PAUSED goes both ways (#174) — so:
 * - a live status a step BEHIND the held one is refused: the lifecycle never goes back there, so
 *   the live row is the older reading, and no reading here can walk a badge backwards;
 * - a live status on the SAME step — 거래 중 against 거래 일시 중단, either way round — is taken:
 *   the value cannot say which came later, and the live row is the one the room keeps in event
 *   order, while the snapshot is a join frozen at the list's last fetch.
 *
 * Either way a status that would move the row to the OTHER list is refused outright. Membership is
 * the server's `positions.settled` flag (`positionListStatusFor`), and a settlement publishes its
 * own `user:position` that `applyPositionEvent` answers with `refetch` PRECISELY because the flag
 * moved — so both lists are re-asked and the terminal case is already delivered. Taking it anyway
 * would draw an open holding badged 지급 완료 while 참고 평가 and 총 참고 평가 still value the row
 * at the last traded price, which is the fiction `positionValueCoin` and 정산 이력 are both
 * documented never to print. It is the same rule `wroteAnOrder` (market-live.ts) states from the
 * other side: a terminal transition is the REST answer's business, not an event's.
 */
export function liveMarketStatus(
  held: MarketStatus,
  live: MarketStatus | undefined,
  keys: { held: string | null; live: string | null } = { held: null, live: null },
): MarketStatus {
  if (live === undefined || live === held) return held;
  if (positionListStatusFor(live) !== positionListStatusFor(held)) return held;
  if (keys.held !== null && keys.live !== null) {
    const later = statusSupersedes(
      { status: live, statusEventId: keys.live },
      { status: held, statusEventId: keys.held },
    );
    return later ? live : held;
  }
  return lifecycleStep(live) < lifecycleStep(held) ? held : live;
}

/** What `markToLiveMarket` reads off the live `['market', id]` row: a `Market` satisfies it. */
export type LiveMarketReading = Pick<
  LiveMarket,
  'lastPrice' | 'lastFillAt' | 'tradeCount' | 'status' | 'statusEventId'
>;

/**
 * The position as the screen must read it: the market's LIVE price, its time and status where the
 * tab holds the row, and the position's own snapshot otherwise.
 *
 * `Position.marketLastPrice` is a join taken when the list was fetched, and nothing refreshes it
 * on somebody else's trade — `applyPositionEvent` (market-live.ts) patches qty, cost and realised
 * PnL from a `user:position` event, which is only ever this account's own change. The `['market',
 * id]` cache is the thing a `market:tick` writes, so reading the mark price from there is what
 * makes 최근 체결가 and 미실현 손익 move within the second PLAN 11.1 asks for — and what keeps the
 * price in a market's header from disagreeing with the 내 포지션 card below it.
 *
 * The price and its time are ONE pair, chosen by the market's fill count (#67, ADR-0142, closing
 * A-M4-33): the live row's pair when its `tradeCount` is not behind the position's
 * `marketTradeCount`, the position's otherwise. A price moves both ways, so its value cannot say
 * which reading is later; the count only grows. So a live row read before the first fill
 * (`lastPrice: null`) never covers a holding's real price with '체결 없음', a live row that missed a
 * tick never walks the price back past the list's, and the time under the price is always that
 * price's.
 * `Position.version` could not stand in: it bumps on writes to the POSITION row, and somebody
 * else's trade moves the market without touching it.
 *
 * The status is `liveMarketStatus`'s, on the two transition keys where both rows have one. A
 * transition publishes `market:status`, which moves `['market', id]` and nothing else — no
 * `user:position` — so 보유 계약 would otherwise keep announcing a closed market as 거래 중 until an
 * unrelated positions refetch.
 *
 * The same object is returned when nothing moved, so an untouched row keeps its reference. Applied
 * at RENDER time by both readers and never written back to `['positions', …]`: `joinPositions`
 * (market-live.ts) gives the market's fields to the REST answer, so a live value stored in the row
 * would be the one field with two owners.
 */
export function markToLiveMarket(
  position: Position,
  live: LiveMarketReading | undefined,
): Position {
  if (live === undefined) return position;
  const livePair = live.tradeCount >= position.marketTradeCount;
  const marketLastPrice = livePair ? live.lastPrice : position.marketLastPrice;
  const marketLastFillAt = livePair ? live.lastFillAt : position.marketLastFillAt;
  const marketTradeCount = livePair ? live.tradeCount : position.marketTradeCount;
  const marketStatus = liveMarketStatus(position.marketStatus, live.status, {
    held: position.marketStatusEventId,
    live: live.statusEventId,
  });
  if (
    marketLastPrice === position.marketLastPrice &&
    marketLastFillAt === position.marketLastFillAt &&
    marketTradeCount === position.marketTradeCount &&
    marketStatus === position.marketStatus
  ) {
    return position;
  }
  return { ...position, marketLastPrice, marketLastFillAt, marketTradeCount, marketStatus };
}

/** YES before NO, within a market (F7). */
const outcomeOrder = (row: Pick<Position, 'outcome'>): number => (row.outcome === 'YES' ? 0 : 1);

const contractKey = (row: Pick<Position, 'marketId' | 'outcome'>): string =>
  `${row.marketId.toLowerCase()}:${row.outcome}`;

/**
 * The open rows that are not in the settled list as well (#67, ADR-0142). A settlement's
 * `user:position` reads both lists again (`applyPositionEvent` answers `refetch`), and when the
 * settled answer lands first the same contract is in both for a moment: its 실현 손익 would be
 * counted twice, and a paid-out holding valued at the last traded price. The settled list is the
 * later reading — a row only ever moves from open to settled — so the open copy goes. Both the rows
 * on screen and the totals are read off this.
 */
export function dedupeAcrossLists(
  open: readonly Position[],
  settled: readonly Position[] | undefined,
): Position[] {
  if (settled === undefined || settled.length === 0) return [...open];
  const done = new Set(settled.map(contractKey));
  return open.filter((row) => !done.has(contractKey(row)));
}

/** One market of MY's 보유 계약: its held contracts, YES then NO (F7). */
export interface HeldGroup {
  marketId: string;
  /** The rows held at 1 contract or more, YES before NO: one or two. */
  rows: readonly Position[];
  /** The newest `updatedAt` among them: what the groups are ordered by. */
  updatedAt: string;
}

/**
 * MY's 보유 계약 (ADR-0135 F4·F7, #67): the open rows held at 1 contract or more, one group per
 * market with YES before NO, the group with the most recent change first (its rows' newest
 * `updatedAt`; a tie by market id). A row sold out of is not drawn but still counted — the totals
 * take every open row (`portfolioTotals`, `realizedPnlAcross`), and this answers another type, so
 * a group cannot be handed to a sum by mistake. A resting sell changes `updatedAt` too
 * (order.service.ts), so its market moves to the top: the owner's '최근 변동 순', not held still
 * while the screen is up (ADR-0142).
 */
export function heldGroups(markedAll: readonly Position[]): HeldGroup[] {
  const groups = new Map<string, Position[]>();
  for (const row of markedAll) {
    if (row.qty < 1) continue;
    const rows = groups.get(row.marketId);
    if (rows === undefined) groups.set(row.marketId, [row]);
    else rows.push(row);
  }
  const at = (iso: string) => Date.parse(iso);
  return [...groups.entries()]
    .map(([marketId, rows]) => {
      const ordered = [...rows].sort((a, b) => outcomeOrder(a) - outcomeOrder(b));
      const updatedAt = ordered.reduce(
        (newest, row) => (at(row.updatedAt) > at(newest) ? row.updatedAt : newest),
        ordered[0]?.updatedAt ?? '',
      );
      return { marketId, rows: ordered, updatedAt };
    })
    .sort((a, b) => {
      const byTime = at(b.updatedAt) - at(a.updatedAt);
      if (byTime !== 0) return byTime;
      return a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0;
    });
}

/**
 * A holding's status badge flags — '판정 지연' (`judgementDelayed`) and '이의 검토 중'
 * (`disputeUnderReview`, #175) — from its market's live row, only when that row was read for the
 * status the holding shows (`markToLiveMarket`'s). A live row a lifecycle step behind the
 * position (`liveMarketStatus` keeps the position's then) read its flags for another status: a
 * CLOSED row past its scheduled judgement says `judgementDelayed`, which on a fresh 잠정 결과 would
 * read '판정 지연'. With no live row, or one of another status, the holding reads its status alone.
 */
export function holdingDisplay(
  live: Pick<Market, 'status' | 'judgementDelayed' | 'disputeUnderReview'> | undefined,
  status: MarketStatus,
): Pick<Market, 'judgementDelayed' | 'disputeUnderReview'> {
  if (live === undefined || live.status !== status) {
    return { judgementDelayed: false, disputeUnderReview: false };
  }
  return { judgementDelayed: live.judgementDelayed, disputeUnderReview: live.disputeUnderReview };
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
 *
 * And a third (#300, ADR-0147): MY's holdings chunk holds up to 50 markets, and a card write of
 * any one of them (`setQueriesData`, a manual `success`) puts `status` back to success and clears
 * `error` — one busy neighbour would hide a failed read of 49 others. A manual write keeps
 * `failureCount` (`fetchFailureCount`), which only a read's own start resets, so a failure stands
 * until a read answers: `failureCount > 0` while no read is running.
 */
export function priceIsStale(query: {
  isLoadingError: boolean;
  isRefetchError: boolean;
  failureCount?: number;
  fetchStatus?: string;
}): boolean {
  return (
    query.isLoadingError ||
    query.isRefetchError ||
    ((query.failureCount ?? 0) > 0 && query.fetchStatus === 'idle')
  );
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

/** What `realizedPnlState` reads of each position list (`useQuery`'s answer satisfies it). */
export interface PositionListReading {
  data: unknown;
  isPending: boolean;
  isFetching: boolean;
  isRefetchError: boolean;
  dataUpdatedAt: number;
}

/**
 * The reading of 총 실현 손익 (#67, ADR-0142), which sums BOTH position lists
 * (`realizedPnlAcross`) — `combinedListState` of the two, and two cases it cannot see because
 * each list still HAS data:
 * - the settled list behind the open one: a settlement's `user:position` reads both again at once
 *   (`applyPositionEvent` answers `refetch`), and when the open answer lands first the settled
 *   contract has left 보유 계약 while 정산 이력 is the old list — the row is in NEITHER, and the
 *   sum drops its 실현 손익 until the settled answer lands. `dedupeAcrossLists` covers the other
 *   order. So while the settled list is fetching and older than the open one, the figure waits;
 *   a focus refetch of both shows the skeleton for that moment too, never a short sum.
 * - a refetch that failed on either list keeps its old rows, and a settlement that one list saw
 *   and the other did not leaves the row in neither or both. The figure is 'failed' then — a dash
 *   with 다시 시도 — rather than a sum nothing says is wrong.
 */
export function realizedPnlState(
  open: PositionListReading,
  settled: PositionListReading,
): ListState {
  const both = combinedListState(listState(open), listState(settled));
  if (both !== 'ready') return both;
  if (open.isRefetchError || settled.isRefetchError) return 'failed';
  if (settled.isFetching && open.dataUpdatedAt > settled.dataUpdatedAt) return 'pending';
  return 'ready';
}
