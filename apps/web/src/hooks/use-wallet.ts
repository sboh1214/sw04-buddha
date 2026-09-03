'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type LedgerEntry, type Payment } from '@/lib/api';
import { ME_QUERY_KEY } from './use-me';

/** PLAN 11.5 key rules. Ledger and payments hang off their own roots. */
export const LEDGER_QUERY_KEY = ['ledger'] as const;
export const PAYMENTS_QUERY_KEY = ['payments'] as const;

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

async function fetchLedgerPage(cursor: string | undefined): Promise<Page<LedgerEntry>> {
  const result = await api.GET('/api/v1/me/ledger', {
    params: { query: cursor ? { cursor } : {} },
  });
  const { data, meta } = unwrap(result);
  return { items: data, nextCursor: meta.nextCursor };
}

/** Ledger history, oldest pages appended as the reader asks for more (PLAN 7 cursor). */
export function useLedger() {
  return useInfiniteQuery({
    queryKey: LEDGER_QUERY_KEY,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => fetchLedgerPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<LedgerEntry>) => last.nextCursor ?? undefined,
  });
}

export function usePayments() {
  return useInfiniteQuery({
    queryKey: PAYMENTS_QUERY_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const result = await api.GET('/api/v1/me/payments', {
        params: { query: pageParam ? { cursor: pageParam } : {} },
      });
      const { data, meta } = unwrap(result);
      return { items: data, nextCursor: meta.nextCursor } satisfies Page<Payment>;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<Payment>) => last.nextCursor ?? undefined,
  });
}

/**
 * `POST /api/v1/payments/charge`. The response carries the new balance, so `['me']` and the
 * two lists are refreshed together — the nav chip and the ledger must never disagree.
 */
export function useCharge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (amountP: bigint) =>
      unwrap(await api.POST('/api/v1/payments/charge', { body: { amountP: amountP.toString() } }))
        .data,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY }),
      ]);
    },
  });
}
