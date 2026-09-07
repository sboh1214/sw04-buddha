'use client';

import {
  PAYOUT_PER_CONTRACT_P,
  type MarketStatus,
  type PositionStatus,
  parsePAmount,
} from '@buddha/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Order, type Position, api, unwrap } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { ORDERS_KEY, POSITIONS_KEY } from '@/lib/market-keys';

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
 * totals sum many Postgres bigints, and ten positions at the MAX_P_AMOUNT bound already carry
 * past 2^53, where a double can no longer hold an odd number of P.
 */

/**
 * `['positions', 'open' | 'settled']`. Both hang off `POSITIONS_KEY`, which is what lets the
 * socket's `user:position` handler refresh the two lists with one invalidation: react-query
 * matches by key PREFIX, so `['positions']` covers both and never reaches `['orders']`.
 */
export const positionsKey = (status: PositionStatus) => [...POSITIONS_KEY, status] as const;

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
 * flips that flag is the market finishing: the void writes `settled: true` on every holder row
 * inside the same transaction that writes `status: 'voided'` (market-admin.service.ts), and
 * M5's settlement will write the pair together the same way. So the market's status is an
 * exact reading of which list its positions moved to, and a screen that only ever asks for
 * `'open'` tells a holder who was refunded that they never participated.
 *
 * `closed` and `resolving` are deliberately NOT terminal: trading has stopped, but nothing has
 * been paid out, so those rows are still open holdings marked to the market's last price.
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
  'outcome' | 'marketLastPrice' | 'qty' | 'costBasisP' | 'realizedPnlP'
>;

/**
 * 현재가: what one contract of this position is worth right now, in P.
 *
 * `marketLastPrice` is the market's YES price (1..99 P per contract, `priceOf`), so the NO
 * side is its complement against the `PAYOUT_PER_CONTRACT_P` a winning contract pays — the
 * same complement `formatNoPrice` shows, so the number under "아니오 37%" and the value of a
 * NO position can never disagree. Valuing a NO position at the YES price is the one mistake
 * this function exists to make impossible, and it is silent: it produces a plausible number
 * that is wrong by 100 − 2·price per contract.
 */
export function markPriceP(position: Pick<PositionMath, 'outcome' | 'marketLastPrice'>): bigint {
  const yesPriceP = BigInt(position.marketLastPrice);
  return position.outcome === 'YES' ? yesPriceP : PAYOUT_PER_CONTRACT_P - yesPriceP;
}

/**
 * Mark-to-market value: `qty × markPriceP`. Zero for a row that has been fully sold — the API
 * keeps it at qty 0 so its realised PnL stays visible (`applySell`).
 *
 * Meaningful only while the market still trades. Settlement never writes a price, so a settled
 * market's `lastPrice` is the last price something TRADED at, not the 100/0 it resolved to:
 * the 정산 이력 section renders `realizedPnlP` and never this. That is also why
 * `portfolioTotals` is given one list at a time — `usePositions('open')` for 총 평가 금액 and
 * 총 평가손익, `usePositions('settled')` for 총 실현 손익.
 */
export function positionValueP(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice' | 'qty'>,
): bigint {
  return BigInt(position.qty) * markPriceP(position);
}

/**
 * 평가손익: what the holding is worth now minus what it cost. Negative is ordinary, and
 * `formatP` renders it with `MINUS_SIGN` (PLAN 11.1 principle 6) rather than an ASCII hyphen.
 */
export function unrealizedPnlP(
  position: Pick<PositionMath, 'outcome' | 'marketLastPrice' | 'qty' | 'costBasisP'>,
): bigint {
  return positionValueP(position) - parsePAmount(position.costBasisP);
}

/**
 * 평단: cost basis per held contract, rounded half-up in bigint the way `applySell` releases
 * cost, so the average on screen and the cost the API releases never round apart. `undefined`
 * when nothing is held — that row shows a dash, not a division by zero.
 */
export function averageCostP(
  position: Pick<PositionMath, 'qty' | 'costBasisP'>,
): bigint | undefined {
  if (position.qty === 0) return undefined;
  const held = BigInt(position.qty);
  return (parsePAmount(position.costBasisP) + held / 2n) / held;
}

export interface PortfolioTotals {
  /** Σ `positionValueP` — copy.portfolioValue. */
  valueP: bigint;
  /** Σ `costBasisP`, the figure the two PnL lines are read against. */
  costBasisP: bigint;
  /** `valueP − costBasisP` — copy.portfolioUnrealizedPnl. */
  unrealizedPnlP: bigint;
  /** Σ `realizedPnlP` — copy.portfolioRealizedPnl. */
  realizedPnlP: bigint;
}

/**
 * The summary figures, summed in bigint over one list.
 *
 * Deliberately independent of the balance: `availableP`/`lockedP` come from `useMe()` and
 * adding them here would double-count, because the P a position cost has already left the
 * balance. `undefined` sums to zeros so the summary can render while the list is still
 * loading instead of branching at every call site.
 */
export function portfolioTotals(positions: readonly PositionMath[] = []): PortfolioTotals {
  let valueP = 0n;
  let costBasisP = 0n;
  let realizedPnlP = 0n;
  for (const position of positions) {
    valueP += positionValueP(position);
    costBasisP += parsePAmount(position.costBasisP);
    realizedPnlP += parsePAmount(position.realizedPnlP);
  }
  return { valueP, costBasisP, unrealizedPnlP: valueP - costBasisP, realizedPnlP };
}
