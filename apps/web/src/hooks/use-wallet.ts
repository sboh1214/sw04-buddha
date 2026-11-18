'use client';

import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { LedgerFilterKind, RecentPeriod } from '@buddha/shared';
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
  type RedeemCouponBody,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { IdempotencyKeys } from '@/lib/idempotency';
import {
  LEDGER_KEY,
  type LedgerPage,
  type LedgerPages,
  headCoversLedger,
  ledgerHeadDate,
  mergeLedgerHead,
} from '@/lib/ledger-join';
import { type PaymentsPoll, endedFetches, paymentsPoll } from '@/lib/payments';
import { restartQueries } from '@/lib/query-client';
import { type WalletListFilters, walletListFilters } from '@/lib/wallet';
import { ME_QUERY_KEY } from './use-me';
import { MEMBER_CORRECTIONS_KEY } from './use-reconciliation-corrections';

/**
 * PLAN 11.5 key rules. Ledger and payments hang off their own roots; the ledger's entries are
 * `myLedgerKey`'s, one per filter and account.
 */
export const LEDGER_QUERY_KEY = LEDGER_KEY;
export const CHARGE_PACKAGES_QUERY_KEY = ['charge-packages'] as const;
export const PAYMENTS_QUERY_KEY = ['payments'] as const;

/**
 * The account's histories a balance change can add to or move: 원장 gains the change's row, and
 * 결제 내역 follows the payment behind it — an admin refund's claw-back (완료 → 환불 처리 중), and
 * the correction history its correction. A resnapshot restarts them whole, every loaded page
 * (`PRIVATE_SNAPSHOT_KEYS`). A live `user:balance` reaches them through the provider's window
 * instead (`balanceHistoryRound`: a head read per ledger entry on screen, the other two restarted).
 */
export const BALANCE_HISTORY_KEYS = [
  LEDGER_QUERY_KEY,
  PAYMENTS_QUERY_KEY,
  MEMBER_CORRECTIONS_KEY,
] as const;

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * 이용 내역's key (#69, ADR-0144 결정 2-10): the filters as one object — what is on only, the market
 * lower-cased — and the account the screen shows (`Me`'s id) last, as #124's history keys
 * (market-keys.ts): an answer names no owner. Under `LEDGER_QUERY_KEY`, so `user:balance`'s round
 * (`balanceHistoryRound`: finds every entry by this prefix, then a head read on screen, a restart
 * of that entry alone on a first fetch, stale otherwise), the resnapshot's restart
 * (`BALANCE_HISTORY_KEYS`), a charge's refresh and SessionCacheGuard's reset reach every filtered
 * entry. MY 요약's preview reads the unfiltered entry the tab holds.
 */
export const myLedgerKey = (filters: WalletListFilters, accountId: string | undefined) =>
  [...LEDGER_QUERY_KEY, walletListFilters(filters), accountId] as const;

/** The filters and the cursor as `GET /me/ledger` takes them: only what is set. */
export function ledgerQuery(
  filters: WalletListFilters,
  cursor: string | undefined,
): { kind?: LedgerFilterKind; period?: RecentPeriod; marketId?: string; cursor?: string } {
  return {
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.period === undefined ? {} : { period: filters.period }),
    ...(filters.market === undefined ? {} : { marketId: filters.market.toLowerCase() }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function fetchLedgerPage(
  filters: WalletListFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<LedgerPage> {
  const result = await api.GET('/api/v1/me/ledger', {
    params: { query: ledgerQuery(filters, cursor) },
    ...(signal === undefined ? {} : { signal }),
  });
  const { data, meta } = unwrap(result);
  return { items: data, nextCursor: meta.nextCursor };
}

/**
 * A balance-history round's read of one ledger entry (#69, ADR-0144 결정 6): its first page under
 * the key's own filters (`myLedgerKey`'s second part), no cursor, merged into what the entry holds
 * (`mergeLedgerHead`, with the key's `period`) — one request however many pages are loaded.
 * Written only over data the entry still holds: after a session reset or a removal nothing is
 * written, and the key ends in the account, so no other account's entry is touched.
 *
 * Dated from when the request left (`ledgerHeadDate`), so `dataUpdatedAt` says how fresh the list
 * is and a focus inside `staleTime` reads nothing more — never earlier than a full read that
 * landed while this one was on its way. Except for a `period` entry holding rows below the head
 * (`headCoversLedger` false: they may have aged out since their read) once the last read that
 * vouched for the whole list is `PERIOD_REVALIDATE_MS` old: it keeps the date it had, and the next
 * focus, mount or reconnect past `staleTime` reads it whole — no request of the round's own.
 */
export async function readLedgerHead(
  queryClient: QueryClient,
  queryKey: QueryKey,
  signal?: AbortSignal,
): Promise<void> {
  const filters = (queryKey[1] ?? {}) as WalletListFilters;
  const requestStart = Date.now();
  const head = await fetchLedgerPage(filters, undefined, signal);
  const held = queryClient.getQueryData<LedgerPages>(queryKey);
  const query = queryClient.getQueryCache().find<LedgerPages>({ queryKey, exact: true });
  if (held === undefined || query === undefined) return;
  const merged = mergeLedgerHead(held, head, filters.period);
  const covered = headCoversLedger(merged, head, filters.period);
  const heldAt = query.state.dataUpdatedAt;
  // A write since this function's last one is a full read (a refetch, a charge's): it vouched for
  // the list as of when it landed.
  const last = headDates.get(query);
  const vouchedAt = last?.wroteAt === heldAt ? last.vouchedAt : heldAt;
  const updatedAt = ledgerHeadDate({ covered, requestStart, heldAt, vouchedAt });
  queryClient.setQueryData<LedgerPages>(queryKey, merged, { updatedAt });
  headDates.set(query, {
    wroteAt: query.state.dataUpdatedAt,
    vouchedAt: covered ? updatedAt : vouchedAt,
  });
}

/**
 * Per ledger entry, the date `readLedgerHead` last gave it and the last read that vouched for its
 * whole list then (`ledgerHeadDate`'s `vouchedAt`). By the query object, so an entry removed (a
 * session reset, garbage collection) takes its memory along and a new one starts afresh.
 */
const headDates = new WeakMap<object, { wroteAt: number; vouchedAt: number }>();

/**
 * One balance-history round (#69, ADR-0144 결정 6; the provider's `refreshBalanceHistory` window
 * runs it for `user:balance`):
 *
 * - each ledger entry on screen with data: a head read (`readLedgerHead`). One that failed is
 *   read again in full, through the query's own fetch — what every event did before, once per
 *   failure — or the round's update could stay missing until a focus with nothing said. On the
 *   way or with a 5xx that fetch has the queries' `retry`; a 4xx (a 429) has none, one request,
 *   and a refusal again lands on the query as a refresh that failed over the rows kept, so the
 *   list says so (`ledger-stale`, 다시 시도) instead of standing a row short in silence;
 * - one on screen still on its FIRST fetch: restarted (`restartQueries`, that entry alone — a
 *   prefix would reach the filtered entries too), one page — that request left before the
 *   event's row, and a bare invalidation would wait on it;
 * - one not on screen: marked stale only, read in full when it is mounted again;
 * - the correction history and 결제 내역: restarted, as every `user:balance` did before.
 *
 * A reconnect does not come here: it restarts every loaded page (`PRIVATE_SNAPSHOT_KEYS`), since
 * what it missed can be more than a page.
 */
export function balanceHistoryRound(queryClient: QueryClient, signal?: AbortSignal): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: LEDGER_QUERY_KEY })) {
    const { queryKey } = query;
    const exact = { queryKey, exact: true };
    if (!query.isActive()) {
      void queryClient.invalidateQueries({ ...exact, refetchType: 'none' });
      continue;
    }
    if (query.state.data === undefined) {
      void restartQueries(queryClient, queryKey, (each) => each === query);
      continue;
    }
    readLedgerHead(queryClient, queryKey, signal).catch(() => {
      if (signal?.aborted === true) return;
      void queryClient.invalidateQueries(exact);
    });
  }
  void restartQueries(queryClient, PAYMENTS_QUERY_KEY);
  void restartQueries(queryClient, MEMBER_CORRECTIONS_KEY);
}

/**
 * 이용 내역: the account's own ledger rows, newest first, 20 a page, those the filters leave; older
 * pages appended as the reader asks for more (PLAN 7 cursor). Waits for the session and for the
 * account the screen shows (`accountId`): pending through the session's lookup, as #124's lists
 * (`use-my-history.ts`). Private (`['ledger']`), never read on the server.
 */
export function useLedger(filters: WalletListFilters, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery({
    queryKey: myLedgerKey(filters, accountId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchLedgerPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<LedgerEntry>) => last.nextCursor ?? undefined,
    enabled: session != null && accountId !== undefined,
  });
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/** What the poll reads of a query: its data and how many of its fetches have ended. */
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
 * 결제 내역: the account's own charges, newest first, 20 per page. Re-read every few seconds, for
 * a bounded while, as long as a loaded row is still moving on the server side (`paymentsPoll`):
 * a refund's finish (환불 처리 중 → 환불됨) publishes no event. The poll keeps its memory in
 * state, one per observer: which rows it waits on, and since which fetch.
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
 * The three ways the server says "the catalogue you are looking at is out of date": the
 * package was re-priced (409 PRICE_MOVED), retired (400 VALIDATION_ERROR naming `packageId`)
 * or deleted (404 NOT_FOUND naming `packageId`).
 *
 * Deliberately not every failure. A payment the provider declines is also a VALIDATION_ERROR
 * but names `amountCoin`. The 404 for an account with no balance row names nothing: the
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
 * What a click on a package sends: the whole package as its card shows it, and the account the
 * wallet was drawn for (`expectedAccountId` — the balance card's `Me`, which `ChargeForm` reads).
 */
export interface ChargeRequest {
  pack: ChargePackage;
  expectedAccountId: string;
}

/**
 * `POST /api/v1/payments/charge`. The response carries the new balance, so `['me']` and the
 * two lists are refreshed together — the nav chip and the ledger must never disagree.
 *
 * The body names the account the wallet shows (`expectedAccountId`, A-M2-11): the cookie decides
 * whose balance is charged, and a tab left open beside a window that signed in as somebody else
 * must not credit THAT account with a purchase made on this screen. That account is the one of the
 * `Me` the wallet was drawn from (the balance card's), which `ChargeForm` passes in with the
 * package, never the session's: in the render between the session naming another account and
 * SessionCacheGuard's reset (an effect) the session already says B while the wallet still shows
 * A's balance, and a body naming B would be taken with B's cookie — B charged for a package bought
 * on A's screen, its key filed under B (ADR-0091, as ADR-0090 did for the 본인확인 step). So the
 * hook offers no account of its own, and nothing waits for the session: the buy buttons wait for
 * `GET /me` instead.
 */
export function useCharge() {
  const queryClient = useQueryClient();
  // One Idempotency-Key per package until the server has answered (lib/idempotency.ts,
  // PLAN 5.4): a click whose request died on the way back re-sends the key and gets the first
  // purchase back instead of buying again. Per package, so a dead click on one card never
  // blocks another. The keys themselves sit in sessionStorage, so a reload — the natural
  // reaction to a request that never answered — finds the same key, and they are filed under
  // the account the purchase names, so another account using this tab meanwhile cannot consume
  // them. Until `GET /me` has said whose wallet this is (the first paint, while BalanceCard shows
  // its skeleton) there is no account to file under, and ChargeForm keeps the buy buttons
  // disabled; should that read fail they stay disabled beside the balance card's 다시 시도. A
  // switch while the page stays mounted yields the new account's handle on the next click. A
  // click while the wallet still shows the previous account (side-by-side windows never fire
  // visibilitychange, so neither the session nor `GET /me` is read again) sends that account as
  // `expectedAccountId`, and the server refuses rather than credit the cookie's account and leave
  // the key filed under the wrong one; the refusal below asks the session to refetch.
  const { refetch: refetchSession } = useSession();
  // A ref, not useMemo: React may drop a memo, and with a throwing storage the handle's
  // in-memory fallback IS the key. Resolved at call time, so no ref is touched during render.
  const handle = useRef<{ account: string; keys: IdempotencyKeys } | null>(null);
  const keysFor = (account: string): IdempotencyKeys => {
    if (handle.current?.account !== account) {
      handle.current = { account, keys: new IdempotencyKeys(account) };
    }
    return handle.current.keys;
  };
  return useMutation({
    // The whole package, not just its id: the body echoes the amount and price this card is
    // showing so the server can refuse a purchase of terms the user never read (ADR-0026 lets
    // an admin re-price a live package, and this catalogue has no refetch interval).
    mutationFn: async ({ pack, expectedAccountId }: ChargeRequest) => {
      const keys = keysFor(expectedAccountId);
      const result = await api.POST('/api/v1/payments/charge', {
        params: { header: { 'Idempotency-Key': keys.take(pack.id) } },
        body: {
          packageId: pack.id,
          expectedAmountCoin: pack.amountCoin,
          expectedPriceKrw: pack.priceKrw,
          expectedAccountId,
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
 *
 * The body names the account the wallet shows (`expectedAccountId`, A-M2-9), as a charge's does:
 * a one-use or capped coupon redeemed for whoever the cookie now belongs to cannot be given back.
 * That account is the one of the `Me` the wallet was drawn from, which `CouponForm` passes in,
 * never the session's — in the render between the session naming another account and
 * SessionCacheGuard's reset a body naming the session's would be taken with B's cookie, the code
 * typed on A's screen spent for B (ADR-0091). So the hook offers no account of its own, and
 * nothing waits for the session: the form waits for `GET /me` instead.
 */
export function useRedeemCoupon() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
    ]);
  return useMutation({
    mutationFn: async (body: RedeemCouponBody) =>
      unwrap(await api.POST('/api/v1/coupons/redeem', { body })).data,
    onSuccess: async () => {
      await refresh();
    },
    onError: async (error) => {
      // Somebody else's cookie: refetch the session so SessionCacheGuard shows the real account.
      if (isForAnotherAccount(error)) void refetchSession();
      if (isApiError(error, 'DUPLICATE_REQUEST') || isCouponRejection(error)) await refresh();
    },
  });
}
