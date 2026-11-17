'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { type MyFill, type MySettlement, type Order, api, unwrap } from '@/lib/api';
import { myFillHistoryKey, myOrderHistoryKey, mySettlementsKey } from '@/lib/market-keys';
import { HISTORY_PAGE, type HistoryListFilters } from '@/lib/my-history';
import type { CursorPage } from '@/lib/order-join';
import { useSession } from '@/lib/use-session';

/**
 * 거래·정산 이력 (#124, ADR-0143): the account's ended orders, its fills and its settlement records,
 * each the server's own list — newest first, 20 at a time — narrowed by the screen's two filters.
 * `period` goes as its token alone: the server opens the window from its own clock at each read
 * (N × 24 hours back), so no instant is computed here and none is in a key. Every read waits for
 * the session and for the account the screen shows (`accountId`, `Me`'s id — the keys end in it,
 * market-keys.ts): an answer names no owner. Private (`['orders']`, `['settlements']`), never read
 * on the server, and never built from an event — a list is asked for again, so a late answer can
 * only be a newer reading of the server's own.
 */

type SessionLike = { user: unknown } | null;

/** `useMe`'s gate for a list: pending through the session's lookup, then the query's own. */
function gated<T extends { isPending: boolean }>(
  query: T,
  session: SessionLike | undefined,
  sessionPending: boolean,
): T & { isLoggedIn: boolean } {
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/** The filters and the cursor as the three routes take them: only what is set. */
export function historyQuery(
  filters: HistoryListFilters,
  cursor: string | undefined,
): { limit: number; marketId?: string; period?: HistoryListFilters['period']; cursor?: string } {
  return {
    limit: HISTORY_PAGE,
    ...(filters.market === undefined ? {} : { marketId: filters.market.toLowerCase() }),
    ...(filters.period === undefined ? {} : { period: filters.period }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

const paging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
};

/** One page of `GET /me/orders?state=ended`: 전량 체결·취소 완료·만료·거절, by arrival. */
export function orderHistoryQueryOptions(
  filters: HistoryListFilters,
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: myOrderHistoryKey(filters, accountId),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/orders', {
          params: { query: { state: 'ended', ...historyQuery(filters, pageParam) } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor } satisfies CursorPage<Order>;
    },
    ...paging,
    enabled: session != null && accountId !== undefined,
  };
}

/** One page of `GET /me/fills`: each fill as the account's own order took it. */
export function fillHistoryQueryOptions(
  filters: HistoryListFilters,
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: myFillHistoryKey(filters, accountId),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/fills', {
          params: { query: historyQuery(filters, pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor } satisfies CursorPage<MyFill>;
    },
    ...paging,
    enabled: session != null && accountId !== undefined,
  };
}

/** One page of `GET /me/settlements`: the account's settlement records, a zero payout's too. */
export function settlementHistoryQueryOptions(
  filters: HistoryListFilters,
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: mySettlementsKey(filters, accountId),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/settlements', {
          params: { query: historyQuery(filters, pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor } satisfies CursorPage<MySettlement>;
    },
    ...paging,
    enabled: session != null && accountId !== undefined,
  };
}

/** The account's ended orders, newest first by arrival; `period` is by the time it was placed. */
export function useOrderHistory(filters: HistoryListFilters, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(orderHistoryQueryOptions(filters, accountId, session));
  return gated(query, session, sessionPending);
}

/** The account's fills, newest first; `period` is by the fill's time. */
export function useFillHistory(filters: HistoryListFilters, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(fillHistoryQueryOptions(filters, accountId, session));
  return gated(query, session, sessionPending);
}

/** The account's settlement records, the latest payout first; `period` is by that payout's time. */
export function useSettlementHistory(filters: HistoryListFilters, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(settlementHistoryQueryOptions(filters, accountId, session));
  return gated(query, session, sessionPending);
}
