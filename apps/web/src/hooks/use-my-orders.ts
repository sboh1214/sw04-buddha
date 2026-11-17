'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  accountToastAfterCommit,
  createAccountToast,
  dismissAccountToastsExcept,
} from '@/components/market/order-toasts';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Me, type MyFill, type Order, api, unwrap } from '@/lib/api';
import {
  MY_ORDERS_LIVE_KEY,
  myMarketFillsKey,
  myOrderFillsKey,
  myOrderKey,
  myOrdersLiveKey,
  walletLiveOrdersKey,
} from '@/lib/market-keys';
import {
  type CursorPage,
  ENDED_CHECK_MAX,
  LIVE_ORDERS_PAGE,
  MARKET_FILLS_PAGE,
  type NoticeLog,
  ORDER_FILLS_PAGE,
  type OrderPages,
  cancelOutcomeOf,
  endedManyText,
  endedNotice,
  isLiveOrder,
  liveRowsOnly,
  noticeOnce,
  refreshAfterOwnCancel,
  withOrderInPages,
} from '@/lib/my-orders';
import { useSession } from '@/lib/use-session';

/**
 * 대기 주문과 주문 상세 (#123, ADR-0141): the account's live orders, one order, its fills, the
 * account's fills on one market, and the cancel. Every read waits for the session and for the
 * account the screen shows (`accountId`, `Me`'s id — the keys end in it, market-keys.ts): an answer
 * names no owner, and a cancel acts on the rows drawn. Private under `['orders']`, never on the
 * server.
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

/** One page of `GET /me/orders?state=live`, every market's or one market's. */
export function liveOrdersQueryOptions(
  accountId: string | undefined,
  marketId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: myOrdersLiveKey(accountId, marketId),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/orders', {
          params: {
            query: {
              state: 'live',
              limit: LIVE_ORDERS_PAGE,
              ...(marketId === undefined ? {} : { marketId: marketId.toLowerCase() }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor } satisfies CursorPage<Order>;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CursorPage<Order>) => last.nextCursor ?? undefined,
    enabled: session != null && accountId !== undefined,
  };
}

/**
 * The account's live orders (대기·부분 체결), newest first by arrival: MY's 대기 주문 (every market)
 * and the detail's 내 대기 주문 (`marketId`). A row whose order ended — a cancel's answer, a read
 * back — is out at once (`liveRowsOnly`).
 */
export function useLiveOrders(accountId: string | undefined, marketId?: string) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery({
    ...liveOrdersQueryOptions(accountId, marketId, session),
    select: liveRowsOnly,
  });
  return gated(query, session, sessionPending);
}

/**
 * The wallet's reading of the account's live orders (#69, ADR-0144 결정 2-11): the request of
 * every market's first page (`liveOrdersQueryOptions(accountId)`) under the wallet's own key
 * (`walletLiveOrdersKey`), which the `user:position` order restart leaves out.
 */
export function walletLiveOrdersQueryOptions(accountId: string | undefined, session?: SessionLike) {
  return {
    ...liveOrdersQueryOptions(accountId, undefined, session),
    queryKey: walletLiveOrdersKey(accountId),
  };
}

/** The wallet's live orders (`walletLiveOrdersQueryOptions`), ended rows out as `useLiveOrders`. */
export function useWalletLiveOrders(accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery({
    ...walletLiveOrdersQueryOptions(accountId, session),
    select: liveRowsOnly,
  });
  return gated(query, session, sessionPending);
}

export async function fetchMyOrder(orderId: string): Promise<Order> {
  return unwrap(await api.GET('/api/v1/me/orders/{id}', { params: { path: { id: orderId } } }))
    .data;
}

/** `GET /me/orders/:id`: another account's, an unknown id and a malformed one are all refused. */
export function useOrder(orderId: string, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery({
    queryKey: myOrderKey(orderId, accountId),
    queryFn: () => fetchMyOrder(orderId),
    enabled: session != null && accountId !== undefined,
  });
  return gated(query, session, sessionPending);
}

/**
 * The order the cache holds under its detail key: what the cancel's confirmation joins with the
 * row it draws. Asked (`ask`) only while the dialog is open on an order its list no longer draws —
 * ended, or slid past the loaded pages by a newer order — so the confirmation keeps the freshest
 * reading of it; otherwise read without asking.
 */
export function useHeldOrder(
  orderId: string | undefined,
  accountId: string | undefined,
  ask: boolean,
) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: myOrderKey(orderId ?? '', accountId),
    queryFn: () => fetchMyOrder(orderId ?? ''),
    enabled: ask && session != null && orderId !== undefined && accountId !== undefined,
  }).data;
}

/** One cursor page of `GET /me/fills`, narrowed as `query` says. */
async function fetchFillsPage(
  query: { orderId?: string; marketId?: string; limit: number },
  cursor: string | undefined,
): Promise<CursorPage<MyFill>> {
  const { data, meta } = unwrap(
    await api.GET('/api/v1/me/fills', {
      params: { query: { ...query, ...(cursor === undefined ? {} : { cursor }) } },
    }),
  );
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * One order's fills, newest first, 100 at a time — asked only once its order answered (`enabled`):
 * a refused order (404, 400) sends nothing more. The API narrows by the account's own side of a
 * fill alone, so another account's order id reads nothing (ADR-0141 결정 1).
 */
export function useOrderFills(orderId: string, accountId: string | undefined, enabled: boolean) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery({
    queryKey: myOrderFillsKey(orderId, accountId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchFillsPage({ orderId: orderId.toLowerCase(), limit: ORDER_FILLS_PAGE }, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CursorPage<MyFill>) => last.nextCursor ?? undefined,
    enabled: enabled && session != null && accountId !== undefined,
  });
  return gated(query, session, sessionPending);
}

/** The account's fills on one market, newest first, 20 at a time (상세의 내 거래). */
export function useMyMarketFills(marketId: string, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery({
    queryKey: myMarketFillsKey(marketId, accountId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchFillsPage({ marketId: marketId.toLowerCase(), limit: MARKET_FILLS_PAGE }, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CursorPage<MyFill>) => last.nextCursor ?? undefined,
    enabled: session != null && accountId !== undefined,
  });
  return gated(query, session, sessionPending);
}

/** A cancel's variables: the order, the account (its key's, `expectedAccountId`), its market. */
export interface CancelVars {
  orderId: string;
  accountId: string;
  marketId: string;
}

export const CANCEL_MUTATION_KEY = ['orders', 'cancel'] as const;

/** The orders each account was told had ended, for this tab's life (`noticeOnce`). */
const NOTIFIED: NoticeLog = new Map();

/** The account `['me']` holds now: the screen's, which a notice must still be about. */
function shownAccount(queryClient: QueryClient): string | undefined {
  return queryClient.getQueryData<Me>(ME_QUERY_KEY)?.id;
}

/**
 * An order as it now stands, into its detail and every live list that holds it — each through
 * its join (query-client.ts), so a later write of an older reading changes nothing.
 */
export function storeOrder(queryClient: QueryClient, accountId: string, order: Order): void {
  queryClient.setQueryData<Order>(myOrderKey(order.id, accountId), order);
  queryClient.setQueriesData<OrderPages>({ queryKey: MY_ORDERS_LIVE_KEY }, (held) =>
    withOrderInPages(held, order),
  );
}

/**
 * Whose order toasts the screen may still show (ADR-0141 결정 2-6, ADR-0140 결정 2-25): those of
 * the account its orders are drawn for (`Me`'s id), and no other account's. MY's lists and the
 * detail stand outside the order panel's provider, and `['me']` can turn from A to B in place
 * before the session does (ADR-0090 결정 4-2) — SessionCacheGuard has not heard yet, the screen is
 * mounted afresh for B (keyed by the account), and a notice of A's order raised a moment before
 * would stay over B's rows for its few seconds. The dismissal waits a microtask
 * (`dismissAccountToastsExcept`): this is an effect.
 */
export function useOrderToastsOf(accountId: string): void {
  useEffect(() => {
    dismissAccountToastsExcept(accountId);
  }, [accountId]);
}

/**
 * The one notice an ended order gets, unless it had one (`noticeOnce`): the account's own facts
 * (its market, contract, state and quantities), so it is raised as that account's toast and goes
 * when the account leaves the screen (결정 2-6, ADR-0140 결정 2-25). After the commit
 * (`accountToastAfterCommit`): the detail raises it from an effect.
 */
function noticeEnded(queryClient: QueryClient, accountId: string, order: Order): boolean {
  if (isLiveOrder(order)) return false;
  if (!noticeOnce(NOTIFIED, accountId, order.id, shownAccount(queryClient))) return false;
  accountToastAfterCommit(accountId, { type: 'info', ...endedNotice(order) });
  return true;
}

/**
 * 주문 취소 (ADR-0141 결정 4·5): `POST /me/orders/:id/cancel` naming the account of the key. The
 * answer, the re-reads and the notice are the mutation's own options, never a per-call callback:
 * a screen left while the request runs (the row's detail opened) would drop those, and its order
 * would stay drawn 대기 with a stale lock. A notice or an error is said only while the account is
 * still the one on screen.
 *
 * What is said of the account's order — its end, and the three failures that speak of the order
 * pressed (held market, not found, result unknown) — is that account's toast
 * (`createAccountToast`), gone when it leaves the screen (결정 2-6). The three that speak of the
 * session alone stay the toaster's own: '로그인한 계정이 바뀌었습니다…' and '로그인이 풀렸습니다…' are said
 * to whoever is at the screen about the very turn that would dismiss them, and the general error
 * sentence names nothing.
 *
 * Plain options (`refetchSession` is `useSession`'s), so the unit tests drive the answers under
 * `environment: 'node'`.
 */
export function cancelOrderOptions(queryClient: QueryClient, refetchSession: () => unknown) {
  return {
    mutationKey: CANCEL_MUTATION_KEY,
    mutationFn: async (vars: CancelVars) =>
      unwrap(
        await api.POST('/api/v1/me/orders/{id}/cancel', {
          params: { path: { id: vars.orderId } },
          body: { expectedAccountId: vars.accountId },
        }),
      ).data,
    onSuccess: (order: Order, vars: CancelVars) => {
      // Written only while it is still the account on screen: a late answer for A after a turn to
      // B would leave A's order in B's session cache (ADR-0141 결정 2-5).
      if (shownAccount(queryClient) === vars.accountId) {
        storeOrder(queryClient, vars.accountId, order);
      }
      refreshAfterOwnCancel(queryClient, vars.marketId);
      noticeEnded(queryClient, vars.accountId, order);
    },
    onError: (error: unknown, vars: CancelVars) => {
      const outcome = cancelOutcomeOf({ error });
      const shown = shownAccount(queryClient) === vars.accountId;
      const readAgain = () => {
        void queryClient.invalidateQueries({ queryKey: myOrderKey(vars.orderId, vars.accountId) });
        void queryClient.invalidateQueries({ queryKey: MY_ORDERS_LIVE_KEY });
      };
      switch (outcome.kind) {
        case 'held':
          // Its market waits for a recovery: read again, the order says so and the button is off.
          readAgain();
          if (shown) {
            createAccountToast(vars.accountId, { type: 'error', title: copy.orderHeldMarket });
          }
          return;
        case 'notFound':
          void queryClient.invalidateQueries({ queryKey: MY_ORDERS_LIVE_KEY });
          if (shown) {
            createAccountToast(vars.accountId, { type: 'error', title: copy.orderNotFound });
          }
          return;
        case 'anotherAccount':
          // #66 결정 5: the cookie is somebody else's — the session and `['me']` are asked again
          // so the screen shows who is signed in; nothing is written.
          void refetchSession();
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
          if (shown) toaster.create({ type: 'error', title: copy.sessionChanged });
          return;
        case 'signedOut':
          void refetchSession();
          if (shown) toaster.create({ type: 'error', title: copy.portfolioSignedOut });
          return;
        case 'forbidden':
          if (shown) toaster.create({ type: 'error', title: copy.errUnknown });
          return;
        case 'unknown':
        case 'done':
          // Not known what became of it: the order is read again and the button is back. A
          // repeat is safe — the server answers an ended order as it is, releasing nothing. The
          // lock, the sellable and the book too: the cancel may have landed with its answer lost.
          readAgain();
          refreshAfterOwnCancel(queryClient, vars.marketId);
          if (shown) {
            createAccountToast(vars.accountId, { type: 'error', title: copy.orderCancelUnknown });
          }
          return;
      }
    },
  };
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(cancelOrderOptions(queryClient, refetchSession));
}

/**
 * The orders of `accountId` with a cancel in flight in this tab (`useMutationState`): their rows
 * say '취소 요청 중' and offer no second press. Only that account's — the mutation cache outlives
 * an account change (`resetQueries` empties queries alone).
 */
export function usePendingCancels(accountId: string | undefined): ReadonlySet<string> {
  const pending = useMutationState({
    filters: { mutationKey: CANCEL_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as CancelVars | undefined,
  });
  return new Set(
    pending
      .filter((vars): vars is CancelVars => vars !== undefined && vars.accountId === accountId)
      .map((vars) => vars.orderId.toLowerCase()),
  );
}

/**
 * The orders that left a live list while it was watched (ADR-0141 결정 6): each read back (at most
 * `ENDED_CHECK_MAX`), and only one that answers ended is written and told — a live one slid past
 * the pages, a 404 or a 403 is dropped in silence. One ended: its line; more: one line with the
 * count (or without it, past what was read) — each `accountId`'s toast, the count too: that this
 * account's orders ended is its own fact (`createAccountToast`). Each market an order told here ended on gets the
 * re-reads its end moves (`refreshAfterOwnCancel`) once — that is where `['me']`'s lock catches up.
 */
export async function confirmEnded(
  queryClient: QueryClient,
  accountId: string,
  candidates: readonly string[],
): Promise<void> {
  const ended: Order[] = [];
  await Promise.all(
    candidates.slice(0, ENDED_CHECK_MAX).map(async (orderId) => {
      const held = queryClient.getQueryData<Order>(myOrderKey(orderId, accountId));
      if (held !== undefined && !isLiveOrder(held)) {
        ended.push(held);
        return;
      }
      try {
        const order = await fetchMyOrder(orderId);
        if (isLiveOrder(order)) return;
        // A detached request: `SessionCacheGuard`'s `resetQueries` does not stop it. Written (and
        // told) only while it is still the account on screen, as the cancel's answer is — else a
        // read back that outlived a turn to B leaves A's order in B's session cache (결정 5·6).
        if (shownAccount(queryClient) !== accountId) return;
        storeOrder(queryClient, accountId, order);
        ended.push(order);
      } catch {
        // Not this account's any more, or not known: nothing to say.
      }
    }),
  );
  const shown = shownAccount(queryClient);
  const told = ended.filter((order) => noticeOnce(NOTIFIED, accountId, order.id, shown));
  if (candidates.length > ENDED_CHECK_MAX && told.length > 0) {
    createAccountToast(accountId, { type: 'info', title: endedManyText(null) });
  } else if (told.length === 1 && told[0] !== undefined) {
    createAccountToast(accountId, { type: 'info', ...endedNotice(told[0]) });
  } else if (told.length > 1) {
    createAccountToast(accountId, { type: 'info', title: endedManyText(told.length) });
  }
  // An order this tab's own cancel ended was told, and read again, by the cancel's answer.
  for (const marketId of new Set(told.map((order) => order.marketId))) {
    refreshAfterOwnCancel(queryClient, marketId);
  }
}

/**
 * The notice an order's detail gives when the order it showed live is seen ended, and the re-reads
 * its end moves — unless its own cancel's answer told it first (and read them).
 */
export function noticeEndedOnDetail(
  queryClient: QueryClient,
  accountId: string,
  order: Order,
): void {
  if (noticeEnded(queryClient, accountId, order)) {
    refreshAfterOwnCancel(queryClient, order.marketId);
  }
}
