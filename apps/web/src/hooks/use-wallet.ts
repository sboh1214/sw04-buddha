'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  isApiError,
  unwrap,
  validationField,
  type ChargePackage,
  type LedgerEntry,
  type Payment,
} from '@/lib/api';
import { IdempotencyKeys } from '@/lib/idempotency';
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
 * or deleted (404 NOT_FOUND naming `packageId`).
 *
 * Deliberately not every failure. A payment the provider declines is also a VALIDATION_ERROR
 * but names `amountP`. The 404 for an account with no balance row names nothing: the
 * catalogue it would refetch still lists the package, so the next click would only repeat
 * the same failure. Refetching has a cost when it fails, too: the query flips to
 * `status: 'error'`, which swaps ChargeForm's cards for the generic error alert.
 */
export function isStaleCatalogue(error: unknown): boolean {
  if (isApiError(error, 'PRICE_MOVED')) return true;
  return (
    (isApiError(error, 'NOT_FOUND') || isApiError(error, 'VALIDATION_ERROR')) &&
    validationField(error) === 'packageId'
  );
}

/**
 * The one answer the API gives for a code that cannot be used — unknown, disabled, expired or
 * exhausted are deliberately indistinguishable (A-M2-9), and all four arrive as a
 * VALIDATION_ERROR naming `code`.
 *
 * Deliberately not every VALIDATION_ERROR: the exception filter hands that code to any
 * unmapped 4xx too. Nothing else the redeem route can answer is about the code either — its
 * NOT_FOUND means the account has no balance row, which is not the user's typo to fix.
 */
export function isCouponRejection(error: unknown): boolean {
  return isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'code';
}

/**
 * `POST /api/v1/payments/charge`. The response carries the new balance, so `['me']` and the
 * two lists are refreshed together — the nav chip and the ledger must never disagree.
 */
export function useCharge() {
  const queryClient = useQueryClient();
  // One Idempotency-Key per package until the server has answered (lib/idempotency.ts,
  // PLAN 5.4): a click whose request died on the way back re-sends the key and gets the first
  // purchase back instead of buying again. Per package, so a dead click on one card never
  // blocks another. Lives in state, not a ref, so it is created once per mounted form.
  const [keys] = useState(() => new IdempotencyKeys());
  return useMutation({
    // The whole package, not just its id: the body echoes the amount and price this card is
    // showing so the server can refuse a purchase of terms the user never read (ADR-0026 lets
    // an admin re-price a live package, and this catalogue has no refetch interval).
    mutationFn: async (pack: ChargePackage) => {
      const result = await api.POST('/api/v1/payments/charge', {
        params: { header: { 'Idempotency-Key': keys.take(pack.id) } },
        body: {
          packageId: pack.id,
          expectedAmountP: pack.amountP,
          expectedPriceKrw: pack.priceKrw,
        },
      });
      // Only reached when the server answered; a throw above (no response) keeps the key.
      keys.settle(pack.id, result.response.status);
      return unwrap(result).data;
    },
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
      // The key was spent by an earlier click — one the user took for a failure, or one still
      // running — so the balance on screen may be behind what the server holds.
      if (isApiError(error, 'DUPLICATE_REQUEST')) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY }),
        ]);
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
