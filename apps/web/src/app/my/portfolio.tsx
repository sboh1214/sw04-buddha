'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type OrderStatus, isLiveOrderStatus, parseCoinAmount } from '@buddha/shared';
import { useQueries } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { OrderDetail } from '@/components/orders/order-detail';
import { PendingOrders } from '@/components/orders/pending-orders';
import { AccountBlockLine } from '@/components/position/account-block-line';
import {
  HoldingMarketGroup,
  NO_HOLDING_DISPLAY,
  type SellAccount,
} from '@/components/position/holding-rows';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { listSection, listView, profileView } from '@/lib/query-client';
import { useAccountBlock } from '@/hooks/use-account-block';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { holdingMarketQueryOptions } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import {
  type ListState,
  dedupeAcrossLists,
  heldGroups,
  holdingDisplay,
  listState,
  markToLiveMarket,
  orderAveragePriceBp,
  priceIsStale,
  portfolioTotals,
  realizedPnlAcross,
  realizedPnlState,
  useOrders,
  usePositions,
} from '@/hooks/use-portfolio';
import { useSellableReadings } from '@/hooks/use-sellable-readings';
import { type Market, type Order, type Position } from '@/lib/api';
import {
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  formatContracts,
  formatPricePerContract,
} from '@/lib/market-admin';
import { MY_ORDERS_PATH, myOrderPath, orderHistoryEmpty, showMoreOrders } from '@/lib/my';
import { orderReasonName, orderStatusLabel } from '@/lib/order-reasons';
import { ProfileUnavailable } from './settings/profile-unavailable';

/**
 * The old `/portfolio`'s four sections, moved into MY (#16) without being redrawn: 잔고 요약 on
 * the summary (`/my`), 보유 포지션 as 보유 계약 (`/my/positions`), 주문 이력 split by state into
 * 대기 주문 (`/my/orders`) and, with 정산 이력, 거래·정산 이력 (`/my/history`). Every one of them
 * is personal and client-only. The summary shows the first `MY_PREVIEW_ROWS` of each list through
 * the same bodies (`limit`), so a preview cannot read differently from its tab.
 *
 * Not one number here is computed in this file: `markPriceCoin`, `positionValueCoin`,
 * `unrealizedPnlCoin`, `averageCostBp` and `portfolioTotals` (use-portfolio.ts) own the
 * arithmetic, in `bigint` over the wire's decimal strings. The rule is not tidiness — a NO
 * contract is worth the COMPLEMENT of the market's YES price, and a second copy of that formula
 * is a silent error that produces a plausible number wrong by 100 − 2·price per contract. The
 * same helpers draw 내 포지션 on the detail (my-position.tsx), so the two screens cannot disagree
 * about one row — and since #67 the same row component (`HoldingRow`, holding-rows.tsx).
 *
 * Each section holds its own query and therefore its own ladder — skeleton, error + 다시 시도,
 * empty, rows — because they fail independently: a failed 주문 이력 must not blank the holdings.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
const EMPTY = '—';

/** Colour only reinforces the label: brand once it is done, `no` only for a refusal. */
const ORDER_STATUS_PALETTE: Record<OrderStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  open: 'gray',
  partially_filled: 'orange',
  filled: 'brand',
  cancelled: 'gray',
  expired: 'gray',
  rejected: 'no',
};

/**
 * Whether the session ended while this screen stayed mounted — another tab signed out, the
 * session expired, or the reader signed out from here and the navigation has not landed yet. MY's
 * session gate is server-side and runs only on navigation, so nothing else moves them off it.
 * Without this, the screen blamed a profile load that never failed AND every list reported an
 * empty account: `listView` answers `ready` for a reset, disabled query holding no rows. One
 * page-level fact, gated once per screen, rather than the same session patched into every ladder.
 */
export function useSessionEnded(): boolean {
  const me = useMe();
  return (
    profileView({
      isLoggedIn: me.isLoggedIn,
      isPending: me.isPending,
      isFetching: me.isFetching,
      hasProfile: me.data !== undefined,
    }) === 'signedOut'
  );
}

/** The signed-out rung of a MY screen: what happened, and the way back to the same screen. */
export function SessionEnded() {
  const pathname = usePathname();
  return (
    <Card.Root data-testid="my-signed-out">
      <Card.Body>
        <EmptyState
          message={copy.portfolioSignedOut}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href={{ pathname: '/login', query: { next: pathname } }}>
                {copy.login}
              </NextLink>
            </Button>
          }
        />
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The holdings of MY's account, each marked to its market's LIVE price and status (#67, ADR-0142).
 *
 * Both lists are keyed by the account (`accountId`, `Me`'s id) and wait for it. The open rows are
 * marked and kept whole for the totals (`markedAll`: every open row, sold-out ones included, with
 * the contracts the settled list already holds left out — `dedupeAcrossLists`), and grouped for
 * the screen (`groups`: held at 1 or more, one per market, the latest change first — F4·F7).
 *
 * Every market held at 1 or more is joined for as long as this is mounted, so the gateway pushes
 * `market:tick` for each and the `['market', id]` entries below — the SAME entries the detail and
 * the home grid keep — re-render with the new price; one request per market at most. A sold-out
 * row needs no price (its value is 0), so its market is neither joined nor read — and a tick
 * published meanwhile is missed, so the `user:position` that takes it back to 1 or more marks the
 * entry stale and the observer mounted again here reads it (`positionReopensMarket`). `useQueries`
 * rather than a hook per row because the totals and the rows have to be read against ONE price.
 * Each row is read through `holdingMarketQueryOptions`: the detail's entry and request, without
 * the detail's 5-second settlement poll (MY draws no payout-delay record), and re-read on focus
 * only for a 거래 마감 or 잠정 결과 market (or one with no row yet) — the rest come with the
 * positions list that focus re-reads (ADR-0142 결정 2-22).
 *
 * 매도 가능 and 매도 잠금 read `GET /me/markets/:id/sellable` for the groups drawn: all of them on
 * `/my/positions`, the preview's `groupLimit` on `/my` (`useSellableReadings`), through MY's queue
 * (`SELLABLE_PACE`: 10 at once, 20 a minute), so a cold screen of many markets stays in budget.
 */
export function useHoldings(accountId: string | undefined, groupLimit?: number) {
  const open = usePositions('open', accountId);
  const settled = usePositions('settled', accountId);
  const openRows = dedupeAcrossLists(open.data ?? [], settled.data);
  // Distinct: one market carries at most a YES row and a NO row, and both mark to one price.
  const held = openRows.filter((row) => row.qty >= 1);
  const marketIds = [...new Set(held.map((row) => row.marketId))];
  useMarketSocket(marketIds);
  const markets = useQueries({ queries: marketIds.map((id) => holdingMarketQueryOptions(id)) });
  const live = new Map<string, Market>();
  for (const market of markets) {
    if (market.data !== undefined) live.set(market.data.id, market.data);
  }
  // The price with its time, and the status, from the row the socket keeps live — each ordered
  // against the list's own copy on its key (`markToLiveMarket`).
  const markedAll = openRows.map((row) => markToLiveMarket(row, live.get(row.marketId)));
  const groups = heldGroups(markedAll);
  const drawn = groupLimit === undefined ? groups : groups.slice(0, groupLimit);
  const sellable = useSellableReadings({
    accountId,
    marketIds: drawn.map((group) => group.marketId),
    positions: drawn.flatMap((group) => group.rows),
    list: open,
    // One read per held market: through MY's queue, so 50 of them never go at once (ADR-0142).
    paced: true,
  });
  return {
    open,
    settled,
    markedAll,
    groups,
    sellable,
    /**
     * Each market's display flags as its live row reads them — '판정 지연' (`judgementDelayed`, #22,
     * ADR-0098; a held 잠정 결과 past its deadline too, #175) and '이의 검토 중' (`disputeUnderReview`,
     * #175, ADR-0104): a holding row has no such flag of its own, so its status badge takes them
     * from the same live row its status is marked from — only when that row is of the status the
     * holding shows. A market with no live row yet reads its status alone (`holdingDisplay`).
     */
    display: new Map(
      markedAll.map((row) => [
        row.marketId,
        holdingDisplay(live.get(row.marketId), row.marketStatus),
      ]),
    ),
    /**
     * Whether any market price behind these holdings has stopped being refreshed. The reading
     * itself is `priceIsStale` (use-portfolio.ts) — a node-only runner cannot reach a decision
     * left in this body, and the state this notice must cover was got wrong once already.
     */
    marketsStale: markets.some((market) => priceIsStale(market)),
    /** Re-asks only the ones that failed; a healthy row is already live off the socket. */
    retryStaleMarkets: () => {
      for (const market of markets) {
        if (priceIsStale(market)) void market.refetch();
      }
    },
  };
}

type Holdings = ReturnType<typeof useHoldings>;
type OrderList = ReturnType<typeof useOrders>;

/** The account line's id on MY: the '매도' it turns off point at it (D13). */
const PORTFOLIO_ACCOUNT_LINE_ID = 'portfolio-account-blocked';

/**
 * D13 on MY (#67, ADR-0142): whether MY's account may order, for the holdings' '매도' — off while
 * `me` or its restriction has not answered, so it never flashes on — and the element that says why.
 * `describedBy` is the caller's: the tab draws the account line, the summary its banner.
 */
export function useSellAccount(
  describedBy: (account: SellAccount['account']) => string | undefined,
) {
  const me = useMe();
  const block = useAccountBlock(me.data);
  const sellAccount: SellAccount = {
    account: block.account,
    accountKnown: me.data !== undefined && block.restrictionSettled,
    describedBy: describedBy(block.account),
  };
  return { ...block, sellAccount };
}

/**
 * `/my/positions`: 보유 계약 (#67, ADR-0142) — 잔고 요약 above the list as on `/my` (ADR-0135 결과
 * 4), D13's account line once, then every market held at 1 contract or more.
 */
export function MyPositions() {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  const holdings = useHoldings(accountId);
  // The line is drawn for a blocked account alone: before that, nothing to point at.
  const block = useSellAccount((account) =>
    account === null ? undefined : PORTFOLIO_ACCOUNT_LINE_ID,
  );
  if (ended) return <SessionEnded />;
  return (
    <Stack gap="6">
      <BalanceSummary holdings={holdings} />
      <Section title={copy.myPositions} testId="portfolio-positions">
        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <Stack gap="4">
            <AccountBlockLine
              id={PORTFOLIO_ACCOUNT_LINE_ID}
              account={block.account}
              restrictionEndsAt={block.restrictionEndsAt}
              testId="portfolio-account-blocked"
            />
            <PositionsBody holdings={holdings} sellAccount={block.sellAccount} />
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

/**
 * `/my/orders`: 대기 주문 (#123, ADR-0141) — the server's live list (`state=live`), every market's,
 * with 주문 취소 and '취소 요청 중' on each row (`PendingOrders`). The list is the account's MY
 * shows (`Me`'s id, ADR-0091), so it waits for `GET /me` and is keyed by it.
 */
export function MyOrders() {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myOrders} testId="my-orders">
      <LivePendingOrders accountId={accountId} testId="my-orders" />
    </Section>
  );
}

/**
 * The live list for MY's account, or `GET /me`'s wait or failure while that account is not known
 * (`ProfileUnavailable`). Shared by the tab and the summary's preview (`limit`), one key for both.
 */
export function LivePendingOrders({
  accountId,
  testId,
  limit,
}: {
  accountId: string | undefined;
  testId: string;
  limit?: number;
}) {
  if (accountId === undefined) return <ProfileUnavailable height="24" />;
  return (
    <PendingOrders
      key={accountId}
      accountId={accountId}
      variant="my"
      testId={testId}
      {...(limit === undefined ? {} : { limit })}
    />
  );
}

/**
 * `/my/orders/<id>`: 주문 상세 (#123, ADR-0141) — one of the account's orders in any state
 * (`OrderDetail`), under 대기 주문's tab. Keyed by MY's account like the lists.
 */
export function MyOrderDetail({ orderId }: { orderId: string }) {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  if (ended) return <SessionEnded />;
  if (accountId === undefined) return <ProfileUnavailable height="48" />;
  return <OrderDetail key={accountId} orderId={orderId} accountId={accountId} />;
}

/** `/my/history`: 거래·정산 이력, the old 정산 이력 and the rest of the old 주문 이력. */
export function MyHistory() {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  const settled = usePositions('settled', accountId);
  const orders = useOrders();
  if (ended) return <SessionEnded />;
  return (
    <Stack gap="6">
      <Section title={copy.portfolioSettled} testId="portfolio-settled">
        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <SettledBody settled={settled} />
        )}
      </Section>
      <Section title={copy.portfolioOrders} testId="my-order-history">
        <OrdersBody orders={orders} kind="history" />
      </Section>
    </Stack>
  );
}

/**
 * 잔고 요약: 가용 코인 and 주문 잠금 코인 (H6), and the totals over the holdings — 총 참고 평가, 총
 * 미실현 손익, 총 실현 손익 (ADR-0135 결과 4) and no 총 자산 line (F5). `/my` and `/my/positions`
 * draw it once each, the same.
 *
 * 총 참고 평가/미실현 손익 come from the open holdings alone — settlement writes no price, so a
 * settled market's `lastPrice` is the last price something traded at, not the 100/0 it resolved
 * to, and marking those rows to it would be fiction. 총 실현 손익 is 실현 + 정산 (결정 4) and spans
 * BOTH lists, because selling books the profit where the row already is (`realizedPnlAcross`).
 * Every open row counts, a sold-out one too (`markedAll`): the screen draws only the held ones
 * (F4), and a drawn row's 참고 평가 adds up to the total because a sold-out row's is 0.
 */
export function BalanceSummary({ holdings }: { holdings: Holdings }) {
  const me = useMe();
  const balanceView = profileView({
    isLoggedIn: me.isLoggedIn,
    isPending: me.isPending,
    isFetching: me.isFetching,
    hasProfile: me.data !== undefined,
  });
  const { open, settled } = holdings;
  const openTotals = portfolioTotals(holdings.markedAll);
  const settledTotals = portfolioTotals(settled.data);
  // Both lists, and neither behind the other nor stale (`realizedPnlState`): a settlement read
  // open-first drops the row from both for a moment, and a failed refetch would keep it dropped.
  const realizedState = realizedPnlState(open, settled);

  return (
    <Section title={copy.portfolioBalance} testId="portfolio-balance">
      {balanceView === 'pending' ? (
        <Skeleton height="24" />
      ) : !me.data ? (
        <LoadFailed message={copy.errProfileLoad} onRetry={() => void me.refetch()} />
      ) : (
        <Stack gap="4">
          <Stack gap="1">
            <Text fontSize="sm" color="fg.muted">
              {copy.walletBalance}
            </Text>
            <CoinText
              as="p"
              fontSize="3xl"
              fontWeight="bold"
              amount={parseCoinAmount(me.data.balance.availableCoin)}
              data-testid="portfolio-available"
            />
            <HStack gap="2" color="fg.muted" fontSize="sm">
              <Text>{copy.walletLocked}</Text>
              <CoinText
                amount={parseCoinAmount(me.data.balance.lockedCoin)}
                data-testid="portfolio-locked"
              />
            </HStack>
          </Stack>
          <DataList.Root orientation="horizontal" size="sm">
            <Total label={copy.portfolioValue} state={listState(open)} testId="portfolio-value">
              <CoinText amount={openTotals.valueCoin} />
            </Total>
            <Total
              label={copy.portfolioUnrealizedPnl}
              state={listState(open)}
              testId="portfolio-unrealized"
            >
              <Signed amount={openTotals.unrealizedPnlCoin} />
            </Total>
            <Total
              label={copy.portfolioRealizedPnl}
              state={realizedState}
              testId="portfolio-realized"
              onRetry={() => {
                void open.refetch();
                void settled.refetch();
              }}
            >
              <Signed amount={realizedPnlAcross(openTotals, settledTotals)} />
            </Total>
          </DataList.Root>
        </Stack>
      )}
    </Section>
  );
}

/**
 * 보유 계약's list (#67, ADR-0142): the markets held at 1 contract or more, each a group of its
 * held contracts (`HoldingMarketGroup`), the latest change first — `limit` groups on `/my`. A
 * sold-out contract is not here (F4): its 실현 손익 is in 총 실현 손익. So an account that has
 * traded and holds nothing says '보유한 계약이 없습니다.'.
 *
 * `stale` is the state the ladder used to fold into `ready`: a refetch that fails after the rows
 * exist keeps them and reports `isRefetchError`, and on THIS list that silence has a shape — a
 * settlement asks for both lists (`applyPositionEvent` answers `refetch` when a row must MOVE), so
 * a failed refresh leaves the holding here, out of 정산 이력, and inside 총 참고 평가 where it no
 * longer belongs. The rows stay on screen and the notice says so; see `listView`.
 */
export function PositionsBody({
  holdings,
  sellAccount,
  limit,
}: {
  holdings: Holdings;
  sellAccount: SellAccount;
  limit?: number;
}) {
  const { open, groups } = holdings;
  const openView = listView(open);
  return (
    <>
      {holdings.marketsStale && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-markets-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          {/* The holdings stay on screen behind this — dropping them because one price failed
              loses more than the staleness costs — so the retry is an action beside the notice
              rather than the `LoadFailed` ladder the other sections use, which replaces what it
              reports on. */}
          <Button size="xs" variant="outline" ml="auto" onClick={holdings.retryStaleMarkets}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {openView === 'stale' && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-positions-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void open.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {openView === 'pending' ? (
        <Skeleton height="24" />
      ) : openView === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void open.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          message={copy.portfolioPositionsEmpty}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href="/">{copy.tradeCta}</NextLink>
            </Button>
          }
        />
      ) : (
        <Stack gap="3">
          {groups.slice(0, limit).map((group) => (
            <HoldingMarketGroup
              key={group.marketId}
              group={group}
              display={holdings.display.get(group.marketId) ?? NO_HOLDING_DISPLAY}
              sellables={(outcome) => {
                const row = group.rows.find((r) => r.outcome === outcome);
                return holdings.sellable.reading(group.marketId, outcome, row?.qty ?? 0);
              }}
              onRetrySellable={() => {
                holdings.sellable.retry(group.marketId);
              }}
              sellAccount={sellAccount}
            />
          ))}
        </Stack>
      )}
    </>
  );
}

/** 정산 이력's list, with the same `stale` notice for the same reason (see `PositionsBody`). */
export function SettledBody({ settled, limit }: { settled: Holdings['settled']; limit?: number }) {
  const settledView = listView(settled);
  const rows = settled.data ?? [];
  return (
    <>
      {settledView === 'stale' && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-settled-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void settled.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {settledView === 'pending' ? (
        <Skeleton height="24" />
      ) : settledView === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void settled.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={copy.portfolioSettledEmpty} />
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((row) => (
            <SettledPositionRow key={`${row.marketId}-${row.outcome}`} position={row} />
          ))}
        </Stack>
      )}
    </>
  );
}

/**
 * One side of the old 주문 이력: `pending` is 대기 주문 (`isLiveOrderStatus`, the shared live
 * statuses since #67), `history` every other state.
 *
 * Both read the ONE `GET /me/orders` list and split it here — the route's `state` filter (#119)
 * waits for the tabs' own issues: a page can hold none of one side's rows while older pages still
 * do. So an empty side says it is empty only once the list has no further page, and offers 더 보기
 * until then (a /my preview until it has its rows, `showMoreOrders`) — which is also the only
 * moment 거래·정산 이력 can tell an account that never ordered from one whose every order is still 대기
 * (`orderHistoryEmpty`). 대기 주문 itself is the server's live list since #123 (`PendingOrders`,
 * ADR-0141); the history's split moves to the server with #124.
 *
 * The list has no reducer and no event of its own — `restartQueries(queryClient, ORDERS_KEY)`
 * (realtime-provider.tsx) is the ONLY path a new order arrives by, so a failed refresh is a list
 * one row short. On an account with no prior orders it is worse than short: the section
 * positively says it has none about an order the balance already shows. Hence `listSection`,
 * which keeps the empty rung and puts the notice ABOVE it rather than in place of it.
 */
export function OrdersBody({
  orders,
  kind,
  limit,
}: {
  orders: OrderList;
  kind: 'pending' | 'history';
  limit?: number;
}) {
  const all = orders.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = all.filter((order) => isLiveOrderStatus(order.status) === (kind === 'pending'));
  const section = listSection(orders, rows.length);
  const testId = kind === 'pending' ? 'my-orders' : 'my-order-history';
  const more = showMoreOrders(orders.hasNextPage, rows.length, limit) && (
    <>
      {/* A 더 보기 that failed: the rows stay, the message above the button that asks again (owner
          decision 2026-10-20 7). */}
      <LoadMoreFailed
        list={orders}
        message={copy.errUnknown}
        data-testid={`${testId}-more-failed`}
      />
      <Button
        alignSelf="center"
        size="sm"
        variant="ghost"
        mt="1"
        loading={orders.isFetchingNextPage}
        onClick={() => void orders.fetchNextPage()}
        data-testid={`${testId}-more`}
      >
        {copy.loadMore}
      </Button>
    </>
  );
  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid={`${testId}-stale`} mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void orders.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void orders.refetch()} />
      ) : section.body === 'empty' && !orders.hasNextPage ? (
        kind === 'pending' ? (
          <EmptyState message={copy.portfolioPendingOrdersEmpty} />
        ) : (
          <OrderHistoryEmpty pendingOnly={orderHistoryEmpty(all) === 'pendingOnly'} />
        )
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
          {more}
        </Stack>
      )}
    </>
  );
}

/**
 * 거래·정산 이력's 주문 이력 with no row, in the owner's two wordings (`orderHistoryEmpty`): an
 * account that has never ordered is told so, and one with only 대기 orders is told none has
 * finished and where those are — a link to 대기 주문, the line's one next step.
 */
function OrderHistoryEmpty({ pendingOnly }: { pendingOnly: boolean }) {
  if (!pendingOnly) return <EmptyState message={copy.portfolioOrdersEmpty} />;
  return (
    <EmptyState
      message={copy.portfolioOrderHistoryEmpty}
      action={
        <Text color="fg.muted">
          {copy.portfolioPendingOrdersHintBefore}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink href={MY_ORDERS_PATH}>{copy.myOrders}</NextLink>
          </ChakraLink>
          {copy.portfolioPendingOrdersHintAfter}
        </Text>
      }
    />
  );
}

/**
 * 정산 이력 한 줄: 결과 and 실현 손익 only.
 *
 * No 평가 금액 and no 평가손익 — the holding is gone and the payout has already landed in the
 * balance, so `realizedPnlCoin` is the whole story. 결과 is a word rather than a coloured badge
 * because the row already carries the account's own side as one; two colours side by side would
 * be read as agreement or disagreement, which is exactly what the PnL states in numbers.
 */
function SettledPositionRow({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const result = position.resolvedResult;
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`portfolio-settled-${position.marketId}-${position.outcome}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <MarketLink slug={position.marketSlug} title={position.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        {position.marketStatus !== 'settled' && (
          <Badge colorPalette={MARKET_STATUS_PALETTE[position.marketStatus]} variant="subtle">
            {MARKET_STATUS_LABEL[position.marketStatus]}
          </Badge>
        )}
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        {/* YES·NO·무효; a cancelled market ended with no result at all, so it has none to name. */}
        <Item label={copy.marketResolvedResult}>
          {result === null ? EMPTY : MARKET_RESULT_LABEL[result]}
        </Item>
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={parseCoinAmount(position.realizedPnlCoin)} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * 주문 이력 한 줄. `filledQty` and `filledAmountCoin` are what the order actually did (#119: Coin at
 * its own side's prices) and the 평균가 is the one over the other (`orderAveragePriceBp`); a refused
 * or unfilled order has none of them, so the state badge is what explains the row. A market sent
 * back to a draft (#78 되돌리기, ADR-0099) reaches the row with no slug or title, and its line says
 * only '공개되지 않은 시장' — no title or link — until the market is public again.
 *
 * An ended order's reason by its short name (ADR-0140 넘긴 것 #123: 거절's eleven, 취소 완료's
 * seven) and 상세, the way to its 주문 상세 (#123, ADR-0141) — 대기 주문 lets an ended order go at
 * once. #124 rebuilds the history's rows and keeps the link.
 */
export function OrderRow({ order }: { order: Order }) {
  const yes = order.outcome === 'YES';
  const average = orderAveragePriceBp(order);
  const reason = orderReasonName(order);
  const formatDateTime = useFormatDateTime();
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`portfolio-order-${order.id}`}
    >
      <HStack gap="2" flexWrap="wrap">
        {order.marketSlug === null || order.marketTitle === null ? (
          <Text fontWeight="semibold" color="fg.muted" data-testid="portfolio-order-market-hidden">
            {copy.postMarketNotPublic}
          </Text>
        ) : (
          <MarketLink slug={order.marketSlug} title={order.marketTitle} />
        )}
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{order.side === 'buy' ? copy.buy : copy.sell}</Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.orderStatus}>
          <Badge colorPalette={ORDER_STATUS_PALETTE[order.status]} variant="subtle">
            {orderStatusLabel(order.status)}
          </Badge>
        </Item>
        {reason !== null && (
          <Item label={copy.orderReason} testId="portfolio-order-reason">
            {reason}
          </Item>
        )}
        <Item label={copy.fillQty}>{formatContracts(order.filledQty)}</Item>
        <Item label={copy.fillAvgPrice}>
          {average === undefined ? EMPTY : formatPricePerContract(average)}
        </Item>
        <Item label={copy.orderAmount}>
          {average === undefined ? (
            EMPTY
          ) : (
            <CoinText amount={parseCoinAmount(order.filledAmountCoin)} />
          )}
        </Item>
        <Item label={copy.orderCreatedAt}>{formatDateTime(order.createdAt)}</Item>
      </DataList.Root>
      <ChakraLink
        asChild
        fontSize="sm"
        colorPalette="brand"
        color="colorPalette.fg"
        alignSelf="flex-start"
      >
        <NextLink href={myOrderPath(order.id)} data-testid="portfolio-order-detail">
          {copy.orderDetail}
        </NextLink>
      </ChakraLink>
    </Stack>
  );
}

/**
 * One card with its own heading, so each section is a landmark a screen reader can jump to. A
 * preview on the summary passes `href`, its tab, for the 전체 보기 beside the heading. `headingAs`
 * is `h4` on a page that names itself with an `h3` under MY's `h2` (조치·신고 내역, which is no
 * tab to name it).
 */
export function Section({
  title,
  testId,
  href,
  headingAs = 'h3',
  children,
}: {
  title: string;
  testId: string;
  href?: Route;
  headingAs?: 'h3' | 'h4';
  children: ReactNode;
}) {
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <HStack justify="space-between" gap="3">
          <Heading as={headingAs} size="md">
            {title}
          </Heading>
          {href !== undefined && (
            <ChakraLink
              asChild
              fontSize="sm"
              colorPalette="brand"
              color="colorPalette.fg"
              flexShrink="0"
            >
              {/* Named after its section: the summary has one "전체 보기" per preview. */}
              <NextLink href={href} aria-label={`${title} ${copy.myViewAll}`}>
                {copy.myViewAll}
              </NextLink>
            </ChakraLink>
          )}
        </HStack>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}

/**
 * The whole market is the destination, and `as Route` rather than a bare template literal: the
 * `/markets/[slug]` route lands with the detail screen, and typedRoutes only accepts the literal
 * once that directory exists in the generated route map (market-card.tsx does the same).
 */
function MarketLink({ slug, title }: { slug: string; title: string }) {
  return (
    <ChakraLink asChild fontWeight="semibold">
      <NextLink href={`/markets/${slug}` as Route}>{title}</NextLink>
    </ChakraLink>
  );
}

/** The list ladder's error rung: what failed, and the one button that retries it. */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Stack gap="2" align="flex-start">
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </Stack>
  );
}

/**
 * A summary figure that depends on a list the balance card does not own: a skeleton while that
 * list loads, and a dash if it failed. Never a 0 Coin — the section below already carries the error
 * and its 다시 시도, and a zero here would read as "you hold nothing" instead of "not known".
 * `onRetry` puts a 다시 시도 beside the dash, for a figure whose list no section on the screen
 * reports on — 총 실현 손익 reads 정산 이력, which `/my/positions` does not draw.
 */
function Total({
  label,
  state,
  testId,
  onRetry,
  children,
}: {
  label: string;
  state: ListState;
  testId: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <Item label={label} testId={testId}>
      {state === 'ready' ? (
        children
      ) : state === 'pending' ? (
        <Skeleton height="5" width="20" />
      ) : onRetry === undefined ? (
        EMPTY
      ) : (
        <HStack gap="2">
          <Text as="span">{EMPTY}</Text>
          <Button size="2xs" variant="outline" onClick={onRetry} data-testid={`${testId}-retry`}>
            {copy.retry}
          </Button>
        </HStack>
      )}
    </Item>
  );
}

/**
 * A gain or a loss. `formatCoin` writes a loss with U+2212 (PLAN 11.1-6), so the colour only
 * repeats what the sign already says — and at exactly 0 it stays on the ordinary foreground
 * rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <CoinText amount={amount} />;
  return (
    <CoinText amount={amount} colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg" />
  );
}

function Item({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue data-testid={testId}>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}
