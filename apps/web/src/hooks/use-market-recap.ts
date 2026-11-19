'use client';

import type { MarketStatus } from '@buddha/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { mySettlementsKey } from '@/lib/market-keys';
import { cancelEarlierRecordReads, recordsStaleTime } from '@/lib/market-recap';
import { historyListFilters } from '@/lib/my-history';
import { useSession } from '@/lib/use-session';
import { settlementHistoryQueryOptions } from './use-my-history';

/**
 * The account's settlement records of ONE market, for the detail's 내 포지션 once it has paid out
 * (#34, ADR-0145; ADR-0135 I1). The same entry as MY's `/my/history?kind=settlements&market=`
 * (`mySettlementsKey`): one copy of the list, dehydrated never (`settlements` is a private root),
 * read again on a settling `user:position` (`ownSettlementKeys`) and on a reconnect's snapshot.
 *
 * On only while the market is `settled`: a record is written in the payout's own transaction, so
 * before it there is none, and a cancelled market never has one. The entry is shared, so a list
 * MY's history cached before the payout may still be there, fresh, and the recap decides nothing
 * from it: `mountedAt` is when this card mounted, and only a list written at or after it is a
 * reading (`recordsReadingOf` — `isFetchedAfterMount` also counts a failed read).
 *
 * A read already in flight at the mount is no reading either: it began before the mount, perhaps
 * before the payout, and the mount's read would join it rather than ask. So on mount, and when the
 * query turns on, the card first cancels it (`cancelEarlierRecordReads`). That effect is declared
 * BEFORE the query on purpose: passive effects run in hook order, so it runs before `useBaseQuery`
 * subscribes (the mount's read) and before its `setOptions` (the query turning on). It cancels on a
 * mount while the query is still off too, so a pre-payout read cannot land between the mount and
 * the query turning on and pass as this mount's list.
 *
 * - `refetchOnMount: 'always'`: a card mounted on a paid-out market reads once.
 * - `staleTime` (`recordsStaleTime`): stale until a list is written on this mount, so a query that
 *   turns on when the market pays out while the detail is open also reads once, however fresh the
 *   cached list; never stale after it — a paid-out market's records neither grow nor change (no
 *   UPDATE or DELETE on `position_settlements`, migration 0064), so a focus does not ask again
 *   while an event and a reconnect still do (`restartQueries` invalidates).
 *
 * One page: an account holds at most two records in a market (YES and NO), and a page is 20.
 * Without `gated`: while the session is looked up the positions list is pending and the card
 * draws its skeleton, so this list's own wait never shows on its own.
 */
export function useMarketSettlements(
  marketId: string,
  status: MarketStatus | undefined,
  accountId: string | undefined,
) {
  const { data: session } = useSession();
  const [mountedAt] = useState(() => Date.now());
  const base = settlementHistoryQueryOptions(
    historyListFilters({ market: marketId }),
    accountId,
    session,
  );
  const enabled = base.enabled && status === 'settled';
  const queryClient = useQueryClient();
  useEffect(() => {
    cancelEarlierRecordReads(
      queryClient,
      mySettlementsKey(historyListFilters({ market: marketId }), accountId),
    );
  }, [queryClient, marketId, accountId, enabled]);
  const query = useInfiniteQuery({
    ...base,
    enabled,
    refetchOnMount: 'always',
    staleTime: recordsStaleTime(mountedAt),
  });
  return { query, mountedAt };
}
