'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  type Order,
  type OrderQuote,
  type PlaceOrderBody,
  type PlaceOrderResult,
  type Sellable,
  api,
  unwrap,
} from '@/lib/api';
import { sellableKey } from '@/lib/market-keys';
import { type OrderTerms, QUOTE_DEBOUNCE_MS, debouncer, quoteBodyOf } from '@/lib/order-panel';

/**
 * 주문 패널's requests (#66, ADR-0140): the public quote, the order, the read-back of a request id
 * and the member's 매도 가능액. The panel's state is the provider's
 * (components/market/order-panel-provider.tsx); these only talk to the API.
 */

/** A quote's key: public, the same for every reader, never seeded on the server. */
export const quoteKey = (marketId: string, terms: OrderTerms | null) =>
  ['quote', marketId.toLowerCase(), terms] as const;

export async function fetchQuote(marketId: string, terms: OrderTerms): Promise<OrderQuote> {
  const id = marketId.toLowerCase();
  return unwrap(
    await api.POST('/api/v1/markets/{id}/quote', {
      params: { path: { id } },
      body: quoteBodyOf(terms),
    }),
  ).data;
}

/**
 * Query options of a quote: never cached as fresh (the book moves), dropped 30 s after nobody
 * reads it, and never retried — a quote failed is said and asked again by the next keystroke or
 * book move, not twice more at once (the default retries a 5xx, query-client.ts), which the
 * address bucket the book and the orders share would pay for (ADR-0138).
 */
export function quoteQueryOptions(marketId: string, terms: OrderTerms | null, enabled: boolean) {
  return {
    queryKey: quoteKey(marketId, terms),
    queryFn: () => {
      if (terms === null) throw new Error('No terms to quote');
      return fetchQuote(marketId, terms);
    },
    enabled: enabled && terms !== null,
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  };
}

/**
 * `value` once it has stayed the same for `delayMs`: a burst of keystrokes asks once. The timing
 * is `debouncer`'s, which lib/order-panel.test.ts runs on fake timers.
 */
export function useDebounced<T>(value: T, delayMs: number = QUOTE_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  const debounce = useMemo(
    () =>
      debouncer<T>(delayMs, (next) => {
        setSettled(() => next);
      }),
    [delayMs],
  );
  useEffect(() => {
    debounce.push(value);
  }, [debounce, value]);
  useEffect(() => debounce.cancel, [debounce]);
  return settled;
}

export function useQuote(marketId: string, terms: OrderTerms | null, enabled: boolean) {
  return useQuery(quoteQueryOptions(marketId, terms, enabled));
}

/** What one send of an order carries: the request id (`Idempotency-Key`) and the body. */
export interface PlaceOrderRequest {
  marketId: string;
  requestId: string;
  body: PlaceOrderBody;
}

/**
 * `POST /markets/:id/orders`. A mutation, so the MutationCache's RESTRICTED rule reads the
 * restriction again (`afterRestricted`); the caller decides what every answer means
 * (`placeOutcomeOf`) — this neither retries nor keeps a key of its own.
 */
export function usePlaceOrder() {
  return useMutation({
    retry: false,
    mutationFn: async ({
      marketId,
      requestId,
      body,
    }: PlaceOrderRequest): Promise<PlaceOrderResult> =>
      unwrap(
        await api.POST('/api/v1/markets/{id}/orders', {
          params: {
            path: { id: marketId.toLowerCase() },
            header: { 'Idempotency-Key': requestId },
          },
          body,
        }),
      ).data,
  });
}

/** `GET /me/orders/request/:requestId`: the order a request id named, or NOT_FOUND for none. */
export async function fetchOrderByRequest(requestId: string): Promise<Order> {
  return unwrap(
    await api.GET('/api/v1/me/orders/request/{requestId}', {
      params: { path: { requestId } },
    }),
  ).data;
}

/**
 * `GET /me/markets/:id/sellable`: the member's holding of each contract, its resting sells and
 * the rest — the sell side's 매도 가능 (D11). Client-only (a private root), kept under the account
 * the screen shows (`accountId`, `Me`'s id: `sellableKey`) and read only once that account is
 * known; `user:position` reads it again by its market prefix (realtime-provider.tsx).
 */
export function sellableQueryOptions(marketId: string, accountId: string | undefined) {
  const id = marketId.toLowerCase();
  return {
    queryKey: sellableKey(id, accountId),
    queryFn: async (): Promise<Sellable> =>
      unwrap(await api.GET('/api/v1/me/markets/{id}/sellable', { params: { path: { id } } })).data,
    enabled: accountId !== undefined,
  };
}

export function useSellable(marketId: string, accountId: string | undefined) {
  return useQuery(sellableQueryOptions(marketId, accountId));
}
