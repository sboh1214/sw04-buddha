import { QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Dispute, type Market, api } from '@/lib/api';
import { DISPUTES_KEY, marketKey, myDisputesKey } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import { applyDisputeError, applyDisputeFiled, myDisputeQueryOptions } from './use-disputes';

/**
 * The dispute section's cache decisions, driven through the REAL QueryClient (`getQueryClient()`
 * answers a fresh one per call under node, so these run against the defaults the app ships).
 * Nothing renders: apps/web runs vitest under `environment: 'node'`, which is why every decision
 * below lives in an exported function rather than in the hook.
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

const market: Market = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'resolving',
  lastPrice: 50,
  pYesBp: 5000,
  volumeP: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: 'YES',
  resolvedAt: '2026-10-01T01:00:00.000Z',
  disputeUntil: '2026-10-02T01:00:00.000Z',
  settledAt: null,
  voidedAt: null,
  statusEventId: '4',
  createdAt: '2026-08-30T00:00:00.000Z',
};

const dispute: Dispute = {
  id: 'c0ffee00-0000-4000-8000-000000000001',
  marketId: ID,
  marketSlug: market.slug,
  marketTitle: market.title,
  marketStatus: 'resolving',
  resolvedResult: 'YES',
  reason: '한국은행 발표는 동결이었습니다.',
  evidenceUrl: null,
  status: 'open',
  adminNote: null,
  reviewedAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: code, details } as never);

/** A page of `GET /me/disputes` as openapi-fetch hands it back. */
const page = (rows: Dispute[]) => ({
  data: { data: rows, meta: { nextCursor: null } },
  error: undefined,
  response: new Response(null, { status: 200 }),
});

/**
 * A query on its FIRST fetch: nothing cached, one request in flight. Answers a first value and
 * a marker after, so a test can tell "restarted" from "subscribed to what was already running"
 * by the count alone (the `use-trade.test.ts` idiom).
 */
function firstFetch<T>(
  queryClient: ReturnType<typeof getQueryClient>,
  queryKey: readonly unknown[],
  first: T,
  later: T,
) {
  let fetches = 0;
  const observer = new QueryObserver<T>(queryClient, {
    queryKey,
    queryFn: () => {
      fetches += 1;
      return Promise.resolve(fetches === 1 ? first : later);
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { count: () => fetches, inflight: observer.refetch(), unsubscribe };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('myDisputeQueryOptions', () => {
  it('keys on the canonical uuid and waits for the session', () => {
    // An upper-case segment lands on the entry the file mutation seeds (A-M3-29), and a
    // signed-out visitor never provokes the 401 the retry rule refuses to retry.
    expect(myDisputeQueryOptions(ID.toUpperCase()).queryKey).toEqual(myDisputesKey(ID));
    expect(myDisputeQueryOptions(ID).enabled).toBe(false);
    expect(myDisputeQueryOptions(ID, null).enabled).toBe(false);
    expect(myDisputeQueryOptions(ID, { user: { id: 'u1' } }).enabled).toBe(true);
    // And for the market's status as well: signed in on an open market asks for nothing.
    expect(myDisputeQueryOptions(ID, { user: { id: 'u1' } }, false).enabled).toBe(false);
  });

  it('answers the one row, or null for none — never undefined', async () => {
    // `undefined` would leave the query pending forever: react-query reads it as a queryFn that
    // returned nothing. "No dispute" is the answer for nearly every visitor, and it is the one
    // the section needs before it may offer the button.
    const get = vi.spyOn(api, 'GET').mockResolvedValue(page([]));
    await expect(myDisputeQueryOptions(ID, { user: {} }).queryFn()).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith('/api/v1/me/disputes', {
      params: { query: { marketId: ID } },
    });
    get.mockResolvedValue(page([dispute]));
    await expect(myDisputeQueryOptions(ID, { user: {} }).queryFn()).resolves.toEqual(dispute);
  });
});

describe('applyDisputeFiled', () => {
  it('seeds the row where the section reads and re-asks every other entry under the root', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData<Dispute | null>(myDisputesKey(ID), null);
    queryClient.setQueryData<Dispute | null>(myDisputesKey(OTHER_ID), null);
    try {
      // Upper-case on purpose: the seed keys on the row's `marketId` through `myDisputesKey`,
      // which canonicalises, so it lands on the entry the section reads (A-M3-29).
      await applyDisputeFiled(queryClient, { ...dispute, marketId: ID.toUpperCase() });

      // The section flips to 이의 접수됨 on the seed itself — no event carries a dispute, so
      // nothing else would deliver it — and the seeded entry is NOT re-asked: a refetch of it
      // could only restate what was just written.
      expect(queryClient.getQueryData<Dispute | null>(myDisputesKey(ID))).toEqual({
        ...dispute,
        marketId: ID.toUpperCase(),
      });
      expect(queryClient.getQueryState(myDisputesKey(ID))?.isInvalidated).toBe(false);
      // Any other list of the account's disputes must not go on saying there is none.
      expect(queryClient.getQueryState(myDisputesKey(OTHER_ID))?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });

  it('writes the row even into a cache that held no entry yet', () => {
    // Unlike a `Me` or a position list, the row IS the whole answer, so there is nothing a
    // later fetch could add — and the section is only ever mounted once the row was asked for.
    const queryClient = getQueryClient();
    try {
      void applyDisputeFiled(queryClient, dispute);
      expect(queryClient.getQueryData<Dispute | null>(myDisputesKey(ID))).toEqual(dispute);
    } finally {
      queryClient.clear();
    }
  });
});

describe('applyDisputeError', () => {
  it('re-asks the market for a closed window, restarting a first fetch still in flight', async () => {
    // The cached row said the window was open and the server said it is not: its
    // `disputeUntil` is past, or its status has moved. An unseeded first fetch (the portfolio
    // shape) would be waited on by a bare invalidation and land the pre-transition snapshot.
    const queryClient = getQueryClient();
    const detail = firstFetch<Market>(queryClient, marketKey(ID), market, {
      ...market,
      status: 'settled',
    });
    try {
      await applyDisputeError(
        queryClient,
        ID,
        apiError(409, 'DISPUTE_WINDOW_CLOSED'),
        () => undefined,
      );
      await detail.inflight;
      expect(detail.count()).toBe(2);
      // The dispute root is untouched: there is no row to re-ask for.
      expect(queryClient.getQueryState(myDisputesKey(ID))).toBeUndefined();
    } finally {
      detail.unsubscribe();
      queryClient.clear();
    }
  });

  it('re-asks the account’s disputes for a duplicate, so the row filed elsewhere is drawn', async () => {
    // A row EXISTS that this tab's cache does not show — filed in another tab, or by a press
    // whose answer was lost. The refetch is the only path to it.
    const queryClient = getQueryClient();
    const mine = firstFetch<Dispute | null>(queryClient, myDisputesKey(ID), null, dispute);
    try {
      await applyDisputeError(queryClient, ID, apiError(409, 'DUPLICATE_REQUEST'), () => undefined);
      await mine.inflight;
      expect(mine.count()).toBe(2);
      expect(queryClient.getQueryData<Dispute | null>(myDisputesKey(ID))).toEqual(dispute);
    } finally {
      mine.unsubscribe();
      queryClient.clear();
    }
  });

  it('re-asks the market when the server says it is not resolving, and only then', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), market);
    queryClient.setQueryData<Dispute | null>(myDisputesKey(ID), null);
    try {
      await applyDisputeError(
        queryClient,
        ID,
        apiError(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'not resolving' }]),
        () => undefined,
      );
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(myDisputesKey(ID))?.isInvalidated).toBe(false);

      // A field-naming VALIDATION_ERROR contradicts no cache: the dialog shows it under the
      // field, and nothing is re-asked.
      queryClient.setQueryData<Market>(marketKey(ID), market);
      await applyDisputeError(
        queryClient,
        ID,
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too long' }]),
        () => undefined,
      );
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  it('asks better-auth for a session that ended, and the market for one that vanished', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), market);
    try {
      let sessionRefetched = 0;
      await applyDisputeError(queryClient, ID, apiError(401, 'UNAUTHENTICATED'), () => {
        sessionRefetched += 1;
      });
      expect(sessionRefetched).toBe(1);
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(false);

      await applyDisputeError(queryClient, ID, apiError(404, 'NOT_FOUND'), () => undefined);
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });

  it('corrects nothing for a failure the server did not answer', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), market);
    queryClient.setQueryData<Dispute | null>(myDisputesKey(ID), null);
    try {
      await applyDisputeError(queryClient, ID, new TypeError('Failed to fetch'), () => undefined);
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(DISPUTES_KEY)).toBeUndefined();
      expect(queryClient.getQueryState(myDisputesKey(ID))?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});
