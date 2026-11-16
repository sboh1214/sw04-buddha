'use client';

import { Alert, Box, Button, Card, Heading, Skeleton, Stack } from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useMe } from '@/hooks/use-me';
import {
  confirmEnded,
  useCancelOrder,
  useLiveOrders,
  useOrderToastsOf,
  usePendingCancels,
} from '@/hooks/use-my-orders';
import { type Order } from '@/lib/api';
import { showMoreOrders } from '@/lib/my';
import {
  type LiveBaseline,
  endedCandidates,
  rowInPlaceOf,
  showsCancelling,
  watchedReading,
} from '@/lib/my-orders';
import { listSection } from '@/lib/query-client';
import { useSession } from '@/lib/use-session';
import { OrderCancelDialog } from './order-cancel-dialog';
import { PendingOrderRow } from './pending-order-row';

/**
 * The account's live orders (#123, ADR-0141 결정 3): MY's 대기 주문 (every market, `variant` 'my')
 * and the detail's 내 대기 주문 (`marketId`, 'market'), read from the server's live list
 * (`state=live`), newest first. No 일괄 취소 (ADR-0135 E2). One confirmation for the whole list,
 * opened on an order's id (`OrderCancelDialog`).
 *
 * The parent keys it by the account it was given (`me.id`), so a turn of `['me']` to another
 * account mounts it afresh: its rows, its dialog and its baseline are that account's alone — and
 * the order toasts of the account before go as it mounts (`useOrderToastsOf`).
 *
 * While it is watched, an order that leaves the list — filled, cancelled in another tab or by an
 * account restriction or the admin role, expired, 일시 중단 — is read back and told once
 * (`confirmEnded`, ADR-0141 결정 6); what ended while the screen was away is not (the baseline is
 * the first read after it mounted, or the fresh rows the cache drew at mount).
 */
export function PendingOrders({
  accountId,
  marketId,
  variant,
  testId,
  limit,
}: {
  accountId: string;
  marketId?: string;
  variant: 'my' | 'market';
  /** The section's own test id: its stale notice, 더 보기 and its failure hang off it. */
  testId: string;
  /** A /my preview's rows (`MY_PREVIEW_ROWS`), cut from the same list and key as the tab's. */
  limit?: number;
}) {
  const queryClient = useQueryClient();
  // No other account's order toast over this account's rows (결정 2-6).
  useOrderToastsOf(accountId);
  const orders = useLiveOrders(accountId, marketId);
  const rows: Order[] = orders.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(orders, rows.length);
  const pending = usePendingCancels(accountId);
  const cancel = useCancelOrder();
  // The order the dialog is open on, as its row was drawn then: it stands in for the row should
  // a newer order push it past the loaded pages while the dialog is open.
  const [target, setTarget] = useState<Order | null>(null);
  // The row the dialog was opened from, kept past its close: the dialog hands the focus back to
  // that row's card, since 주문 취소 swaps the opening button for '취소 요청 중' and drops it.
  const focusRow = useRef<string | null>(null);

  // MY sits in the room of every market it lists (`useHoldings`' way): a fill, a pause, a close
  // and the book's signal there reach it. The detail is in its market's room already.
  const marketIds = variant === 'my' ? [...new Set(rows.map((order) => order.marketId))] : [];
  useMarketSocket(marketIds);

  // The baseline: the live ids of the last reading watched since mount, and whose. The first is a
  // read after mount, or the fresh rows the cache drew at mount (`watchedReading`); once made, it
  // follows every reading.
  const baseline = useRef<LiveBaseline | undefined>(undefined);
  const idsKey = rows.map((order) => order.id).join(',');
  const watched = watchedReading(orders);
  useEffect(() => {
    if (baseline.current === undefined && !watched) return;
    const ids = idsKey === '' ? [] : idsKey.split(',');
    const candidates = endedCandidates(baseline.current, accountId, ids);
    baseline.current = { accountId, ids };
    if (candidates.length > 0) void confirmEnded(queryClient, accountId, candidates);
  }, [idsKey, accountId, watched, queryClient]);

  // The cancel's answer takes its row out (`liveRowsOnly`) — and with it the card the dialog handed
  // the focus to, which would drop to the page's start. While nothing else took it, the focus goes
  // to the row now in its place (or the one above it), else to the list itself (`rowInPlaceOf`).
  // A row that left while its confirmation is open (filled, expired) leaves that place to the
  // dialog's close instead (`closeFocus`): the opening button went with the row, and the focus
  // would drop to the page's start. `undefined` while there is none; null is the list itself.
  const listRef = useRef<HTMLDivElement>(null);
  const closeFocus = useRef<string | null | undefined>(undefined);
  const shownRows = rows.slice(0, limit);
  const shownKey = shownRows.map((order) => order.id).join(',');
  const lastShown = useRef<readonly string[]>([]);
  useEffect(() => {
    const before = lastShown.current;
    const after = shownKey === '' ? [] : shownKey.split(',');
    lastShown.current = after;
    const row = focusRow.current;
    if (row === null || after.includes(row)) return;
    const inPlace = rowInPlaceOf(before, after, row);
    if (inPlace === undefined) return;
    focusRow.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) {
      // Taken elsewhere — the confirmation still open on that row: where its close sends it.
      closeFocus.current = inPlace;
      return;
    }
    const element =
      (inPlace === null ? null : document.getElementById(rowTestIdOf(variant, inPlace))) ??
      listRef.current;
    element?.focus();
  }, [shownKey, variant]);
  // The dialog's close reads it at that moment: the row in place may itself have left since.
  const focusTarget = (row: string | null): HTMLElement | null =>
    (row === null ? null : document.getElementById(rowTestIdOf(variant, row))) ?? listRef.current;

  const open = target === null ? undefined : rows.find((order) => order.id === target.id);
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
    <Box ref={listRef} tabIndex={-1} outline="none">
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
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void orders.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' && !orders.hasNextPage ? (
        <EmptyState
          message={
            variant === 'my' ? copy.portfolioPendingOrdersEmpty : copy.marketMyOpenOrdersEmpty
          }
          data-testid={`${testId}-empty`}
        />
      ) : (
        <Stack gap="2">
          {shownRows.map((order) => {
            const inFlight = pending.has(order.id.toLowerCase());
            return (
              <PendingOrderRow
                key={order.id}
                order={order}
                testId={rowTestIdOf(variant, order.id)}
                showMarket={variant === 'my'}
                cancelling={showsCancelling(inFlight, order)}
                cancelDisabled={inFlight}
                onCancel={() => {
                  focusRow.current = order.id;
                  closeFocus.current = undefined;
                  setTarget(order);
                }}
              />
            );
          })}
          {more}
        </Stack>
      )}
      <OrderCancelDialog
        orderId={target?.id ?? null}
        accountId={accountId}
        order={open}
        opened={target ?? undefined}
        onClose={() => {
          setTarget(null);
        }}
        finalFocusEl={() => {
          if (focusRow.current !== null) {
            return document.getElementById(rowTestIdOf(variant, focusRow.current));
          }
          // Its row left while it was open: the row now in its place, else the list.
          return closeFocus.current === undefined ? null : focusTarget(closeFocus.current);
        }}
        onConfirm={(order) => {
          setTarget(null);
          cancel.mutate({ orderId: order.id, accountId, marketId: order.marketId });
        }}
      />
    </Box>
  );
}

/** A row's test id and DOM id: MY keeps the old list's, the detail names its own. */
function rowTestIdOf(variant: 'my' | 'market', orderId: string): string {
  return variant === 'my' ? `portfolio-order-${orderId}` : `market-my-order-${orderId}`;
}

/**
 * 내 대기 주문 on the market detail (#123, ADR-0141; ADR-0135 결과 4 #123): this market's live orders
 * of the account, the rows MY draws without their market line. A signed-in reader's only: nothing
 * for a visitor or while the session is not known (the detail's one sign-in prompt stands for it),
 * so none of it is in the server's HTML. Keyed by the account `['me']` holds (`PendingOrders`).
 */
export function MarketMyOpenOrders({ marketId }: { marketId: string }) {
  const { data: session } = useSession();
  const me = useMe();
  const accountId = me.data?.id;
  if (session == null) return null;
  return (
    <Card.Root data-testid="market-my-open-orders">
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketMyOpenOrders}
        </Heading>
      </Card.Header>
      <Card.Body>
        {accountId === undefined ? (
          me.isPending || me.isFetching ? (
            <Skeleton height="12" />
          ) : (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errProfileLoad}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
                {copy.retry}
              </Button>
            </Stack>
          )
        ) : (
          <PendingOrders
            key={accountId}
            accountId={accountId}
            marketId={marketId}
            variant="market"
            testId="market-my-open-orders"
          />
        )}
      </Card.Body>
    </Card.Root>
  );
}
