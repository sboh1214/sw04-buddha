import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Payment, isForAnotherAccount } from '@/lib/api';
import { restartQueries } from '@/lib/query-client';
import { PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_LIMIT, paymentsPoll } from '@/lib/payments';
import { ME_QUERY_KEY } from './use-me';
import {
  BALANCE_HISTORY_KEYS,
  CHARGE_PACKAGES_QUERY_KEY,
  LEDGER_QUERY_KEY,
  PAYMENTS_QUERY_KEY,
  isChargeInProgress,
  isCouponRejection,
  isStaleCatalogue,
  paymentsRefetchInterval,
} from './use-wallet';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('isStaleCatalogue', () => {
  it('refetches on the three rejections that mean the cards are out of date', () => {
    // Re-priced, retired and deleted. Without the refetch the refused card keeps showing the
    // offer the server just rejected and every further click re-sends the same terms.
    expect(isStaleCatalogue(apiError(409, 'PRICE_MOVED'))).toBe(true);
    expect(
      isStaleCatalogue(apiError(404, 'NOT_FOUND', [{ path: ['packageId'], message: 'not found' }])),
    ).toBe(true);
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['packageId'], message: 'inactive' }]),
      ),
    ).toBe(true);
  });

  it('leaves the cards alone when the catalogue is not the problem', () => {
    // A declined payment is a VALIDATION_ERROR too, but on `amountCoin` — refetching would be
    // pointless, and a refetch that fails swaps the whole card list for the error alert.
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['amountCoin'], message: 'payment refused' }]),
      ),
    ).toBe(false);
    expect(isStaleCatalogue(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    // `charge` answers 404 for an account with no balance row too (refused before anything
    // is reserved or charged). That one names no field: the catalogue still lists the
    // package, so refetching it and calling the package unavailable would only invite the
    // same failure again.
    expect(isStaleCatalogue(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isStaleCatalogue(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isStaleCatalogue(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isStaleCatalogue(new Error('network'))).toBe(false);
    expect(isStaleCatalogue(undefined)).toBe(false);
  });
});

describe('isChargeInProgress', () => {
  it('is true only for the DUPLICATE_REQUEST that names the header', () => {
    // The first request with this key is still running: the key must be kept so the next
    // click collects that purchase instead of opening another one (PLAN 5.4).
    expect(
      isChargeInProgress(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['Idempotency-Key'], message: 'in progress' }]),
      ),
    ).toBe(true);
  });

  it('is false for the other 409 and for everything else', () => {
    // Same key, different terms: the key was spent by a different purchase, so a new one is
    // right. Nothing else says anything about the key at all.
    expect(isChargeInProgress(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
    expect(isChargeInProgress(apiError(409, 'PRICE_MOVED'))).toBe(false);
    expect(
      isChargeInProgress(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['Idempotency-Key'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isChargeInProgress(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isForAnotherAccount', () => {
  it('is true only for the FORBIDDEN that names the account field', () => {
    // The screen showed A, the cookie was B's: the server refused to charge, or redeem for, B.
    expect(
      isForAnotherAccount(
        apiError(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for the CSRF 403, for other codes and for a transport failure', () => {
    expect(isForAnotherAccount(apiError(403, 'FORBIDDEN'))).toBe(false);
    expect(
      isForAnotherAccount(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['expectedAccountId'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isForAnotherAccount(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isCouponRejection', () => {
  it('is true only for the one answer the API gives about the code itself', () => {
    // Unknown, disabled, expired and exhausted are deliberately indistinguishable (A-M2-9)
    // and all arrive as a VALIDATION_ERROR naming `code`.
    expect(
      isCouponRejection(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['code'], message: 'invalid or expired' }]),
      ),
    ).toBe(true);
  });

  it('leaves everything else off the field, where it would call a good code invalid', () => {
    // Its NOT_FOUND means the account has no balance row; a 500, a dead session or an
    // unreachable API say nothing about what the user typed.
    expect(isCouponRejection(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isCouponRejection(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isCouponRejection(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isCouponRejection(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    expect(isCouponRejection(new TypeError('Failed to fetch'))).toBe(false);
    // The duplicate is handled on its own branch before this predicate runs.
    expect(isCouponRejection(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
  });
});

describe('BALANCE_HISTORY_KEYS', () => {
  it('reaches 원장 and 결제 내역, and nothing else of the wallet', async () => {
    // What the `user:balance` handler restarts: an admin refund moves a payment as well as the
    // balance, and 결제 내역 must not go on saying 완료 beside the ledger.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };
    const held = [LEDGER_QUERY_KEY, PAYMENTS_QUERY_KEY, ME_QUERY_KEY, CHARGE_PACKAGES_QUERY_KEY];
    for (const key of held) queryClient.setQueryData(key, page);
    try {
      for (const key of BALANCE_HISTORY_KEYS) await restartQueries(queryClient, key);
      const invalidated = held.map((key) => queryClient.getQueryState(key)?.isInvalidated ?? false);
      expect(invalidated).toEqual([true, true, false, false]);
    } finally {
      queryClient.clear();
    }
  });
});

describe('paymentsRefetchInterval', () => {
  const row = (id: string, status: Payment['status']): Payment => ({
    id,
    amountCoin: '10000',
    priceKrw: 9900,
    packageId: null,
    provider: 'mock',
    providerRef: 'mock_0123456789',
    status,
    method: null,
    approvedAt: '2026-09-20T03:00:00.000Z',
    refundedAt: null,
    resultMessage: null,
    cancelConfirmed: null,
    createdAt: '2026-09-20T02:59:00.000Z',
  });
  const older = row('00000000-0000-4000-8000-0000000000c1', 'succeeded');
  const refunding = row('00000000-0000-4000-8000-0000000000c2', 'refunding');

  it("polls 결제 내역 over every loaded page while a row is in flight, by the query's count", () => {
    const queryClient = new QueryClient();
    const interval = paymentsRefetchInterval(paymentsPoll());
    // The cache's own query object, as query-core hands it to `refetchInterval` (typed by the
    // key alone here, so its data is narrowed to what `usePayments` stores under it).
    const query = () => {
      const found = queryClient.getQueryCache().find({ queryKey: PAYMENTS_QUERY_KEY, exact: true });
      if (!found) throw new Error('no payments query');
      return found as Parameters<typeof interval>[0];
    };
    try {
      // The refund under way sits on the second loaded page.
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [
          { items: [older], nextCursor: 'c1' },
          { items: [refunding], nextCursor: null },
        ],
        pageParams: [undefined, 'c1'],
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      // The finish landed (환불됨): nothing left to wait on.
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [
          { items: [older], nextCursor: 'c1' },
          { items: [{ ...refunding, status: 'refunded' }], nextCursor: null },
        ],
        pageParams: [undefined, 'c1'],
      });
      expect(interval(query())).toBe(false);
    } finally {
      queryClient.clear();
    }
    // Nothing loaded yet: nothing to wait on.
    expect(interval({ state: { data: undefined, dataUpdateCount: 0, errorUpdateCount: 0 } })).toBe(
      false,
    );
  });

  it('spends the budget on failed fetches too: a list that keeps failing stops polling', async () => {
    // A 401 once the session expired is never retried; neither is anything here.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const interval = paymentsRefetchInterval(paymentsPoll());
    const query = () => {
      const found = queryClient.getQueryCache().find({ queryKey: PAYMENTS_QUERY_KEY, exact: true });
      if (!found) throw new Error('no payments query');
      return found as Parameters<typeof interval>[0];
    };
    const refetchFails = () =>
      queryClient.prefetchInfiniteQuery({
        queryKey: PAYMENTS_QUERY_KEY,
        queryFn: () => Promise.reject(apiError(401, 'UNAUTHENTICATED')),
        initialPageParam: undefined as string | undefined,
      });
    try {
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, {
        pages: [{ items: [refunding], nextCursor: null }],
        pageParams: [undefined],
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      for (let fetch = 1; fetch < PAYMENT_POLL_LIMIT; fetch += 1) await refetchFails();
      // The rows stay what the list last loaded, and query-core counts no failure as data.
      expect(query().state).toMatchObject({
        status: 'error',
        dataUpdateCount: 1,
        errorUpdateCount: PAYMENT_POLL_LIMIT - 1,
      });
      expect(interval(query())).toBe(PAYMENT_POLL_INTERVAL_MS);
      await refetchFails();
      expect(interval(query())).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});
