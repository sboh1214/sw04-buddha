'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  validationField,
  type ChargePackage,
  type ChargeResult,
  type LedgerEntry,
  type Payment,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';
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
 * The 409 that means "your earlier request with this key is still running" (PLAN 5.4): the
 * only DUPLICATE_REQUEST that names the header. The other one — same key, different terms —
 * carries no field. They are told apart because the client must KEEP the key for the first
 * (the next click should collect that purchase, not start another) and spend it on the second.
 */
export function isChargeInProgress(error: unknown): boolean {
  return isApiError(error, 'DUPLICATE_REQUEST') && validationField(error) === 'Idempotency-Key';
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
  // blocks another. The keys themselves sit in sessionStorage, so a reload — the natural
  // reaction to a request that never answered — finds the same key, and they are filed under
  // the account, so another account using this tab meanwhile cannot consume them. Until
  // better-auth has said whose session this is (the first paint, while BalanceCard shows its
  // skeleton) there is no account to file under: `ready` is false and ChargeForm keeps the buy
  // buttons disabled. The wallet page is server-gated, so that answer is a session, not a
  // sign-out; should the first /get-session fail with something other than a 401 the buttons
  // stay disabled until better-auth's next refetch succeeds. A switch while the page stays
  // mounted (SessionCacheGuard) yields the new account's handle on the next click. A click
  // while the atom still holds the previous account (side-by-side windows never fire
  // visibilitychange; a refetch keeps the old data for one round trip) sends that account as
  // `expectedAccountId`, and the server refuses rather than credit the cookie's account and
  // leave the key filed under the wrong one; the refusal below asks the session to refetch.
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  // A ref, not useMemo: React may drop a memo, and with a throwing storage the handle's
  // in-memory fallback IS the key. Resolved at call time, so no ref is touched during render.
  const handle = useRef<{ account: string; keys: IdempotencyKeys } | null>(null);
  const keysFor = (account: string): IdempotencyKeys => {
    if (handle.current?.account !== account) {
      handle.current = { account, keys: new IdempotencyKeys(account) };
    }
    return handle.current.keys;
  };
  const mutation = useMutation({
    // The whole package, not just its id: the body echoes the amount and price this card is
    // showing so the server can refuse a purchase of terms the user never read (ADR-0026 lets
    // an admin re-price a live package, and this catalogue has no refetch interval).
    mutationFn: async (pack: ChargePackage) => {
      // Unreachable while the buttons honour `ready`; refusing beats sending an unfiled key.
      if (!accountId) throw new Error('charge attempted before the session was known');
      const keys = keysFor(accountId);
      const result = await api.POST('/api/v1/payments/charge', {
        params: { header: { 'Idempotency-Key': keys.take(pack.id) } },
        body: {
          packageId: pack.id,
          expectedAmountP: pack.amountP,
          expectedPriceKrw: pack.priceKrw,
          expectedAccountId: accountId,
        },
      });
      // Only reached when the server answered; a throw above (no response) keeps the key. So
      // does an in-progress 409: the first request is still running, and the next click has
      // to collect its result rather than open a second purchase under a fresh key. And so
      // does the account refusal: the server judged the cookie, not this key — which may be
      // the one this account kept from an earlier lost answer — so spending it would throw
      // away exactly the recovery the storage exists for.
      let data: ChargeResult;
      try {
        data = unwrap(result).data;
      } catch (error) {
        if (!isChargeInProgress(error) && !isForAnotherAccount(error)) {
          keys.settle(pack.id, result.response.status);
        }
        throw error;
      }
      keys.settle(pack.id, result.response.status);
      return data;
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
      // The cookie is somebody else's now: have better-auth refetch the session so
      // SessionCacheGuard resets the caches and the screen shows the account that is really
      // signed in. Nothing was reserved, and the key stayed in the on-screen account's namespace.
      if (isForAnotherAccount(error)) void refetchSession();
      // Either an earlier click already bought this (the user took it for a failure) or that
      // click is still running: the balance on screen may be behind what the server holds.
      if (isApiError(error, 'DUPLICATE_REQUEST')) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY }),
        ]);
      }
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

/**
 * `POST /api/v1/coupons/redeem`: an admin-issued grant, credited as a BONUS entry.
 *
 * Redemption is idempotent in effect per (coupon, account) by the UNIQUE constraint, so it
 * needs no Idempotency-Key: a retry after a lost answer is refused, never credited twice. But
 * that refusal can be the echo of a redemption that went through — "already used" is exactly
 * that, and "cannot be used" is too when the coupon has since been exhausted by that very
 * redemption, expired or disabled (the server checks those before it reaches the UNIQUE row)
 * — so both answers refresh the balance and the ledger as a success would. The form still
 * shows the refusal; what it must not do is keep showing the world from before the
 * redemption. A typo pays one refetch for this; the first lost answer itself (a transport
 * error, shown as errUnknown) refetches nothing, since the same network would likely fail.
 */
export function useRedeemCoupon() {
  const queryClient = useQueryClient();
  // The account the screen shows rides along (`expectedAccountId`), as it does for a charge:
  // a one-use or capped coupon redeemed for whoever the cookie now belongs to cannot be given
  // back. `ready` is false until better-auth has said whose session this is.
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
    ]);
  const mutation = useMutation({
    mutationFn: async (code: string) => {
      // Unreachable while the form honours `ready`.
      if (!accountId) throw new Error('redeem attempted before the session was known');
      return unwrap(
        await api.POST('/api/v1/coupons/redeem', {
          body: { code, expectedAccountId: accountId },
        }),
      ).data;
    },
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      // Somebody else's cookie: refetch the session so SessionCacheGuard shows the real account.
      if (isForAnotherAccount(error)) void refetchSession();
      if (isApiError(error, 'DUPLICATE_REQUEST') || isCouponRejection(error)) await refresh();
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}
