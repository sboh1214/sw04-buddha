import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_MARKET_JUDGEMENT_INCIDENTS_KEY,
  type AdminMarketJudgementIncidentPage,
} from '@/hooks/use-admin-markets';
import { type AdminMarketJudgementIncidentQueueItem } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminMarketJudgementIncidents } from './admin-market-judgement-incidents';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (
  requestId: string,
  fields: Partial<AdminMarketJudgementIncidentQueueItem> = {},
): AdminMarketJudgementIncidentQueueItem => ({
  kind: 'incident',
  requestId,
  marketId: MARKET,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'settled',
  originalResult: 'YES',
  correctedResult: 'NO',
  requestedBy: { id: 'registrant', nickname: '등록한이' },
  requestedAt: '2026-11-30T02:00:00.000Z',
  accountCount: null,
  totalCoin: null,
  ...fields,
});

/** The queue as the server answered it, page by page. */
const drawn = (pages: AdminMarketJudgementIncidentPage[]) =>
  renderWithQueries(<AdminMarketJudgementIncidents />, [
    [
      ADMIN_MARKET_JUDGEMENT_INCIDENTS_KEY,
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 판정 오류 사건 검토 대기 as drawn (#144, ADR-0165): every waiting incident in the order the API
 * answers — the oldest first (admin-market-judgement-incidents.controller.test.ts) — one row each,
 * the question to its market's admin detail, 더 보기 while a page follows.
 */
describe('AdminMarketJudgementIncidents', () => {
  it('draws one row per incident in the order answered: status, both results, by nickname, KST', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            status: 'settling',
            originalResult: 'VOID',
            correctedResult: 'YES',
            requestedBy: { id: 'gone', nickname: null },
          }),
        ],
        nextCursor: null,
      },
    ]);
    const section = byTestId(html, 'admin-market-judgement-incidents');
    expect(section?.text).toContain(copy.adminMarketJudgementIncidents);
    expect(section?.attributes.id).toBe('market-judgement-incidents');
    expect(
      testIdsStartingWith(html, 'admin-market-judgement-incident-').filter((id) =>
        /^admin-market-judgement-incident-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([
      `admin-market-judgement-incident-${FIRST}`,
      `admin-market-judgement-incident-${SECOND}`,
    ]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketJudgementIncidentsColTitle,
      copy.adminMarketJudgementCompensationQueueColKind,
      copy.adminMarketJudgementIncidentsColStatus,
      copy.adminMarketJudgementIncidentsColOriginal,
      copy.adminMarketJudgementIncidentsColCorrected,
      copy.adminMarketJudgementIncidentsColRequestedBy,
      copy.adminMarketJudgementIncidentsColRequestedAt,
    ]);
    const first = byTestId(html, `admin-market-judgement-incident-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(MARKET);
    expect(first?.text).toContain('첫눈이 올까?');
    expect(first?.text).toContain(formatKst('2026-11-30T02:00:00.000Z'));
    expect(byTestId(html, `admin-market-judgement-incident-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-market-judgement-incident-status-${FIRST}`)?.text).toBe(
      copy.marketStatusSettled,
    );
    expect(byTestId(html, `admin-market-judgement-incident-original-${FIRST}`)?.text).toBe('YES');
    expect(byTestId(html, `admin-market-judgement-incident-result-${FIRST}`)?.text).toBe('NO');
    expect(byTestId(html, `admin-market-judgement-incident-requested-by-${FIRST}`)?.text).toBe(
      '등록한이',
    );
    // A 지급 중 market's incident waits for 지급 완료 to be confirmed (144-13): its status says so.
    expect(byTestId(html, `admin-market-judgement-incident-status-${SECOND}`)?.text).toBe(
      copy.marketStatusSettling,
    );
    expect(byTestId(html, `admin-market-judgement-incident-original-${SECOND}`)?.text).toBe('무효');
    expect(byTestId(html, `admin-market-judgement-incident-requested-by-${SECOND}`)?.text).toBe(
      copy.postAuthorFormer,
    );
    expect(byTestId(html, 'admin-market-judgement-incidents-more')).toBeUndefined();
    // Nothing of the description, the evidence or a reason: the detail's to show.
    expect(section?.text).not.toContain('https://');
  });

  it('holds the 보상 승인 requests in the same table, with their count and total (#144, T13)', () => {
    const html = drawn([
      {
        items: [
          row(FIRST),
          row(SECOND, {
            kind: 'compensation',
            requestedBy: { id: 'asker', nickname: '요청한이' },
            accountCount: 3,
            totalCoin: '1250',
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(
      byTestId(html, `admin-market-judgement-incident-${FIRST}`)?.attributes['data-kind'],
    ).toBe('incident');
    expect(byTestId(html, `admin-market-judgement-incident-kind-${FIRST}`)?.text).toBe('사건 검토');
    expect(byTestId(html, `admin-market-judgement-incident-summary-${FIRST}`)).toBeUndefined();
    expect(
      byTestId(html, `admin-market-judgement-incident-${SECOND}`)?.attributes['data-kind'],
    ).toBe('compensation');
    expect(byTestId(html, `admin-market-judgement-incident-kind-${SECOND}`)?.text).toContain(
      '보상 승인',
    );
    expect(byTestId(html, `admin-market-judgement-incident-summary-${SECOND}`)?.text).toBe(
      '대상 계정 3개 · 총 1,250 Coin',
    );
    expect(byTestId(html, `admin-market-judgement-incident-requested-by-${SECOND}`)?.text).toBe(
      '요청한이',
    );
    expect(byTestId(html, 'admin-market-judgement-incidents')?.text).toContain(
      copy.adminMarketJudgementCompensationQueueIntro,
    );
  });

  it('offers 더 보기 while another page follows', () => {
    const html = drawn([{ items: [row(FIRST)], nextCursor: 'c1' }]);
    expect(byTestId(html, 'admin-market-judgement-incidents-more')?.text).toBe(copy.loadMore);
  });

  it('says so when nothing waits', () => {
    const html = drawn([{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-market-judgement-incidents-empty')?.text).toBe(
      copy.adminMarketJudgementIncidentsEmpty,
    );
    expect(byTestId(html, 'admin-market-judgement-incidents-list')).toBeUndefined();
  });
});
