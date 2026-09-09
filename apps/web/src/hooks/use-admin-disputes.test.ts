import { QueryClient, hashKey, partialMatchKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type DisputePage } from '@/lib/admin-disputes';
import { type AdminDispute } from '@/lib/api';
import { isPrivateQueryKey } from '@/lib/market-keys';
import {
  ADMIN_DISPUTES_KEY,
  adminDisputesInfiniteQueryOptions,
  adminDisputesKey,
  applyReviewedDispute,
} from './use-admin-disputes';
import { adminMarketKey } from './use-admin-markets';

const MARKET_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function dispute(overrides: Partial<AdminDispute> = {}): AdminDispute {
  return {
    id: 'a1e1c0de-0000-4000-8000-000000000001',
    marketId: MARKET_ID,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    marketStatus: 'resolving',
    resolvedResult: 'YES',
    userId: 'u1',
    nickname: '민수',
    reason: '한국은행 발표는 동결이었습니다.',
    evidenceUrl: null,
    status: 'open',
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    /** The market snapshot's order (A-M3-19); `groupDisputesByMarket` is what compares it. */
    statusEventId: '5',
    ...overrides,
  };
}

describe('adminDisputesKey', () => {
  it('hangs every filtered list off the admin root, one entry per normalised filter set', () => {
    expect(adminDisputesKey({})).toEqual([...ADMIN_DISPUTES_KEY, {}]);
    expect(partialMatchKey(adminDisputesKey({ status: 'open' }), ADMIN_DISPUTES_KEY)).toBe(true);
    // Session-scoped, never dehydrated into an SSR payload (PRIVATE_QUERY_ROOTS).
    expect(isPrivateQueryKey(adminDisputesKey({}))).toBe(true);
  });

  it('hashes an absent, an undefined and an upper-case filter to the same entries', () => {
    expect(hashKey(adminDisputesKey({ status: undefined }))).toBe(hashKey(adminDisputesKey({})));
    expect(hashKey(adminDisputesKey({ marketId: MARKET_ID.toUpperCase() }))).toBe(
      hashKey(adminDisputesKey({ marketId: MARKET_ID })),
    );
    expect(hashKey(adminDisputesKey({ status: 'open' }))).not.toBe(
      hashKey(adminDisputesKey({ status: 'accepted' })),
    );
  });

  it('keys the query options the same way and starts from no cursor', () => {
    const options = adminDisputesInfiniteQueryOptions({ status: 'open', marketId: MARKET_ID });
    expect(options.queryKey).toEqual(adminDisputesKey({ status: 'open', marketId: MARKET_ID }));
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c2' })).toBe('c2');
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });
});

describe('applyReviewedDispute', () => {
  const page = (...items: AdminDispute[]): DisputePage => ({ items, nextCursor: null });

  it('seeds the reviewed row into every cached list and invalidates the list and the market', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const open = dispute({ id: 'd1' });
      queryClient.setQueryData(adminDisputesKey({}), {
        pages: [page(open)],
        pageParams: [undefined],
      });
      queryClient.setQueryData(adminDisputesKey({ status: 'open' }), {
        pages: [page(open)],
        pageParams: [undefined],
      });
      const other = { pages: [page(dispute({ id: 'd9' }))], pageParams: [undefined] };
      queryClient.setQueryData(adminDisputesKey({ status: 'rejected' }), other);
      queryClient.setQueryData(adminMarketKey(MARKET_ID), { id: MARKET_ID });

      const reviewed = dispute({ id: 'd1', status: 'rejected', adminNote: '출처 확인함' });
      await applyReviewedDispute(queryClient, reviewed);

      // The bug the seed closes: the PATCH succeeded and the toast said so, but with the
      // response discarded and the refetch failing the row would still read 접수.
      const read = (filters: Parameters<typeof adminDisputesKey>[0]) =>
        queryClient.getQueryData<{ pages: DisputePage[] }>(adminDisputesKey(filters))?.pages[0]
          ?.items[0];
      expect(read({})?.status).toBe('rejected');
      expect(read({ status: 'open' })?.adminNote).toBe('출처 확인함');
      // A list that never held the row is left exactly as it was.
      expect(queryClient.getQueryData(adminDisputesKey({ status: 'rejected' }))).toBe(other);

      for (const filters of [{}, { status: 'open' as const }, { status: 'rejected' as const }]) {
        expect(queryClient.getQueryState(adminDisputesKey(filters))?.isInvalidated).toBe(true);
      }
      // The detail's 이의 counts moved with the review.
      expect(queryClient.getQueryState(adminMarketKey(MARKET_ID))?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });
});
