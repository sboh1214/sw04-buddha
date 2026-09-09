import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  adminDisputeFiltersFromSearchParams,
  disputeCountsLabel,
  groupDisputesByMarket,
  normalizeAdminDisputeFilters,
  replaceDisputeRow,
  reviewDisputeFormSchema,
  reviewErrorMessage,
  toReviewDisputeBody,
} from './admin-disputes';
import { type AdminDispute, ApiError } from './api';

const MARKET_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MARKET_B = '5c1f8a02-1d3e-4b7a-9c88-0b2f6d4e1a99';

function dispute(overrides: Partial<AdminDispute> = {}): AdminDispute {
  return {
    id: 'a1e1c0de-0000-4000-8000-000000000001',
    marketId: MARKET_A,
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
    ...overrides,
  };
}

const apiError = (status: number, code: string, message = 'x', details?: unknown) =>
  new ApiError(status, {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  } as never);

describe('adminDisputeFiltersFromSearchParams', () => {
  it('reads a valid status and a uuid market id, lower-casing the id', () => {
    expect(adminDisputeFiltersFromSearchParams({ status: 'open' })).toEqual({ status: 'open' });
    // The API answers rows with the canonical lower-case id (A-M3-29), so the key must too.
    expect(adminDisputeFiltersFromSearchParams({ marketId: MARKET_A.toUpperCase() })).toEqual({
      marketId: MARKET_A,
    });
    expect(adminDisputeFiltersFromSearchParams({ status: 'rejected', marketId: MARKET_A })).toEqual(
      { status: 'rejected', marketId: MARKET_A },
    );
  });

  it('drops what the API would refuse rather than sending it', () => {
    // A hand-typed `?status=x` or a non-uuid `marketId` would be a 400 on a page that should
    // simply show the unfiltered list.
    expect(adminDisputeFiltersFromSearchParams({ status: 'pending' })).toEqual({});
    expect(adminDisputeFiltersFromSearchParams({ marketId: 'abc' })).toEqual({});
    expect(adminDisputeFiltersFromSearchParams({ status: '', marketId: '' })).toEqual({});
    expect(adminDisputeFiltersFromSearchParams({})).toEqual({});
  });

  it('takes the first value of a repeated parameter', () => {
    expect(
      adminDisputeFiltersFromSearchParams({ status: ['accepted', 'open'], marketId: [MARKET_B] }),
    ).toEqual({ status: 'accepted', marketId: MARKET_B });
  });

  it('never writes an undefined-valued key', () => {
    // `hashKey` would drop it anyway; the object is kept clean so `toEqual` and a future
    // stricter hasher agree with it.
    expect(Object.keys(normalizeAdminDisputeFilters({ status: undefined }))).toEqual([]);
    expect(normalizeAdminDisputeFilters({ marketId: MARKET_A.toUpperCase() })).toEqual({
      marketId: MARKET_A,
    });
  });
});

describe('groupDisputesByMarket', () => {
  it('groups the newest-first rows by market, in order of each market’s newest dispute', () => {
    const rows = [
      dispute({ id: 'd3', marketId: MARKET_B, marketTitle: '첫눈?', marketSlug: 'first-snow' }),
      dispute({ id: 'd2' }),
      dispute({ id: 'd1', marketId: MARKET_B, marketTitle: '첫눈?', marketSlug: 'first-snow' }),
    ];
    const groups = groupDisputesByMarket(rows);
    expect(groups.map((g) => g.marketId)).toEqual([MARKET_B, MARKET_A]);
    expect(groups[0]?.disputes.map((d) => d.id)).toEqual(['d3', 'd1']);
    expect(groups[1]?.disputes.map((d) => d.id)).toEqual(['d2']);
    expect(groups[0]).toMatchObject({
      marketTitle: '첫눈?',
      marketSlug: 'first-snow',
      marketStatus: 'resolving',
      resolvedResult: 'YES',
    });
  });

  it('heads the group with the market as its newest row describes it', () => {
    // Across pages the older row may predate a result change; the newer answer is trusted.
    const groups = groupDisputesByMarket([
      dispute({ id: 'd2', resolvedResult: 'NO', marketStatus: 'settled' }),
      dispute({ id: 'd1', resolvedResult: 'YES', marketStatus: 'resolving' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.resolvedResult).toBe('NO');
    expect(groups[0]?.marketStatus).toBe('settled');
  });

  it('is empty for no rows', () => {
    expect(groupDisputesByMarket([])).toEqual([]);
  });
});

describe('disputeCountsLabel', () => {
  it('reads "접수 N · 수용 N · 기각 N"', () => {
    expect(disputeCountsLabel({ open: 2, accepted: 1, rejected: 0 })).toBe(
      `${copy.adminMarketDisputesOpen} 2 · ${copy.adminMarketDisputesAccepted} 1 · ${copy.adminMarketDisputesRejected} 0`,
    );
  });
});

describe('reviewDisputeFormSchema / toReviewDisputeBody', () => {
  it('bounds the note to 1,000 characters and trims it', () => {
    expect(reviewDisputeFormSchema.safeParse({ adminNote: '  근거 확인  ' }).data).toEqual({
      adminNote: '근거 확인',
    });
    expect(reviewDisputeFormSchema.safeParse({ adminNote: 'a'.repeat(1000) }).success).toBe(true);
    expect(
      reviewDisputeFormSchema
        .safeParse({ adminNote: 'a'.repeat(1001) })
        .error?.issues.map((issue) => issue.message),
    ).toEqual([copy.errMarketResolveNote]);
  });

  it('sends the verdict with a blank note as null', () => {
    expect(toReviewDisputeBody('accepted', { adminNote: '' })).toEqual({
      status: 'accepted',
      adminNote: null,
    });
    expect(toReviewDisputeBody('rejected', { adminNote: ' 출처 확인함 ' })).toEqual({
      status: 'rejected',
      adminNote: '출처 확인함',
    });
  });
});

describe('reviewErrorMessage', () => {
  it('names a dispute that does not exist, and a note the API refused', () => {
    expect(reviewErrorMessage(apiError(404, 'NOT_FOUND', 'Dispute not found'))).toBe(
      copy.adminDisputeNotFound,
    );
    expect(
      reviewErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['adminNote'], message: 'too long' }]),
      ),
    ).toBe(copy.errMarketResolveNote);
    expect(
      reviewErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message: 'bad' }]),
      ),
    ).toBe(copy.errMarketInvalid);
  });

  it('falls back to the generic message', () => {
    expect(reviewErrorMessage(apiError(403, 'FORBIDDEN'))).toBe(copy.errUnknown);
    expect(reviewErrorMessage(new Error('network'))).toBe(copy.errUnknown);
  });
});

describe('replaceDisputeRow', () => {
  const page = (...items: AdminDispute[]) => ({ items, nextCursor: null });

  it('writes the reviewed row over its copy, copying only the page that held it', () => {
    const untouched = page(dispute({ id: 'd9', marketId: MARKET_B }));
    const held = page(dispute({ id: 'd1' }), dispute({ id: 'd2' }));
    const data = { pages: [untouched, held], pageParams: [undefined, 'c1'] };
    const fresh = dispute({ id: 'd2', status: 'rejected', adminNote: '출처 확인함' });

    const next = replaceDisputeRow(data, fresh);
    expect(next).not.toBe(data);
    expect(next?.pages[0]).toBe(untouched);
    expect(next?.pages[1]?.items.map((row) => row.status)).toEqual(['open', 'rejected']);
    expect(next?.pages[1]?.items[1]).toBe(fresh);
    // The cached object is never mutated: the previous render's rows are still what they were.
    expect(held.items[1]?.status).toBe('open');
    expect(next?.pageParams).toEqual(data.pageParams);
  });

  it('answers the same object when no page holds the row, and undefined for no cache', () => {
    // A list filtered to another status never held it; react-query must see no change.
    const data = { pages: [page(dispute({ id: 'd1' }))], pageParams: [undefined] };
    expect(replaceDisputeRow(data, dispute({ id: 'd7' }))).toBe(data);
    expect(replaceDisputeRow(undefined, dispute())).toBeUndefined();
  });
});
