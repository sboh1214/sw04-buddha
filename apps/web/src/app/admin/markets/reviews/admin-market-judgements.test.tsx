import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_MARKET_JUDGEMENTS_KEY,
  type AdminMarketJudgementPage,
} from '@/hooks/use-admin-markets';
import { type AdminMarketJudgementQueueItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketJudgements } from './admin-market-judgements';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (
  requestId: string,
  fields: Partial<AdminMarketJudgementQueueItem> = {},
): AdminMarketJudgementQueueItem => ({
  requestId,
  marketId: MARKET,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'closed',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledJudgementAt: '2000-01-01T00:00:00.000Z',
  result: 'NO',
  requestedBy: { id: 'registrant', nickname: '등록한이' },
  requestedAt: '2026-11-30T02:00:00.000Z',
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketJudgementPage[]) =>
  renderWithQueries(<AdminMarketJudgements />, [
    [
      ADMIN_MARKET_JUDGEMENTS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 판정 승인 대기 as drawn (#152, ADR-0103): every waiting judgement registration in the order the API
 * answers — the oldest first (admin-market-judgements.controller.test.ts) — one row each, the
 * question to its market's admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketJudgements', () => {
  it('draws one row per registration in the order answered: result, by nickname, in KST', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            status: 'cancelled',
            result: 'VOID',
            scheduledJudgementAt: null,
            requestedBy: { id: 'gone', nickname: null },
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, 'admin-market-judgements')?.text).toContain(copy.adminMarketJudgements);
    expect(
      testIdsStartingWith(html, 'admin-market-judgement-').filter((id) =>
        /^admin-market-judgement-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-market-judgement-${FIRST}`, `admin-market-judgement-${SECOND}`]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketJudgementsColTitle,
      copy.adminMarketJudgementsColStatus,
      copy.adminMarketJudgementsColResult,
      copy.adminMarketJudgementsColRequestedBy,
      copy.adminMarketJudgementsColRequestedAt,
      copy.adminMarketJudgementsColScheduledJudgementAt,
      copy.adminMarketJudgementsColCloseAt,
    ]);
    const first = byTestId(html, `admin-market-judgement-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(MARKET);
    expect(first?.text).toContain('첫눈이 올까?');
    expect(first?.text).toContain(copy.marketStatusClosed);
    expect(first?.text).toContain(formatKst('2026-11-30T02:00:00.000Z'));
    expect(first?.text).toContain(formatKst('2026-11-29T15:00:00.000Z'));
    expect(byTestId(html, `admin-market-judgement-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-market-judgement-result-${FIRST}`)?.text).toBe('NO');
    expect(byTestId(html, `admin-market-judgement-requested-by-${FIRST}`)?.text).toBe('등록한이');
    // A registration still waiting once the market moved on is listed with its status; a VOID
    // reads 무효, no scheduled judgement '—', and a closed account as every byline names it.
    expect(byTestId(html, `admin-market-judgement-${SECOND}`)?.text).toContain(
      copy.marketStatusCancelled,
    );
    expect(byTestId(html, `admin-market-judgement-result-${SECOND}`)?.text).toBe('무효');
    expect(byTestId(html, `admin-market-judgement-scheduled-${SECOND}`)?.text).toBe('—');
    expect(byTestId(html, `admin-market-judgement-requested-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, 'admin-market-judgements-more')).toBeUndefined();
  });

  it('marks a registration waiting before its scheduled judgement (decision 3 등록 시점)', () => {
    const html = drawn([
      {
        items: [row(FIRST, { scheduledJudgementAt: '2999-01-01T00:00:00.000Z' }), row(SECOND)],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, `admin-market-judgement-early-${FIRST}`)?.text).toBe(
      copy.adminMarketJudgementsEarly,
    );
    expect(byTestId(html, `admin-market-judgement-early-${SECOND}`)).toBeUndefined();
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-judgements-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-judgements-empty')?.text).toBe(
      copy.adminMarketJudgementsEmpty,
    );
    expect(byTestId(html, 'admin-market-judgements-list')).toBeUndefined();
  });
});
