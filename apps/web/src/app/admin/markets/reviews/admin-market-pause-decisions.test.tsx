import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_MARKET_PAUSE_DECISIONS_KEY,
  type AdminMarketPauseDecisionPage,
} from '@/hooks/use-admin-markets';
import { type AdminMarketPauseDecisionItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketPauseDecisions } from './admin-market-pause-decisions';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (
  requestId: string,
  fields: Partial<AdminMarketPauseDecisionItem> = {},
): AdminMarketPauseDecisionItem => ({
  requestId,
  marketId: MARKET,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'paused',
  closeAt: '2026-11-29T15:00:00.000Z',
  pauseId: 'b1b2c3d4-0000-4000-8000-000000000001',
  reason: 'basis_change',
  path: 'early_close',
  reviewResult: 'judgeable',
  requestedBy: { id: 'requester', nickname: '요청한이' },
  requestedAt: '2026-11-05T04:00:00.000Z',
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketPauseDecisionPage[]) =>
  renderWithQueries(<AdminMarketPauseDecisions />, [
    [
      ADMIN_MARKET_PAUSE_DECISIONS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 일시 중단 결정 대기 as drawn (#114, ADR-0102): every waiting 재개·조기 마감 request in the order the
 * API answers — the oldest first (admin-market-pauses.controller.test.ts) — one row each, the
 * question to its market's admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketPauseDecisions', () => {
  it('draws one row per request in the order answered: reason, path, review, by nickname, in KST', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            status: 'closed',
            reason: 'ledger_failure',
            path: 'resume',
            reviewResult: null,
            requestedBy: { id: 'gone', nickname: null },
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-market-pause-decisions')?.text).toContain(
      copy.adminMarketPauseDecisions,
    );
    expect(
      testIdsStartingWith(html, 'admin-market-pause-decision-').filter((id) =>
        /^admin-market-pause-decision-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-market-pause-decision-${FIRST}`, `admin-market-pause-decision-${SECOND}`]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketPauseDecisionsColTitle,
      copy.adminMarketPauseDecisionsColStatus,
      copy.adminMarketPauseDecisionsColReason,
      copy.adminMarketPauseDecisionsColPath,
      copy.adminMarketPauseDecisionsColReview,
      copy.adminMarketPauseDecisionsColRequestedBy,
      copy.adminMarketPauseDecisionsColRequestedAt,
      copy.adminMarketPauseDecisionsColCloseAt,
    ]);
    const first = byTestId(html, `admin-market-pause-decision-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(MARKET);
    expect(first?.text).toContain('첫눈이 올까?');
    expect(first?.text).toContain(copy.marketStatusPaused);
    expect(first?.text).toContain(formatKst('2026-11-05T04:00:00.000Z'));
    expect(first?.text).toContain(formatKst('2026-11-29T15:00:00.000Z'));
    expect(byTestId(html, `admin-market-pause-decision-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-market-pause-decision-reason-${FIRST}`)?.text).toBe(
      '실질 기준 변경',
    );
    expect(byTestId(html, `admin-market-pause-decision-path-${FIRST}`)?.text).toBe('조기 마감');
    expect(byTestId(html, `admin-market-pause-decision-review-${FIRST}`)?.text).toBe(
      '기존 규칙으로 판정 가능',
    );
    expect(byTestId(html, `admin-market-pause-decision-requested-by-${FIRST}`)?.text).toBe(
      '요청한이',
    );
    // A request still waiting at the close is listed with its market's status; no review result
    // reads '—', and a closed account as every byline names it.
    expect(byTestId(html, `admin-market-pause-decision-${SECOND}`)?.text).toContain(
      copy.marketStatusClosed,
    );
    expect(byTestId(html, `admin-market-pause-decision-path-${SECOND}`)?.text).toBe('재개');
    expect(byTestId(html, `admin-market-pause-decision-review-${SECOND}`)?.text).toBe('—');
    expect(byTestId(html, `admin-market-pause-decision-requested-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, 'admin-market-pause-decisions-more')).toBeUndefined();
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-pause-decisions-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-pause-decisions-empty')?.text).toBe(
      copy.adminMarketPauseDecisionsEmpty,
    );
    expect(byTestId(html, 'admin-market-pause-decisions-list')).toBeUndefined();
  });
});
