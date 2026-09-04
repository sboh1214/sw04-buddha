'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  isApiError,
  unwrap,
  validationField,
  type ChargePackage,
  type LedgerEntry,
  type Payment,
} from '@/lib/api';
import { ME_QUERY_KEY } from './use-me';

/** PLAN 11.5 key rules. Ledger and payments hang off their own roots. */
export const LEDGER_QUERY_KEY = ['ledger'] as const;
export const CHARGE_PACKAGES_QUERY_KEY = ['charge-packages'] as const;
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

/** The catalogue a user buys from (ADR-0026); public, so it loads for logged-out visitors too. */
export function useChargePackages() {
  return useQuery({
    queryKey: CHARGE_PACKAGES_QUERY_KEY,
    queryFn: async (): Promise<ChargePackage[]> =>
      unwrap(await api.GET('/api/v1/charge-packages')).data,
  });
}

/**
 * The three ways the server says "the catalogue you are looking at is out of date": the
 * package was re-priced (409 PRICE_MOVED), retired (400 VALIDATION_ERROR naming `packageId`)
 * or deleted (404).
 *
 * Deliberately not every failure. A payment the provider declines is also a VALIDATION_ERROR
 * but names `amountP`, and refetching has a cost when it fails: the query flips to
 * `status: 'error'`, which swaps ChargeForm's cards for the generic error alert.
 */
export function isStaleCatalogue(error: unknown): boolean {
  return (
    isApiError(error, 'PRICE_MOVED') ||
    isApiError(error, 'NOT_FOUND') ||
    (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'packageId')
  );
}

/**
 * `POST /api/v1/payments/charge`. The response carries the new balance, so `['me']` and the
 * two lists are refreshed together — the nav chip and the ledger must never disagree.
 */
export function useCharge() {
  const queryClient = useQueryClient();
  return useMutation({
    // The whole package, not just its id: the body echoes the amount and price this card is
    // showing so the server can refuse a purchase of terms the user never read (ADR-0026 lets
    // an admin re-price a live package, and this catalogue has no refetch interval).
    mutationFn: async (pack: ChargePackage) =>
      unwrap(
        await api.POST('/api/v1/payments/charge', {
          body: {
            packageId: pack.id,
            expectedAmountP: pack.amountP,
            expectedPriceKrw: pack.priceKrw,
          },
        }),
      ).data,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY }),
      ]);
    },
    // Without this the refused card keeps showing the offer the server just rejected, and
    // every further click re-sends the same expected amount and price. Awaited on purpose:
    // react-query runs onError before it publishes the error, so the buy buttons stay
    // disabled until the fresh catalogue lands and no card can change under the cursor.
    onError: async (error) => {
      if (isStaleCatalogue(error)) {
        await queryClient.invalidateQueries({ queryKey: CHARGE_PACKAGES_QUERY_KEY });
      }
    },
  });
}

/** `POST /api/v1/coupons/redeem`: an admin-issued grant, credited as a BONUS entry. */
export function useRedeemCoupon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) =>
      unwrap(await api.POST('/api/v1/coupons/redeem', { body: { code } })).data,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
      ]);
    },
  });
}
