import { type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { adminMarketKey } from '@/hooks/use-admin-markets';
import { adminMarketWorkKey } from '@/hooks/use-admin-market-work';
import { type AdminMarket, type AdminMarketWorkEntry, ApiError } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { marketWorkChangeText } from '@/lib/market-work';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketWorkHistory } from './market-work-history';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const ACTION = 'a1b2c3d4-0000-4000-8000-000000000001';
const market = { id: ID, title: '첫눈이 올까?', status: 'settled' } as AdminMarket;
const operator = { id: 'admin-1', nickname: '운영자1' };

const pages = (items: AdminMarketWorkEntry[], nextCursor: string | null = null) => ({
  pages: [{ items, nextCursor }],
  pageParams: [undefined],
});

function entry(fields: Partial<AdminMarketWorkEntry>): AdminMarketWorkEntry {
  return {
    id: 'e:1',
    source: 'market_event',
    type: 'closed',
    kind: 'other',
    at: '2026-11-20T03:00:00.000Z',
    actor: null,
    reason: null,
    reasonBasis: 'system',
    details: { closedAt: '2026-11-20T03:00:00.000Z', source: 'job' },
    changes: [],
    relatedMarket: null,
    settlement: null,
    retryOutcome: null,
    ...fields,
  };
}

/** One of each: a tag edit, a pause, a link, a failed retry, the step record and a 시스템 close. */
const ENTRIES: AdminMarketWorkEntry[] = [
  entry({
    id: `a:${ACTION}1`,
    source: 'admin_action',
    type: 'market_update',
    kind: 'edit',
    actor: operator,
    reasonBasis: 'changed_items',
    details: {},
    changes: [{ field: 'tags', before: ['서울'], after: ['서울', '물가'] }],
  }),
  entry({
    id: `a:${ACTION}2`,
    source: 'admin_action',
    type: 'market_pause',
    kind: 'pause',
    actor: operator,
    reason: '원장을 확인합니다',
    reasonBasis: 'recorded',
    details: { reason: 'ledger_failure', note: '원장을 확인합니다', resultPublishedAt: null },
  }),
  entry({
    id: `a:${ACTION}3`,
    source: 'admin_action',
    type: 'market_link',
    kind: 'other',
    actor: { id: 'admin-2', nickname: null },
    reasonBasis: 'actor_time',
    details: { marketId: OTHER, relatedMarketId: ID },
    relatedMarket: { id: OTHER, title: '함박눈이 올까?' },
  }),
  entry({
    id: `a:${ACTION}4`,
    source: 'admin_action',
    type: 'market_settlement_retry',
    kind: 'settlement',
    actor: operator,
    reason: '보류가 남았는지 봅니다',
    reasonBasis: 'recorded',
    details: { reason: '보류가 남았는지 봅니다', outcome: 'failed', error: 'ledger held' },
    retryOutcome: 'failed',
  }),
  entry({
    id: 's:coin',
    source: 'settlement_step',
    type: 'settlement_step',
    kind: 'settlement',
    details: { step: 'coin' },
    settlement: {
      stepStatus: 'done',
      settlementAttempts: 3,
      settlementLastError: 'ledger recovery approval is pending',
      completedAt: '2026-11-20T04:00:00.000Z',
    },
  }),
  entry({ id: 'e:9' }),
];

/** A first read that failed with 404 (the header), nothing held. */
const notFound = (queryClient: QueryClient) => {
  queryClient.setQueryDefaults(adminMarketKey(ID), { retryOnMount: false });
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: adminMarketKey(ID) })
    .setState({
      status: 'error',
      error: new ApiError(404, { code: 'NOT_FOUND', message: 'Market not found' }),
      fetchStatus: 'idle',
    });
};

/** A first header read that failed with 500 after its retries, nothing held. */
const serverError = (queryClient: QueryClient) => {
  queryClient.setQueryDefaults(adminMarketKey(ID), { retryOnMount: false });
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: adminMarketKey(ID) })
    .setState({
      status: 'error',
      error: new ApiError(500, { code: 'INTERNAL', message: 'boom' }),
      fetchStatus: 'idle',
    });
};

/** 시장별 작업 이력 as drawn (#145 part 2, ADR-0164; 145-5, 145-6, 145-7, 145-16, 145-18). */
describe('MarketWorkHistory', () => {
  it('draws the market, the kind links with 전체 first, and the table’s five columns', () => {
    const html = renderWithQueries(<MarketWorkHistory id={ID} kind="pause" />, [
      [adminMarketKey(ID), market],
      [adminMarketWorkKey(ID, 'pause'), pages([])],
    ]);
    expect(byTestId(html, 'market-work')?.attributes['data-kind']).toBe('pause');
    expect(byTestId(html, 'market-work-title')).toEqual({
      attributes: expect.objectContaining({ href: `/admin/markets/${ID}` }) as unknown,
      text: market.title,
    });
    expect(byTestId(html, 'market-work-status')?.text).toBe(copy.marketStatusSettled);
    expect(testIdsStartingWith(html, 'market-work-kind-')).toEqual([
      'market-work-kind-all',
      'market-work-kind-edit',
      'market-work-kind-pause',
      'market-work-kind-judgement',
      'market-work-kind-settlement',
      'market-work-kind-other',
    ]);
    const kind = (k: string) => byTestId(html, `market-work-kind-${k}`);
    expect(kind('all')).toEqual({
      attributes: expect.objectContaining({ href: `/admin/markets/${ID}/work-history` }) as unknown,
      text: '전체',
    });
    expect(kind('pause')?.attributes['aria-current']).toBe('page');
    expect(kind('all')?.attributes['aria-current']).toBeUndefined();
    expect(kind('settlement')?.attributes.href).toBe(
      `/admin/markets/${ID}/work-history?kind=settlement`,
    );
    expect(byTestId(html, 'market-work-history')?.text).toContain(copy.adminMarketWorkHistory);
    expect(byTestId(html, 'market-work-history-empty')?.text).toBe(copy.adminMarketWorkEmpty);
  });

  it('draws each entry’s time, kind, name, actor and reason by its basis (145-16)', () => {
    const html = renderWithQueries(<MarketWorkHistory id={ID} kind={undefined} />, [
      [adminMarketKey(ID), market],
      [adminMarketWorkKey(ID, undefined), pages(ENTRIES, 'next')],
    ]);
    const header = byTestId(html, 'market-work-history-list')?.text ?? '';
    for (const column of ['시각', '분류', '작업', '담당자', '사유'])
      expect(header).toContain(column);
    const row = (id: string) => byTestId(html, `market-work-entry-${id}`);
    const part = (id: string, name: string) => byTestId(html, `market-work-entry-${id}-${name}`);

    // 수정: the changes as 항목: 이전 → 새 under the line saying no reason is taken.
    const edit = `a:${ACTION}1`;
    expect(row(edit)?.attributes).toMatchObject({
      'data-kind': 'edit',
      'data-source': 'admin_action',
      'data-type': 'market_update',
    });
    expect(part(edit, 'at')?.text).toBe(formatKst('2026-11-20T03:00:00.000Z'));
    expect(part(edit, 'kind')?.text).toBe('수정');
    expect(part(edit, 'label')?.text).toBe('시장 수정');
    expect(part(edit, 'actor')?.text).toBe('운영자1');
    expect(part(edit, 'basis')?.text).toBe('사유를 받지 않는 작업 — 바뀐 항목을 남깁니다');
    expect(part(edit, 'changes')?.text).toBe('태그: 서울 → 서울, 물가');

    // 중단: the stored note as the reason, the code under 자세히.
    const pause = `a:${ACTION}2`;
    expect(part(pause, 'reason')?.text).toBe('원장을 확인합니다');
    expect(part(pause, 'details')?.text).toContain(copy.adminMarketWorkDetails);
    expect(part(pause, 'details')?.text).toContain(copy.pauseReasonLedgerFailure);

    // 관련 시장: the other end as a link, 담당자와 시각만, a closed account's nickname.
    const link = `a:${ACTION}3`;
    expect(part(link, 'related')).toEqual({
      attributes: expect.objectContaining({ href: `/admin/markets/${OTHER}` }) as unknown,
      text: '함박눈이 올까?',
    });
    expect(part(link, 'actor')?.text).toBe(copy.postAuthorFormer);
    expect(part(link, 'reason')?.text).toBe('사유를 받지 않는 작업 — 담당자와 시각만 남깁니다');

    // 정산 다시 시도: the result and the error as stored (145-7, 145-18).
    const retry = `a:${ACTION}4`;
    expect(part(retry, 'label')?.text).toBe(copy.adminSettlementRetry);
    expect(part(retry, 'outcome')?.text).toBe('결과: 실패');
    expect(part(retry, 'error-text')?.text).toBe('ledger held');
    expect(part(retry, 'reason')?.text).toBe('보류가 남았는지 봅니다');
    expect(part(retry, 'details')?.text).not.toContain('ledger held');

    // 정산 실패 기록: 시스템, its attempts and last error (145-6).
    expect(row('s:coin')?.attributes['data-source']).toBe('settlement_step');
    expect(part('s:coin', 'label')?.text).toBe('정산 실패 기록');
    expect(part('s:coin', 'actor')?.text).toBe('시스템');
    expect(part('s:coin', 'kind')?.text).toBe('지급');
    expect(part('s:coin', 'attempts')?.text).toBe('시도 3회');
    expect(part('s:coin', 'error-text')?.text).toBe('ledger recovery approval is pending');
    expect(part('s:coin', 'reason')?.text).toContain(copy.adminOperationsLastError);

    // 시스템's close: its rule as the reason.
    expect(part('e:9', 'actor')?.text).toBe('시스템');
    expect(part('e:9', 'reason')?.text).toBe('거래 마감 시각');
    expect(part('e:9', 'label')?.text).toBe(copy.eventClosed);

    // Oldest first, as the API answers; 더 보기 while a page follows.
    expect(
      testIdsStartingWith(html, 'market-work-entry-').filter((id) =>
        ENTRIES.some((each) => id === `market-work-entry-${each.id}`),
      ),
    ).toEqual(ENTRIES.map((each) => `market-work-entry-${each.id}`));
    expect(byTestId(html, 'market-work-history-more')?.text).toBe(copy.loadMore);
  });

  it('starts each stored reason’s and changed item’s disclosure with its marker beside the text', () => {
    // A summary whose only child is the clamped block put the native marker on a line of its own:
    // the summary opens with a drawn marker (aria-hidden, no text) and the clamped text right after.
    const html = renderWithQueries(<MarketWorkHistory id={ID} kind={undefined} />, [
      [adminMarketKey(ID), market],
      [adminMarketWorkKey(ID, undefined), pages(ENTRIES)],
    ]);
    const marker =
      '<span\\b(?=[^>]*\\saria-hidden="true")(?=[^>]*\\sdata-part="marker")[^>]*></span>';
    const summaryOf = (text: string) =>
      new RegExp(`<summary\\b[^>]*>${marker}<span\\b[^>]*>${text}</span></summary>`);
    for (const reason of ['원장을 확인합니다', '보류가 남았는지 봅니다'])
      expect(html).toMatch(summaryOf(reason));
    expect(html).toMatch(summaryOf('태그: 서울 → 서울, 물가'));
  });

  it('shows up to three changes, and folds the rest under one disclosure saying how many', () => {
    const change = (field: string, after: string) => ({ field, before: null, after });
    const three = [
      change('title', '첫눈이 올까?'),
      change('description', '서울에 첫눈이 오는지'),
      change('yesCondition', '기상청이 첫눈을 알림'),
    ] as AdminMarketWorkEntry['changes'];
    const five = [
      ...three,
      change('noCondition', '기한까지 알림이 없음'),
      change('slug', 'first-snow'),
    ] as AdminMarketWorkEntry['changes'];
    const update = `a:${ACTION}5`;
    const create = `a:${ACTION}6`;
    const html = renderWithQueries(<MarketWorkHistory id={ID} kind={undefined} />, [
      [adminMarketKey(ID), market],
      [
        adminMarketWorkKey(ID, undefined),
        pages([
          entry({
            id: update,
            source: 'admin_action',
            type: 'market_update',
            kind: 'edit',
            actor: operator,
            reasonBasis: 'changed_items',
            details: {},
            changes: three,
          }),
          entry({
            id: create,
            source: 'admin_action',
            type: 'market_create',
            kind: 'edit',
            actor: operator,
            reasonBasis: 'changed_items',
            details: {},
            changes: five,
          }),
        ]),
      ],
    ]);
    const part = (id: string, name: string) => byTestId(html, `market-work-entry-${id}-${name}`);
    const texts = three.map(marketWorkChangeText);
    expect(texts[0]).toBe('질문: — → 첫눈이 올까?');

    // Three: every one in the list, no fold.
    expect(part(update, 'changes')?.text).toBe(texts.join(''));
    expect(part(update, 'changes-more')).toBeUndefined();

    // Five: the first three, then the fold — '바뀐 항목 2개 더 보기' and the other two inside it, closed.
    const more = part(create, 'changes-more');
    const folded = five.slice(3).map(marketWorkChangeText);
    expect(copy.adminMarketWorkChangesMore).toBe('바뀐 항목 {n}개 더 보기');
    expect(more?.text).toBe(`바뀐 항목 2개 더 보기${folded.join('')}`);
    expect(more?.attributes).not.toHaveProperty('open');
    expect(part(create, 'changes')?.text).toBe(`${texts.join('')}${more?.text ?? ''}`);
    for (const text of texts) expect(more?.text).not.toContain(text);
    // Each change keeps its field, in order, open or folded.
    const fields = [...html.matchAll(/\sdata-field="([^"]*)"/g)].map(([, field]) => field);
    expect(fields).toEqual([...three, ...five].map((each) => each.field));
    // The fold's summary is a row like the other disclosures: the drawn marker, then its text.
    const marker =
      '<span\\b(?=[^>]*\\saria-hidden="true")(?=[^>]*\\sdata-part="marker")[^>]*></span>';
    expect(html).toMatch(
      new RegExp(`<summary\\b[^>]*>${marker}<span\\b[^>]*>바뀐 항목 2개 더 보기</span></summary>`),
    );
  });

  it('says 찾을 수 없습니다 for a segment that names no market, and for one the API does not know', () => {
    const malformed = renderWithQueries(<MarketWorkHistory id="abc" kind={undefined} />);
    expect(byTestId(malformed, 'market-work-not-found')?.text).toBe(copy.adminMarketNotFound);
    expect(byTestId(malformed, 'market-work')).toBeUndefined();
    const unknown = renderWithQueries(
      <MarketWorkHistory id={ID} kind={undefined} />,
      [[adminMarketWorkKey(ID, undefined), pages([])]],
      notFound,
    );
    expect(byTestId(unknown, 'market-work-not-found')?.text).toBe(copy.adminMarketNotFound);
  });

  it('says the header read failed, with 다시 시도, instead of a skeleton that never ends', () => {
    const html = renderWithQueries(
      <MarketWorkHistory id={ID} kind={undefined} />,
      [[adminMarketWorkKey(ID, undefined), pages(ENTRIES)]],
      serverError,
    );
    expect(byTestId(html, 'market-work-not-found')).toBeUndefined();
    expect(byTestId(html, 'market-work-header-error')?.text).toBe(copy.errUnknown);
    expect(html).toContain(copy.retry);
    expect(byTestId(html, 'market-work-title')).toBeUndefined();
    // The history itself still draws.
    expect(byTestId(html, `market-work-entry-a:${ACTION}1`)).toBeDefined();
  });
});
