import { type QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_OPERATIONS_FAILURES_KEY,
  adminOperationsClosingKey,
  adminOperationsJudgementsKey,
} from '@/hooks/use-admin-operations';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  type AdminAwaitingJudgementMarket,
  type AdminClosingMarket,
  type AdminOperationsFailure,
  type Me,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminOperations } from './admin-operations';
import { OperationsClosing } from './operations-closing';
import { OperationsFailures } from './operations-failures';
import { OperationsJudgements } from './operations-judgements';
import { LastErrorText } from './settlement-retry-dialog';

const FIRST = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SECOND = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const THIRD = '3f2504e0-4f89-11d3-9a0c-0305e82c3303';
const REQUEST = 'a1b2c3d4-0000-4000-8000-000000000001';
const me = { id: 'operator' } as Me;

const pages = <T,>(items: T[], nextCursor: string | null = null) => ({
  pages: [{ items, nextCursor }],
  pageParams: [undefined],
});

/** A list's first read that failed, nothing held (no retry on mount, so it stays failed). */
const failedFirstRead = (queryKey: QueryKey) => (queryClient: QueryClient) => {
  queryClient.setQueryDefaults(queryKey, { retryOnMount: false });
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey })
    .setState({ status: 'error', error: new Error('503'), fetchStatus: 'idle' });
};

/** A read again that failed over the rows held. */
const failedRefresh = (queryKey: QueryKey) => (queryClient: QueryClient) => {
  queryClient
    .getQueryCache()
    .find({ queryKey, exact: true })
    ?.setState({ status: 'error', error: new Error('503') });
};

const closing = (id: string, fields: Partial<AdminClosingMarket> = {}): AdminClosingMarket => ({
  id,
  slug: `market-${id.slice(-1)}`,
  title: '첫눈이 올까?',
  status: 'open',
  closeAt: '2026-11-24T03:00:00.000Z',
  scheduledJudgementAt: '2026-11-25T03:00:00.000Z',
  overdue: false,
  ...fields,
});

const judgement = (
  id: string,
  fields: Partial<AdminAwaitingJudgementMarket> = {},
): AdminAwaitingJudgementMarket => ({
  id,
  slug: `market-${id.slice(-1)}`,
  title: '기준금리 인하?',
  status: 'closed',
  stage: 'unregistered',
  closeAt: '2026-11-20T03:00:00.000Z',
  scheduledJudgementAt: '2026-11-21T03:00:00.000Z',
  disputeDeadline: null,
  judgementRequestId: null,
  holdingDisputes: 0,
  correctionPending: false,
  delay: null,
  reviewOverdue: false,
  longDelayDeadline: '2026-12-05T03:00:00.000Z',
  longDelayReached: false,
  delayed: true,
  ...fields,
});

/** 운영 대기열 as drawn (#145, ADR-0163): the screen, its three lists and their rows. */
describe('AdminOperations', () => {
  it('draws the intro, the links to 검수 대기 and 이의 접수, the tabs and 마감 예정’s windows', () => {
    const html = renderWithQueries(
      <AdminOperations view={{ list: 'closing', within: '3d', filter: 'all' }} />,
      [[adminOperationsClosingKey('3d'), pages([])]],
    );
    const screen = byTestId(html, 'admin-operations');
    expect(screen?.attributes['data-list']).toBe('closing');
    expect(screen?.text).toContain(copy.adminOperations);
    expect(screen?.text).toContain(copy.adminOperationsIntro);
    // Links only, to the two lists #145 does not build: no count, no request.
    expect(byTestId(html, 'admin-operations-other-lists')?.text).toContain(
      copy.adminOperationsOtherLists,
    );
    expect(byTestId(html, 'admin-operations-to-reviews')).toEqual({
      attributes: expect.objectContaining({ href: '/admin/markets/reviews' }) as unknown,
      text: copy.adminMarketReviews,
    });
    expect(byTestId(html, 'admin-operations-to-disputes')).toEqual({
      attributes: expect.objectContaining({ href: '/admin/disputes' }) as unknown,
      text: copy.adminDisputes,
    });
    expect(testIdsStartingWith(html, 'admin-operations-list-')).toEqual([
      'admin-operations-list-closing',
      'admin-operations-list-judgements',
      'admin-operations-list-failures',
    ]);
    const tab = (list: string) => byTestId(html, `admin-operations-list-${list}`)?.attributes;
    expect(tab('closing')?.['aria-current']).toBe('page');
    expect(tab('closing')?.href).toBe('/admin/operations');
    expect(tab('judgements')?.['aria-current']).toBeUndefined();
    expect(tab('judgements')?.href).toBe('/admin/operations?list=judgements');
    expect(tab('failures')?.href).toBe('/admin/operations?list=failures');
    expect(byTestId(html, 'admin-operations-within')?.text).toContain(copy.adminOperationsWithin);
    expect(
      ['24h', '3d', '7d'].map((within) => {
        const link = byTestId(html, `admin-operations-within-${within}`);
        return [link?.text, link?.attributes.href, link?.attributes['aria-current']];
      }),
    ).toEqual([
      ['24시간', '/admin/operations', undefined],
      ['3일', '/admin/operations?within=3d', 'page'],
      ['7일', '/admin/operations?within=7d', undefined],
    ]);
    expect(byTestId(html, 'admin-operations-filter')).toBeUndefined();
    expect(byTestId(html, 'admin-operations-closing-empty')?.text).toBe(
      copy.adminOperationsClosingEmpty,
    );
  });

  it('draws 판정 대기·지연 with its filters, and 정산 실패 with none', () => {
    const judgements = renderWithQueries(
      <AdminOperations view={{ list: 'judgements', within: '24h', filter: 'delayed' }} />,
      [[adminOperationsJudgementsKey('delayed'), pages([])]],
    );
    expect(byTestId(judgements, 'admin-operations')?.attributes['data-list']).toBe('judgements');
    expect(
      byTestId(judgements, 'admin-operations-list-judgements')?.attributes['aria-current'],
    ).toBe('page');
    expect(byTestId(judgements, 'admin-operations-within')).toBeUndefined();
    expect(
      ['all', 'delayed'].map((filter) => {
        const link = byTestId(judgements, `admin-operations-filter-${filter}`);
        return [link?.text, link?.attributes.href, link?.attributes['aria-current']];
      }),
    ).toEqual([
      ['전체', '/admin/operations?list=judgements', undefined],
      ['지연만', '/admin/operations?list=judgements&filter=delayed', 'page'],
    ]);
    expect(byTestId(judgements, 'admin-operations-judgements-empty')?.text).toBe(
      copy.adminOperationsJudgementsEmpty,
    );
    const failures = renderWithQueries(
      <AdminOperations view={{ list: 'failures', within: '24h', filter: 'all' }} />,
      [
        [ME_QUERY_KEY, me],
        [ADMIN_OPERATIONS_FAILURES_KEY, pages([])],
      ],
    );
    expect(byTestId(failures, 'admin-operations-filter')).toBeUndefined();
    expect(byTestId(failures, 'admin-operations-within')).toBeUndefined();
    expect(byTestId(failures, 'admin-operations-failures-empty')?.text).toBe(
      copy.adminOperationsFailuresEmpty,
    );
    // The fixed line stands on every tab.
    expect(byTestId(failures, 'admin-operations-to-reviews')).toBeDefined();
    expect(byTestId(judgements, 'admin-operations-to-disputes')).toBeDefined();
  });
});

describe('마감 예정 (145-1)', () => {
  it('draws one row per market in the order answered, the overdue one marked (145-18)', () => {
    const html = renderWithQueries(<OperationsClosing within="24h" />, [
      [
        adminOperationsClosingKey('24h'),
        pages(
          [
            closing(FIRST, { overdue: true, closeAt: '2026-11-23T02:00:00.000Z' }),
            closing(SECOND, { status: 'paused', scheduledJudgementAt: null }),
          ],
          'c1',
        ),
      ],
    ]);
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketJudgementsColTitle,
      copy.adminMarketJudgementsColStatus,
      copy.adminMarketJudgementsColCloseAt,
      copy.adminMarketJudgementsColScheduledJudgementAt,
    ]);
    expect(
      testIdsStartingWith(html, 'admin-operations-closing-').filter((id) =>
        /^admin-operations-closing-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-operations-closing-${FIRST}`, `admin-operations-closing-${SECOND}`]);
    const first = byTestId(html, `admin-operations-closing-${FIRST}`);
    expect(first?.attributes['data-market']).toBe(FIRST);
    expect(first?.attributes['data-overdue']).toBe('true');
    expect(first?.text).toContain(copy.marketStatusOpen);
    expect(byTestId(html, `admin-operations-closing-overdue-${FIRST}`)?.text).toBe(
      '마감 시각 지남',
    );
    expect(byTestId(html, `admin-operations-closing-close-at-${FIRST}`)?.text).toBe(
      formatKst('2026-11-23T02:00:00.000Z'),
    );
    expect(byTestId(html, `admin-operations-closing-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${FIRST}`,
    );
    // PAUSED is listed too (145-3: no list of its own), with no scheduled judgement as '—'.
    const second = byTestId(html, `admin-operations-closing-${SECOND}`);
    expect(second?.attributes['data-overdue']).toBe('false');
    expect(second?.text).toContain(copy.marketStatusPaused);
    expect(second?.text).toContain('—');
    expect(byTestId(html, `admin-operations-closing-overdue-${SECOND}`)).toBeUndefined();
    expect(byTestId(html, 'admin-operations-closing-more')?.text).toBe(copy.loadMore);
  });

  it('says a first read that failed, and keeps the rows under a failed refresh', () => {
    const key = adminOperationsClosingKey('7d');
    const failed = renderWithQueries(<OperationsClosing within="7d" />, [], failedFirstRead(key));
    expect(byTestId(failed, 'admin-operations-closing-error')?.text).toContain(copy.errUnknown);
    expect(byTestId(failed, 'admin-operations-closing-list')).toBeUndefined();
    const stale = renderWithQueries(
      <OperationsClosing within="7d" />,
      [[key, pages([closing(FIRST)])]],
      failedRefresh(key),
    );
    expect(byTestId(stale, 'admin-operations-closing-stale')?.text).toContain(
      copy.adminMarketRefreshFailed,
    );
    expect(byTestId(stale, `admin-operations-closing-${FIRST}`)).toBeDefined();
    expect(byTestId(stale, 'admin-operations-closing-more')).toBeUndefined();
  });
});

describe('판정 대기·지연 (145-2, 145-11, 145-17)', () => {
  const rows = [
    // CLOSED, nothing registered, past its long delay, no record.
    judgement(FIRST, { longDelayReached: true }),
    // CLOSED, its registration waiting, the current record past its next review.
    judgement(SECOND, {
      stage: 'awaiting_approval',
      judgementRequestId: REQUEST,
      delay: {
        reason: '1차 출처의 발표가 늦어지고 있습니다.',
        nextReviewAt: '2026-11-22T03:00:00.000Z',
        recordedAt: '2026-11-21T04:00:00.000Z',
      },
      reviewOverdue: true,
    }),
    // PROVISIONAL, a dispute and a correction holding it, no record of this version.
    judgement(THIRD, {
      status: 'provisional',
      stage: 'dispute_or_correction',
      disputeDeadline: '2026-11-22T03:00:00.000Z',
      holdingDisputes: 2,
      correctionPending: true,
      judgementRequestId: REQUEST,
      longDelayReached: false,
    }),
  ];
  const html = renderWithQueries(<OperationsJudgements filter="all" />, [
    [adminOperationsJudgementsKey('all'), pages(rows)],
  ]);
  const prefix = 'admin-operations-judgement';

  it('draws each row’s stage, its delay mark and its links', () => {
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketJudgementsColTitle,
      copy.adminMarketJudgementsColStatus,
      copy.adminMarketJudgementsColScheduledJudgementAt,
      copy.adminOperationsDelayReason,
      copy.adminMarketJudgementLongDelayDeadline,
    ]);
    expect(
      [FIRST, SECOND, THIRD].map((id) => [
        byTestId(html, `${prefix}-${id}`)?.attributes['data-stage'],
        byTestId(html, `${prefix}-${id}`)?.attributes['data-delayed'],
        byTestId(html, `${prefix}-stage-${id}`)?.text,
        byTestId(html, `${prefix}-delayed-${id}`)?.text,
      ]),
    ).toEqual([
      ['unregistered', 'true', '판정 등록 전', '판정 지연'],
      ['awaiting_approval', 'true', '판정 승인 대기', '판정 지연'],
      ['dispute_or_correction', 'true', '이의·정정 대기', '판정 지연'],
    ]);
    expect(byTestId(html, `${prefix}-link-${FIRST}`)?.attributes.href).toBe(
      `/admin/markets/${FIRST}`,
    );
    // Approval stays where it is (145-2): a waiting registration and a correction link to it, a
    // holding dispute to 이의 접수.
    expect(byTestId(html, `${prefix}-to-approvals-${FIRST}`)).toBeUndefined();
    expect(byTestId(html, `${prefix}-to-approvals-${SECOND}`)).toEqual({
      attributes: expect.objectContaining({
        href: '/admin/markets/reviews#market-judgements',
      }) as unknown,
      text: copy.adminOperationsToApprovals,
    });
    expect(byTestId(html, `${prefix}-to-approvals-${THIRD}`)?.text).toBe('판정 승인 대기로');
    expect(byTestId(html, `${prefix}-to-disputes-${THIRD}`)).toEqual({
      attributes: expect.objectContaining({ href: '/admin/disputes' }) as unknown,
      text: copy.adminOperationsToDisputes,
    });
    expect(byTestId(html, `${prefix}-to-disputes-${SECOND}`)).toBeUndefined();
    expect(byTestId(html, `${prefix}-holds-${THIRD}`)?.text).toBe(
      `${copy.marketDisputeDeadline} ${formatKst('2026-11-22T03:00:00.000Z')} · 결과 확정을 기다리게 하는 이의 2건`,
    );
  });

  it('draws the current record with its next review and 갱신 대기, or says there is none', () => {
    expect(byTestId(html, `${prefix}-no-delay-${FIRST}`)?.text).toBe('지연 기록 없음');
    expect(byTestId(html, `${prefix}-no-delay-${THIRD}`)?.text).toBe(
      '이 판정 버전의 지연 기록 없음',
    );
    expect(byTestId(html, `${prefix}-delay-reason-${SECOND}`)?.text).toBe(
      '1차 출처의 발표가 늦어지고 있습니다.',
    );
    expect(byTestId(html, `${prefix}-next-review-${SECOND}`)?.text).toBe(
      `다음 검토 ${formatKst('2026-11-22T03:00:00.000Z')}`,
    );
    expect(byTestId(html, `${prefix}-review-overdue-${SECOND}`)?.text).toBe('갱신 대기');
    expect(byTestId(html, `${prefix}-review-overdue-${FIRST}`)).toBeUndefined();
  });

  it('shows the 장기 지연 기한 and its reach on 거래 마감 rows only (145-17)', () => {
    expect(byTestId(html, `${prefix}-long-delay-${FIRST}`)?.text).toBe(
      `${formatKst('2026-12-05T03:00:00.000Z')}장기 지연 기한 도달`,
    );
    expect(byTestId(html, `${prefix}-long-delay-reached-${SECOND}`)).toBeUndefined();
    expect(byTestId(html, `${prefix}-long-delay-${THIRD}`)?.text).toBe('—');
    // No scheduled judgement (a pre-#22 market): '—', never delayed by the server.
    const undated = renderWithQueries(<OperationsJudgements filter="all" />, [
      [
        adminOperationsJudgementsKey('all'),
        pages([
          judgement(FIRST, { scheduledJudgementAt: null, longDelayDeadline: null, delayed: false }),
        ]),
      ],
    ]);
    expect(byTestId(undated, `${prefix}-scheduled-${FIRST}`)?.text).toBe('—');
    expect(byTestId(undated, `${prefix}-long-delay-${FIRST}`)?.text).toBe('—');
    expect(byTestId(undated, `${prefix}-delayed-${FIRST}`)).toBeUndefined();
  });
});

describe('정산 실패 (145-4, 145-6, 145-8, 145-14, 145-15)', () => {
  const failures: AdminOperationsFailure[] = [
    {
      id: FIRST,
      slug: 'first',
      title: '첫눈이 올까?',
      status: 'settling',
      since: '2026-11-22T03:00:00.000Z',
      kind: 'settlement_failed',
      retryable: true,
      settlement: {
        stepStatus: 'failed',
        settlementAttempts: 3,
        settlementLastError: '55000: ledger recovery approval is pending\nat settleMarketPositions',
        lastAttemptAt: '2026-11-22T03:02:00.000Z',
        ledgerHeld: true,
      },
    },
    {
      id: SECOND,
      slug: 'second',
      title: '기준금리 인하?',
      status: 'resolved',
      since: '2026-11-22T04:00:00.000Z',
      kind: 'stuck',
      retryable: false,
      stage: 'start',
    },
    {
      id: THIRD,
      slug: 'third',
      title: '올해 첫 한파?',
      status: 'settling',
      since: '2026-11-22T05:00:00.000Z',
      kind: 'stuck',
      retryable: true,
      stage: 'complete',
    },
    {
      id: FIRST,
      slug: 'first',
      title: '첫눈이 올까?',
      status: 'settled',
      since: '2026-11-22T06:00:00.000Z',
      kind: 'recall_failed',
      retryable: false,
      recall: {
        recallAttempts: 4,
        recallReason: 'execution_failed',
        lastFailureAt: '2026-11-22T06:00:00.000Z',
      },
    },
  ];
  const draw = (operator: Me | undefined) =>
    renderWithQueries(<OperationsFailures />, [
      ...(operator === undefined ? [] : [[ME_QUERY_KEY, operator] as const]),
      [ADMIN_OPERATIONS_FAILURES_KEY, pages(failures)],
    ]);
  const html = draw(me);
  const prefix = 'admin-operations-failure';

  it('draws the three kinds in the order answered', () => {
    expect(byTagName(html, 'th').map((cell) => cell.text)).toEqual([
      copy.adminMarketJudgementsColTitle,
      copy.adminMarketJudgementsColStatus,
      copy.adminOperationsColDetail,
    ]);
    expect(
      testIdsStartingWith(html, `${prefix}-`).filter((id) =>
        /^admin-operations-failure-(settlement_failed|stuck|recall_failed)-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([
      `${prefix}-settlement_failed-${FIRST}`,
      `${prefix}-stuck-${SECOND}`,
      `${prefix}-stuck-${THIRD}`,
      `${prefix}-recall_failed-${FIRST}`,
    ]);
    expect(
      [
        ['settlement_failed', FIRST],
        ['stuck', SECOND],
        ['stuck', THIRD],
        ['recall_failed', FIRST],
      ].map(([kind, id]) => byTestId(html, `${prefix}-kind-${kind ?? ''}-${id ?? ''}`)?.text),
    ).toEqual(['정산 실패', '처리 멈춤 · 지급 시작', '처리 멈춤 · 지급 완료', '봇 자금 회수 실패']);
    expect(byTestId(html, `${prefix}-settlement_failed-${FIRST}`)?.attributes['data-kind']).toBe(
      'settlement_failed',
    );
  });

  it('draws a failed payout’s attempts, its error as stored and its ledger hold', () => {
    const row = `${prefix}-settlement_failed-${FIRST}`;
    expect(byTestId(html, `${row}-attempts`)?.text).toBe(
      `시도 3회 · 마지막 시도 ${formatKst('2026-11-22T03:02:00.000Z')}`,
    );
    expect(byTestId(html, `${row}-error-text`)?.text).toBe(
      '55000: ledger recovery approval is pending\nat settleMarketPositions',
    );
    expect(byTestId(html, `${row}-ledger-held`)?.text).toBe('대사 보류');
    expect(byTestId(html, `${row}-to-ledger`)?.attributes.href).toBe('/admin/audit-failures');
  });

  it('says when a stuck transition was due, and links a failed recall to its 회수 칸 alone', () => {
    expect(byTestId(html, `${prefix}-stuck-${SECOND}-since`)?.text).toBe(
      `${formatKst('2026-11-22T04:00:00.000Z')}에 일어났어야 했는데 30분 넘게 그대로입니다`,
    );
    const recall = `${prefix}-recall_failed-${FIRST}`;
    expect(byTestId(html, `${recall}-attempts`)?.text).toBe(
      `시도 4회 · ${copy.marketMakerRecallLastFailure} ${formatKst('2026-11-22T06:00:00.000Z')}`,
    );
    expect(byTestId(html, `${recall}-reason`)?.text).toBe(copy.marketMakerRecallExecution);
    expect(byTestId(html, `${recall}-to-recall`)?.attributes.href).toBe(
      `/admin/markets/${FIRST}#market-maker-recall`,
    );
  });

  it('offers 정산 다시 시도 on the 지급 중 rows alone, once the admin on screen is known', () => {
    // 145-14: the failed payout and '처리 멈춤 · 지급 완료' — never 지급 시작, never the recall (145-8).
    expect(testIdsStartingWith(html, `${prefix}-retry-`)).toEqual([
      `${prefix}-retry-${FIRST}`,
      `${prefix}-retry-${THIRD}`,
    ]);
    expect(byTestId(html, `${prefix}-retry-${FIRST}`)?.text).toBe('정산 다시 시도');
    expect(byTestId(html, `${prefix}-retry-${FIRST}`)?.attributes).not.toHaveProperty('disabled');
    expect(byTestId(draw(undefined), `${prefix}-retry-${FIRST}`)?.attributes).toHaveProperty(
      'disabled',
    );
    // No dialog until a button opens it.
    expect(byTestId(html, 'settlement-retry-dialog')).toBeUndefined();
  });
});

describe('the last error (145-18 "두 줄까지 보이고 펼칠 수 있다")', () => {
  it('stands under 마지막 오류 in a disclosure, as stored', () => {
    const html = renderWithQueries(<LastErrorText error={'첫 줄\n둘째 줄\n셋째 줄'} testId="e" />);
    expect(html).toMatch(/^<details data-testid="e"><summary/);
    expect(byTagName(html, 'summary')[0]?.text).toBe(
      `${copy.adminOperationsLastError}첫 줄\n둘째 줄\n셋째 줄`,
    );
    expect(byTestId(html, 'e-text')?.text).toBe('첫 줄\n둘째 줄\n셋째 줄');
  });
});
