import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_MARKET_CANCEL_REQUESTS_KEY,
  type AdminMarketCancelRequestPage,
} from '@/hooks/use-admin-markets';
import { type AdminMarketCancelItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketCancelRequests } from './admin-market-cancel-requests';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (
  requestId: string,
  fields: Partial<AdminMarketCancelItem> = {},
): AdminMarketCancelItem => ({
  requestId,
  marketId: MARKET,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'scheduled',
  scheduledOpenAt: '2026-11-20T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  reason: '출처가 사라져 판정할 수 없습니다.',
  requestedBy: { id: 'requester', nickname: '요청한이' },
  requestedAt: '2026-11-05T04:00:00.000Z',
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketCancelRequestPage[]) =>
  renderWithQueries(<AdminMarketCancelRequests />, [
    [
      ADMIN_MARKET_CANCEL_REQUESTS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 시장 취소 대기 as drawn (#20, ADR-0117): every waiting cancel request in the order the API answers
 * — the oldest first (admin-market-cancels.controller.test.ts) — one row each, the question to its
 * market's admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketCancelRequests', () => {
  it('draws one row per request in the order answered: reason, by nickname, open in KST', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            status: 'open',
            scheduledOpenAt: null,
            requestedBy: { id: 'gone', nickname: null },
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-market-cancel-requests')?.text).toContain(
      copy.adminMarketCancelRequests,
    );
    expect(
      testIdsStartingWith(html, 'admin-market-cancel-request-').filter((id) =>
        /^admin-market-cancel-request-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-market-cancel-request-${FIRST}`, `admin-market-cancel-request-${SECOND}`]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketPauseDecisionsColTitle,
      copy.adminMarketPauseDecisionsColStatus,
      copy.adminMarketCancelReason,
      copy.adminMarketPauseDecisionsColRequestedBy,
      copy.adminMarketPauseDecisionsColRequestedAt,
      copy.adminMarketCancelRequestsColOpenAt,
    ]);
    const first = byTestId(html, `admin-market-cancel-request-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(MARKET);
    expect(first?.text).toContain('첫눈이 올까?');
    expect(first?.text).toContain(copy.marketStatusScheduled);
    expect(first?.text).toContain(formatKst('2026-11-05T04:00:00.000Z'));
    expect(byTestId(html, `admin-market-cancel-request-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-market-cancel-request-reason-${FIRST}`)?.text).toBe(
      '출처가 사라져 판정할 수 없습니다.',
    );
    expect(byTestId(html, `admin-market-cancel-request-open-at-${FIRST}`)?.text).toBe(
      formatKst('2026-11-20T00:00:00.000Z'),
    );
    expect(byTestId(html, `admin-market-cancel-request-requested-by-${FIRST}`)?.text).toBe(
      '요청한이',
    );
    // A request whose market opened meanwhile is listed with its status, for its 반려 or 철회; no
    // scheduled open reads '—', and a closed account as every byline names it.
    expect(byTestId(html, `admin-market-cancel-request-${SECOND}`)?.text).toContain(
      copy.marketStatusOpen,
    );
    expect(byTestId(html, `admin-market-cancel-request-open-at-${SECOND}`)?.text).toBe('—');
    expect(byTestId(html, `admin-market-cancel-request-requested-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, 'admin-market-cancel-requests-more')).toBeUndefined();
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-cancel-requests-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-cancel-requests-empty')?.text).toBe(
      copy.adminMarketCancelRequestsEmpty,
    );
    expect(byTestId(html, 'admin-market-cancel-requests-list')).toBeUndefined();
  });
});
