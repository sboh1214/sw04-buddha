import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_MARKET_REVIEWS_KEY, type AdminMarketReviewPage } from '@/hooks/use-admin-markets';
import { type AdminMarketReviewItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketReviews } from './admin-market-reviews';

const FIRST = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000001';

const row = (
  marketId: string,
  fields: Partial<AdminMarketReviewItem> = {},
): AdminMarketReviewItem => ({
  marketId,
  slug: `market-${marketId.slice(0, 4)}`,
  title: `질문 ${marketId.slice(0, 4)}`,
  categoryName: '경제',
  scheduledOpenAt: '2026-11-10T00:00:00.000Z',
  closeAt: '2026-11-20T00:00:00.000Z',
  requestedBy: { id: 'submitter', nickname: '낸이' },
  requestedAt: '2026-11-01T01:00:00.000Z',
  createdBy: { id: 'creator', nickname: '만든이' },
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketReviewPage[]) =>
  renderWithQueries(<AdminMarketReviews />, [
    [
      ADMIN_MARKET_REVIEWS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 검수 대기 as drawn (#78, ADR-0099): every market in review in the order the API answers — the
 * oldest submission first (admin-markets-review.controller.test.ts) — one table row each, the title
 * to its admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketReviews', () => {
  it('draws one row per market in the order answered, every column in KST and by nickname', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            scheduledOpenAt: null,
            createdBy: { id: 'gone', nickname: null },
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-market-reviews')?.text).toContain(copy.adminMarketReviews);
    expect(
      testIdsStartingWith(html, 'admin-market-review-').filter((id) =>
        /^admin-market-review-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-market-review-${FIRST}`, `admin-market-review-${SECOND}`]);
    const headers = byTagName(html, 'th').map((cell) => cell.text);
    expect(headers).toEqual([
      copy.adminMarketReviewsColTitle,
      copy.adminMarketReviewsColCategory,
      copy.adminMarketReviewsColRequestedBy,
      copy.adminMarketReviewsColRequestedAt,
      copy.adminMarketReviewsColCreatedBy,
      copy.adminMarketReviewsColScheduledOpenAt,
      copy.adminMarketReviewsColCloseAt,
    ]);
    const first = byTestId(html, `admin-market-review-${FIRST}`);
    expect(first?.text).toContain('질문 3f25');
    expect(first?.text).toContain('경제');
    expect(first?.text).toContain(formatKst('2026-11-01T01:00:00.000Z'));
    expect(first?.text).toContain(formatKst('2026-11-10T00:00:00.000Z'));
    expect(first?.text).toContain(formatKst('2026-11-20T00:00:00.000Z'));
    expect(byTestId(html, `admin-market-review-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${FIRST}`,
    );
    expect(byTestId(html, `admin-market-review-requested-by-${FIRST}`)?.text).toBe('낸이');
    expect(byTestId(html, `admin-market-review-created-by-${FIRST}`)?.text).toBe('만든이');
    // A closed account as every byline names it; no scheduled open as '—'.
    expect(byTestId(html, `admin-market-review-created-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, `admin-market-review-${SECOND}`)?.text).toContain('—');
    expect(byTestId(html, 'admin-market-reviews-more')).toBeUndefined();
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-reviews-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits for a review', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-reviews-empty')?.text).toBe(copy.adminMarketReviewsEmpty);
    expect(byTestId(html, 'admin-market-reviews-list')).toBeUndefined();
  });
});
