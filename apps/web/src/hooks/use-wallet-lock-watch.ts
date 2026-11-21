'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  type LockBaseline,
  liveBuysReading,
  lockWatchStep,
  refreshLockedBalance,
} from '@/lib/wallet';
import { watchedReading } from '@/lib/my-orders';
import { useMarketSocket } from './use-market-socket';
import { useWalletLiveOrders } from './use-my-orders';

/**
 * The wallet's 주문 잠금 코인 kept up with the account's live buys (#69, ADR-0144 결정 2-11; ADR-0135 결과 4:
 * read again after the book's signal, no new server or realtime contract). A lock alone publishes
 * no `user:` event (ADR-0112 결정 8) — a batch's inbox signal `user:notification` (#134, ADR-0158)
 * re-reads the inbox alone — so a buy cancelled in another tab, by an account restriction or the
 * admin role, or expired at the close would leave the card behind.
 *
 * The wallet reads the account's live orders — every market's first page of 100
 * (`WALLET_LIVE_ORDERS_PAGE`, #302, ADR-0146; the lists' 20 left a buy past the newest 20 out),
 * under its own key (`useWalletLiveOrders`, `['orders', 'live', 'wallet', accountId]`) — and sits
 * in the room of every market on it (`useMarketSocket`, 대기 주문's way). The key is under
 * `['orders', 'live']`, so the provider's `market:book` round reads it again through its window
 * (`bookRestartsOwnOrders` → `refreshOwnOrders`, ADR-0141 결정 10), and `market:status`, a reconnect
 * and the session reset reach it by prefix (the `market:status` first-read branch takes its
 * `'wallet'` scope beside `'all'`). The `user:position` order restart leaves it out while it is on
 * screen, and only marks it stale off screen (`positionRestartsOrder`): a fill's own `user:balance`
 * already carries the lock, and a read per fill of a buy already listed bought nothing but requests
 * (ADR-0144 결정 6, the 2026-11-17 measurement). A fill in a market the list does not hold — a buy
 * another tab placed, which rests without a `user:` event — is the one this tab may hear of first,
 * so it asks for one book round (`walletMissesMarket`): the wallet then joins that room, where the
 * buy's cancel or expiry is signalled.
 *
 * Each new reading's live buy ids are compared with the last one watched (`lockWatchStep`, from a
 * baseline made by `watchedReading`'s rule); when they differ `['me']` is read again once
 * (`refreshLockedBalance`). The ids alone: an order's size is fixed at intake, so a buy whose
 * remaining quantity alone moved was filled, and that fill's `user:balance` brought the lock. No
 * notice, and no request while nothing changed.
 */
export function useWalletLockWatch(accountId: string | undefined): void {
  const queryClient = useQueryClient();
  const orders = useWalletLiveOrders(accountId);
  const rows = orders.data?.pages[0]?.items ?? [];
  useMarketSocket(rows.map((order) => order.marketId));
  const buys = liveBuysReading(rows);
  const watched = watchedReading(orders);
  const baseline = useRef<LockBaseline | undefined>(undefined);
  useEffect(() => {
    if (accountId === undefined) return;
    const step = lockWatchStep(baseline.current, accountId, buys, watched);
    baseline.current = step.baseline;
    if (step.read) refreshLockedBalance(queryClient);
  }, [accountId, buys, watched, queryClient]);
}
