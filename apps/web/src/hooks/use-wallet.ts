'use client';

import {
  type InfiniteData,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
  type PaymentProviderInfo,
  type SmartroPrepareResult,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { IdempotencyKeys } from '@/lib/idempotency';
import {
  type PaymentsPoll,
  endedFetches,
  isFlowUnavailable,
  paymentPollInterval,
  paymentsPoll,
} from '@/lib/smartro-payments';
import { ME_QUERY_KEY } from './use-me';

/** PLAN 11.5 key rules. Ledger and payments hang off their own roots. */
export const LEDGER_QUERY_KEY = ['ledger'] as const;
export const CHARGE_PACKAGES_QUERY_KEY = ['charge-packages'] as const;
export const PAYMENTS_QUERY_KEY = ['payments'] as const;

/**
 * One payment of the caller's (`GET /me/payments/:id`), under the payments root: everything
 * that refreshes the list after a charge refreshes the notice's payment with it, and a session
 * switch empties both (`PRIVATE_QUERY_ROOTS`).
 */
export const myPaymentKey = (id: string) => [...PAYMENTS_QUERY_KEY, 'one', id] as const;

/**
 * The account's histories a balance change can add to or move, which the realtime
 * `user:balance` handler restarts (and a resnapshot with them): 원장 gains the change's row, and
 * 결제 내역 follows the payment behind it — an admin refund's claw-back (완료 → 환불 처리 중),
 * a 재통보 that credited a payment after the result notice stopped polling. The payments root
 * covers the list and the notice's payment (`myPaymentKey`) alike.
 */
export const BALANCE_HISTORY_KEYS = [LEDGER_QUERY_KEY, PAYMENTS_QUERY_KEY] as const;

/**
 * Which charge flow the server offers (ADR-0042). Public and the same for everyone — it is the
 * deployment's `PAYMENT_PROVIDER` — so its own root, outside `PRIVATE_QUERY_ROOTS`: nothing
 * personal could ride an SSR payload in it.
 */
export const PAYMENT_PROVIDER_QUERY_KEY = ['payment-provider'] as const;

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

/** What the two polls read of a query: its data and how many of its fetches have ended. */
interface PolledQuery<T> {
  state: { data?: T | undefined; dataUpdateCount: number; errorUpdateCount: number };
}

/**
 * `refetchInterval` of 결제 내역: `poll` over every loaded row, on every loaded page, counted by
 * the list's `endedFetches` (a failed fetch spends the budget too). Apart from `usePayments` so
 * a test can hand it a query's state.
 */
export function paymentsRefetchInterval(poll: PaymentsPoll) {
  return (query: PolledQuery<InfiniteData<Page<Payment>>>): number | false =>
    poll(query.state.data?.pages.flatMap((page) => page.items) ?? [], endedFetches(query.state));
}

/**
 * `refetchInterval` of the result notice's payment (`useMyPayment`): `paymentPollInterval` by the
 * query's `endedFetches`, so a payment whose re-reads keep failing stops like one still pending.
 */
export function myPaymentRefetchInterval(query: PolledQuery<Payment>): number | false {
  return paymentPollInterval(query.state.data, endedFetches(query.state));
}

/**
 * 결제 내역: the account's own charges, newest first, 20 per page. Re-read every few seconds, for
 * a bounded while, as long as a loaded row is still moving on the server side (`paymentsPoll`):
 * a refund's finish (환불 처리 중 → 환불됨) publishes no event, nor does a settle that moves no
 * P. The poll keeps its memory in state, one per observer: which rows it waits on, and since
 * which fetch.
 */
export function usePayments() {
  const [poll] = useState(paymentsPoll);
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
    refetchInterval: paymentsRefetchInterval(poll),
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
 * `GET /payments/provider`: `mock` keeps the one-click charge, `smartro` opens the payment
 * window. It changes only with a deploy, so it is kept for five minutes; a charge refused as
 * unavailable (`isFlowUnavailable`) re-reads it at once, so a switch made while a wallet tab
 * was open costs that tab one refused click, not five minutes.
 */
export function usePaymentProvider() {
  return useQuery({
    queryKey: PAYMENT_PROVIDER_QUERY_KEY,
    queryFn: async (): Promise<PaymentProviderInfo> =>
      unwrap(await api.GET('/api/v1/payments/provider')).data,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The payment the wallet's result notice is about (`/wallet?payment=<id>`). Re-read every few
 * seconds while it is still `pending` (`paymentPollInterval`), so a return whose approval
 * answer was lost turns into its real outcome on screen once the 재통보 settles it. Someone
 * else's id is a 404 and stays one (4xx are not retried); the notice then says what the URL
 * said.
 */
export function useMyPayment(id: string | undefined) {
  return useQuery({
    queryKey: myPaymentKey(id ?? ''),
    queryFn:
      id === undefined
        ? skipToken
        : async (): Promise<Payment> =>
            unwrap(await api.GET('/api/v1/me/payments/{id}', { params: { path: { id } } })).data,
    refetchInterval: myPaymentRefetchInterval,
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
      // The provider was switched to SmartroPay under this tab (the immediate charge is a 404
      // then): re-read it, so the next click opens the payment window instead.
      if (isFlowUnavailable(error)) {
        void queryClient.invalidateQueries({ queryKey: PAYMENT_PROVIDER_QUERY_KEY });
      }
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
 * The key intent of a payment-window purchase. Filed apart from the immediate charge's
 * (`pack.id`) in the same namespace: a key a mock charge left unanswered must never be replayed
 * as a SmartroPay reservation after a provider switch — the server would refuse it as another
 * charge's key — nor the other way round.
 */
export function smartroKeyIntent(packageId: string): string {
  return `smartro:${packageId}`;
}

/**
 * `POST /payments/smartro/prepare` (ADR-0042): reserve a `pending` payment for the package and
 * get the signed form that opens the SmartroPay window for it. The body is the immediate
 * charge's, for the same reasons (the terms on screen, the account on screen).
 *
 * Keys: a fresh one per click, settled on ANY answer (DESIGN §6.2). An answered prepare is
 * finished business — the window it opens is where the purchase happens, and the next click is
 * a new window for a new reservation; re-sending a spent key would only earn DUPLICATE_REQUEST
 * once that window's payment is claimed. `settle` still keeps a key a 5xx answered, as it keeps
 * one no answer came back for: the reservation may exist, and the next click replaying the key
 * gets a freshly signed form for that SAME payment (while it is unclaimed) instead of a second
 * reservation. Unlike the immediate charge there is no answer to keep a key FOR — this route
 * has no "still running" state, and the account refusal settles too: nothing was reserved.
 */
export function useSmartroPrepare() {
  const queryClient = useQueryClient();
  // The account on screen, as `useCharge` files its keys under it: `ready` is false until
  // better-auth has said whose session this is, and the buttons wait for it.
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  // A ref for the same reason as `useCharge`'s: with a throwing storage the handle's in-memory
  // fallback IS the key, and a memo React may drop would lose it.
  const handle = useRef<{ account: string; keys: IdempotencyKeys } | null>(null);
  const keysFor = (account: string): IdempotencyKeys => {
    if (handle.current?.account !== account) {
      handle.current = { account, keys: new IdempotencyKeys(account) };
    }
    return handle.current.keys;
  };
  const mutation = useMutation({
    mutationFn: async (pack: ChargePackage): Promise<SmartroPrepareResult> => {
      // Unreachable while the buttons honour `ready`.
      if (!accountId) throw new Error('payment window requested before the session was known');
      const keys = keysFor(accountId);
      const intent = smartroKeyIntent(pack.id);
      const result = await api.POST('/api/v1/payments/smartro/prepare', {
        params: { header: { 'Idempotency-Key': keys.take(intent) } },
        body: {
          packageId: pack.id,
          expectedAmountP: pack.amountP,
          expectedPriceKrw: pack.priceKrw,
          expectedAccountId: accountId,
        },
      });
      keys.settle(intent, result.response.status);
      return unwrap(result).data;
    },
    // The reservation is a row of 결제 내역 from now on (미완료 until the window hands it back).
    // Not awaited: the window should not wait for a list refetch.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY, exact: true });
    },
    // The immediate charge's reactions, answer for answer (`useCharge`); awaited where they
    // are there, so a stale card never changes under the cursor.
    onError: async (error) => {
      if (isStaleCatalogue(error)) {
        await queryClient.invalidateQueries({ queryKey: CHARGE_PACKAGES_QUERY_KEY });
      }
      if (isForAnotherAccount(error)) void refetchSession();
      // Switched back to the immediate charge under this tab: the next click takes it.
      if (isFlowUnavailable(error)) {
        void queryClient.invalidateQueries({ queryKey: PAYMENT_PROVIDER_QUERY_KEY });
      }
      // A key whose payment an approval already claimed or settled: what it bought may not be
      // on screen yet.
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
