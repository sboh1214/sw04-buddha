'use client';

import type { Outcome } from '@buddha/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sellableQueryOptions } from '@/hooks/use-orders-place';
import type { Position } from '@/lib/api';
import { sellableKey } from '@/lib/market-keys';
import { RequestPacer } from '@/lib/request-pacer';
import {
  type ReadFacts,
  type SellableReading,
  type SellableRetry,
  sellableReadingOf,
  sellableRetriesDue,
} from '@/lib/sellable-view';

/** What a holdings list query says of its reads: `usePositions`' answer satisfies it. */
interface ListReads extends ReadFacts {
  refetch: () => Promise<unknown>;
}

/**
 * MY's sellable reads: at most 10 on their way and 20 started in any minute (ADR-0142 결정 2-15).
 * With the market rows (one request per 50 held markets since #300, `useHoldings`) and the
 * screen's own reads, a cold `/my/positions` stays under one tab's 50 a minute at 50 held markets
 * (5 + 1 + 20); the rest of them wait as skeletons, the top groups (the latest changed) first.
 */
export const SELLABLE_PACE = { maxInFlight: 10, perWindow: 20, windowMs: 60_000 } as const;

/** One queue for the tab: `/my` and `/my/positions` spend one address's budget. */
const sellablePacer = new RequestPacer(SELLABLE_PACE);

/**
 * `sellableQueryOptions` with its request run through `pacer`, for a screen of many markets. Same
 * key, so the entry is the panel's; the detail (one market) keeps the unpaced options.
 */
export function pacedSellableQueryOptions(
  marketId: string,
  accountId: string | undefined,
  pacer: RequestPacer = sellablePacer,
) {
  const options = sellableQueryOptions(marketId, accountId);
  return {
    ...options,
    queryFn: ({ signal }: { signal: AbortSignal }) => pacer.run(options.queryFn, signal),
  };
}

/**
 * The account's 매도 가능액 of each market a holdings screen draws (#67, ADR-0142): one
 * `GET /me/markets/:id/sellable` per market in `marketIds`, under the order panel's own key
 * (`sellableKey`), so the detail's 내 포지션 and its panel share one entry. `marketIds` is the
 * markets drawn: every held one on `/my/positions`, the preview's on `/my`, the one on a detail.
 *
 * A holding's row and its sellable figures are two answers, and one may be behind the other: a
 * `user:position` reads both again and they land apart. While their quantities differ the cells
 * are a skeleton; once both reads have settled and they still differ, both are read once more —
 * once per pair of quantities — and if that does not bring them together the cells say '—' with
 * 다시 시도 (`failed`), never a figure for the wrong quantity. The decisions are
 * `sellableRetriesDue` and `sellableReadingOf` (pure, sellable-view.test.ts); this reads.
 *
 * `paced`: MY's holdings, one read per held market, go through `SELLABLE_PACE`'s queue
 * (`pacedSellableQueryOptions`); the detail's one market does not, and reads as its panel does.
 */
export function useSellableReadings({
  accountId,
  marketIds,
  positions,
  list,
  paced = false,
}: {
  accountId: string | undefined;
  marketIds: readonly string[];
  positions: readonly Position[];
  list: ListReads;
  paced?: boolean;
}) {
  const queryClient = useQueryClient();
  const queries = useQueries({
    queries: marketIds.map((id) =>
      paced ? pacedSellableQueryOptions(id, accountId) : sellableQueryOptions(id, accountId),
    ),
  });
  const byMarket = new Map(marketIds.map((id, i) => [id.toLowerCase(), queries[i]]));

  // The disagreeing pairs read once more, decided while rendering (react.dev, "Storing
  // information from previous renders"); the reads themselves go in the effect below.
  const [retries, setRetries] = useState<readonly SellableRetry[]>([]);
  const due = sellableRetriesDue({
    positions,
    sellableOf: (marketId) => byMarket.get(marketId),
    list,
    retries,
  });
  if (due.length > 0) setRetries([...retries, ...due]);

  const refetchList = list.refetch;
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const markets = new Set<string>();
    for (const retry of retries) {
      if (asked.current.has(retry.key)) continue;
      asked.current.add(retry.key);
      markets.add(retry.marketId);
    }
    if (markets.size === 0) return;
    for (const marketId of markets) {
      void queryClient.refetchQueries({ queryKey: sellableKey(marketId, accountId), exact: true });
    }
    void refetchList();
  }, [retries, queryClient, accountId, refetchList]);

  const reading = (marketId: string, outcome: Outcome, qty: number): SellableReading =>
    sellableReadingOf({
      read: byMarket.get(marketId.toLowerCase()),
      list,
      retries,
      marketId,
      outcome,
      qty,
    });

  /** 다시 시도 of a '—' cell: the market's sellable and the holdings, read again. */
  const retry = useCallback(
    (marketId: string) => {
      void queryClient.refetchQueries({
        queryKey: sellableKey(marketId.toLowerCase(), accountId),
        exact: true,
      });
      void refetchList();
    },
    [queryClient, accountId, refetchList],
  );

  return { reading, retry };
}
