import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_MARKET_SUPPLEMENTS_KEY,
  type AdminMarketSupplementPage,
} from '@/hooks/use-admin-markets';
import { type AdminMarketSupplementItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketSupplements } from './admin-market-supplements';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (
  requestId: string,
  fields: Partial<AdminMarketSupplementItem> = {},
): AdminMarketSupplementItem => ({
  requestId,
  marketId: MARKET,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'open',
  closeAt: '2026-11-29T15:00:00.000Z',
  requestedBy: { id: 'requester', nickname: '요청한이' },
  requestedAt: '2026-11-02T01:00:00.000Z',
  baseVersion: 1,
  items: ['closeAt', 'description'],
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketSupplementPage[]) =>
  renderWithQueries(<AdminMarketSupplements />, [
    [
      ADMIN_MARKET_SUPPLEMENTS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 규칙 보충 대기 as drawn (#80, ADR-0101): every waiting supplement request in the order the API
 * answers — the oldest first (admin-markets-supplement.controller.test.ts) — one row each, the
 * question to its market's admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketSupplements', () => {
  it('draws one row per request in the order answered, every column in KST and by nickname', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, { status: 'closed', requestedBy: { id: 'gone', nickname: null } }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-market-supplements')?.text).toContain(copy.adminMarketSupplements);
    expect(
      testIdsStartingWith(html, 'admin-market-supplement-').filter((id) =>
        /^admin-market-supplement-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-market-supplement-${FIRST}`, `admin-market-supplement-${SECOND}`]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketSupplementsColTitle,
      copy.adminMarketSupplementsColStatus,
      copy.adminMarketSupplementsColRequestedBy,
      copy.adminMarketSupplementsColRequestedAt,
      copy.adminMarketSupplementsColBase,
      copy.adminMarketSupplementsColItems,
      copy.adminMarketSupplementsColCloseAt,
    ]);
    const first = byTestId(html, `admin-market-supplement-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(MARKET);
    expect(first?.text).toContain('첫눈이 올까?');
    expect(first?.text).toContain(copy.marketStatusOpen);
    expect(first?.text).toContain(formatKst('2026-11-02T01:00:00.000Z'));
    expect(first?.text).toContain('v1');
    expect(first?.text).toContain(formatKst('2026-11-29T15:00:00.000Z'));
    expect(byTestId(html, `admin-market-supplement-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-market-supplement-requested-by-${FIRST}`)?.text).toBe('요청한이');
    // In RULE_VERSION_ITEMS order whatever order they came in.
    expect(byTestId(html, `admin-market-supplement-items-${FIRST}`)?.text).toBe(
      '배경 · 거래 마감 시각',
    );
    // A request still waiting at the close is listed with its market's status; a closed account
    // as every byline names it.
    expect(byTestId(html, `admin-market-supplement-${SECOND}`)?.text).toContain(
      copy.marketStatusClosed,
    );
    expect(byTestId(html, `admin-market-supplement-requested-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, 'admin-market-supplements-more')).toBeUndefined();
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-supplements-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-supplements-empty')?.text).toBe(
      copy.adminMarketSupplementsEmpty,
    );
    expect(byTestId(html, 'admin-market-supplements-list')).toBeUndefined();
  });
});
