import {
  type ObservationMetric,
  OBSERVATION_WEEKS_SHOWN,
  observationWeekFlags,
  observationWeeks,
} from '@buddha/shared';
import { type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_OBSERVATION_METRICS_KEY } from '@/hooks/use-admin-observation-metrics';
import { type AdminObservationMetrics as Metrics } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminObservationMetrics } from './admin-observation-metrics';

const ROOT = 'admin-observation-metrics';
const AS_OF = '2026-11-24T06:00:00.000Z';
/** A Sunday morning in Seoul: the oldest shown week (from 2026-09-07) ends before it. */
const DATA_START = '2026-09-19T23:00:00.000Z';
const WEEKS = observationWeeks(new Date(AS_OF));
const [CURRENT, PREVIOUS, THIRD] = WEEKS.map((week) => week.week) as [string, string, string];
const OLDEST = WEEKS[OBSERVATION_WEEKS_SHOWN - 1]!.week;

/** The weeks of one metric with the server's flags, each row's numbers from `fields`. */
function rows<T>(metric: ObservationMetric, fields: (index: number) => T) {
  return WEEKS.map((week, index) => ({
    week: week.week,
    ...observationWeekFlags(week, metric, new Date(AS_OF), new Date(DATA_START)),
    ...fields(index),
  }));
}

function answer(fields: Partial<Metrics> = {}): Metrics {
  return {
    asOf: AS_OF,
    dataStart: DATA_START,
    firstFill: rows('firstFill', (index) =>
      index === 0 ? { accounts: 7, filled: 3 } : { accounts: 0, filled: 0 },
    ),
    afterSettlement: rows('afterSettlement', (index) =>
      index === 1 ? { pairs: 4, returned: 1 } : { pairs: 0, returned: 0 },
    ),
    discussion: rows('discussion', (index) =>
      index === 0
        ? { posts: 3, comments: 9, authors: 5, markets: 2 }
        : { posts: 0, comments: 0, authors: 0, markets: 0 },
    ),
    reportHandling: rows('reportHandling', (index) =>
      index === 2
        ? {
            cases: 4,
            medianMs: 3 * 3_600_000 + 5 * 60_000,
            p90Ms: 52 * 3_600_000,
            pendingTargets: 2,
          }
        : { cases: 0, medianMs: null, p90Ms: null, pendingTargets: 0 },
    ),
    pendingTargetsEarlier: 0,
    ...fields,
  };
}

const TABLES = ['first-fill', 'after-settlement', 'discussion', 'report-handling'] as const;

/** The text of each cell of one row. */
function cells(html: string, slug: string, week: string): string[] {
  const row = byTestId(html, `${ROOT}-${slug}-${week}`);
  if (row === undefined) throw new Error(`no row ${slug} ${week}`);
  const start = html.indexOf(`data-testid="${ROOT}-${slug}-${week}"`);
  const end = html.indexOf('</tr>', start);
  return byTagName(html.slice(start, end), 'td').map((cell) => cell.text);
}

/** 관측 지표 as drawn (#96, ADR-0169; 96-7~96-9). */
describe('AdminObservationMetrics', () => {
  it('draws the heading, the intro, 기준 시각 and four tables of 12 weeks, newest first', () => {
    const html = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, answer()],
    ]);
    const screen = byTestId(html, ROOT);
    expect(byTagName(html, 'h3').map((h) => h.text)).toEqual([copy.adminObservationMetrics]);
    expect(screen?.text).toContain(copy.adminObservationIntro);
    expect(byTestId(html, `${ROOT}-as-of`)?.text).toBe(`기준 시각 ${formatKst(AS_OF)}`);
    expect(byTagName(html, 'h4').map((h) => h.text)).toEqual([
      copy.adminObservationFirstFill,
      copy.adminObservationAfterSettlement,
      copy.adminObservationDiscussion,
      copy.adminObservationReportHandling,
    ]);
    expect(
      ['first-fill', 'after-settlement', 'discussion', 'report-handling'].map(
        (slug) => byTestId(html, `${ROOT}-${slug}-hint`)?.text,
      ),
    ).toEqual([
      copy.adminObservationFirstFillHint,
      copy.adminObservationAfterSettlementHint,
      copy.adminObservationDiscussionHint,
      copy.adminObservationReportHandlingHint,
    ]);
    // The cohort note on the two cohort tables only.
    expect(byTestId(html, `${ROOT}-first-fill-note`)?.text).toBe(copy.adminObservationCohortNote);
    expect(byTestId(html, `${ROOT}-after-settlement-note`)?.text).toBe(
      copy.adminObservationCohortNote,
    );
    expect(byTestId(html, `${ROOT}-discussion-note`)).toBeUndefined();
    expect(byTestId(html, `${ROOT}-report-handling-note`)).toBeUndefined();
    // The column headers, table by table.
    const headers = (slug: string) => {
      const table = byTestId(html, `${ROOT}-${slug}`);
      expect(table).toBeDefined();
      const start = html.indexOf(`data-testid="${ROOT}-${slug}"`);
      return byTagName(html.slice(start, html.indexOf('</thead>', start)), 'th').map(
        (th) => th.text,
      );
    };
    expect(headers('first-fill')).toEqual(['주', '비율', '체결한 계정 / 대상 계정', '상태']);
    expect(headers('after-settlement')).toEqual(['주', '비율', '재참여 쌍 / 대상 쌍', '상태']);
    expect(headers('discussion')).toEqual(['주', '글·댓글', '쓴 계정', '토론이 있는 시장', '상태']);
    expect(headers('report-handling')).toEqual([
      '주',
      '처리 건수',
      '중앙값',
      '90번째 백분위',
      '대기',
      '상태',
    ]);
    // Twelve rows each, newest first, named by the week.
    for (const slug of TABLES) {
      const ids = testIdsStartingWith(html, `${ROOT}-${slug}-`).filter((id) =>
        /-\d{4}-\d{2}-\d{2}$/.test(id),
      );
      expect(ids, slug).toEqual(WEEKS.map((week) => `${ROOT}-${slug}-${week.week}`));
    }
    expect(cells(html, 'first-fill', CURRENT)[0]).toBe('11. 23.(월) ~ 11. 29.(일)');
    expect(cells(html, 'first-fill', OLDEST)[0]).toBe('9. 7.(월) ~ 9. 13.(일)');
    // Counts only: no link anywhere on the screen (no drill-down, no export — 95-10).
    expect(byTagName(html, 'a')).toEqual([]);
    expect(byTagName(html, 'button')).toEqual([]);
  });

  it('marks 진행 중 on the two newest cohort weeks and the current occurrence week', () => {
    const html = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, answer()],
    ]);
    const inProgress = (slug: string) =>
      WEEKS.map((week) => week.week).filter(
        (week) =>
          byTestId(html, `${ROOT}-${slug}-${week}`)?.attributes['data-in-progress'] === 'true',
      );
    expect(inProgress('first-fill')).toEqual([CURRENT, PREVIOUS]);
    expect(inProgress('after-settlement')).toEqual([CURRENT, PREVIOUS]);
    expect(inProgress('discussion')).toEqual([CURRENT]);
    expect(inProgress('report-handling')).toEqual([CURRENT]);
    expect(byTestId(html, `${ROOT}-first-fill-${PREVIOUS}-state`)?.text).toBe(
      copy.adminObservationInProgress,
    );
    expect(byTestId(html, `${ROOT}-discussion-${PREVIOUS}-state`)?.text).toBe('');
    expect(byTestId(html, `${ROOT}-first-fill-${THIRD}-state`)?.text).toBe('');
  });

  it('writes 자료 없음 in every value cell of a week with no data, never with 진행 중', () => {
    const html = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, answer()],
    ]);
    // The oldest week ended before the earliest account, in every table.
    for (const slug of TABLES) {
      const row = byTestId(html, `${ROOT}-${slug}-${OLDEST}`);
      expect(row?.attributes['data-no-data'], slug).toBe('true');
      expect(row?.attributes['data-in-progress'], slug).toBe('false');
      const [, ...rest] = cells(html, slug, OLDEST);
      expect(
        rest.every((text) => text === copy.adminObservationNoData),
        slug,
      ).toBe(true);
      expect(row?.text).not.toContain(copy.adminObservationInProgress);
    }
    // 정산 후 재참여 before 0064's deploy (96-11): every week but the two newest.
    const noData = WEEKS.map((week) => week.week).filter(
      (week) =>
        byTestId(html, `${ROOT}-after-settlement-${week}`)?.attributes['data-no-data'] === 'true',
    );
    expect(noData).toEqual(WEEKS.slice(2).map((week) => week.week));
    expect(cells(html, 'after-settlement', THIRD)).toEqual([
      '11. 9.(월) ~ 11. 15.(일)',
      '자료 없음',
      '자료 없음',
      '자료 없음',
    ]);
    // A row the server sent with both flags still reads 자료 없음 alone.
    const both = answer();
    both.discussion[0] = { ...both.discussion[0]!, inProgress: true, noData: true };
    const drawn = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, both],
    ]);
    expect(byTestId(drawn, `${ROOT}-discussion-${CURRENT}`)?.text).not.toContain(
      copy.adminObservationInProgress,
    );
    expect(byTestId(drawn, `${ROOT}-discussion-${CURRENT}-state`)?.text).toBe(
      copy.adminObservationNoData,
    );
  });

  it('draws each table’s numbers: ratio and counts, 96-8’s cell, durations and —', () => {
    const html = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, answer()],
    ]);
    expect(cells(html, 'first-fill', CURRENT)).toEqual([
      '11. 23.(월) ~ 11. 29.(일)',
      '42.9%',
      '3 / 7',
      copy.adminObservationInProgress,
    ]);
    // No account onboarded that week: — read as 대상 없음, the counts beside it.
    expect(cells(html, 'first-fill', THIRD).slice(1)).toEqual(['—', '0 / 0', '']);
    expect(html).toContain(`aria-label="${copy.adminObservationNoTarget}"`);
    expect(html).toContain(`title="${copy.adminObservationNoTarget}"`);
    expect(cells(html, 'after-settlement', PREVIOUS).slice(1)).toEqual([
      '25.0%',
      '1 / 4',
      copy.adminObservationInProgress,
    ]);
    expect(cells(html, 'discussion', CURRENT).slice(1)).toEqual([
      '글·댓글 12 (글 3 · 댓글 9)',
      '5',
      '2',
      copy.adminObservationInProgress,
    ]);
    // No denominator: 0 is a value.
    expect(cells(html, 'discussion', PREVIOUS).slice(1)).toEqual([
      '글·댓글 0 (글 0 · 댓글 0)',
      '0',
      '0',
      '',
    ]);
    expect(cells(html, 'report-handling', THIRD).slice(1)).toEqual([
      '4',
      '3시간 5분',
      '2일 4시간',
      '2',
      '',
    ]);
    expect(cells(html, 'report-handling', PREVIOUS).slice(1)).toEqual(['0', '—', '—', '0', '']);
    // No pending target older than the shown weeks: no line.
    expect(byTestId(html, `${ROOT}-pending-earlier`)).toBeUndefined();
  });

  it('says how many pending targets are older than the shown weeks', () => {
    const html = renderWithQueries(<AdminObservationMetrics />, [
      [ADMIN_OBSERVATION_METRICS_KEY, answer({ pendingTargetsEarlier: 3 })],
    ]);
    expect(byTestId(html, `${ROOT}-pending-earlier`)?.text).toBe(
      '보이는 주보다 앞서 접수된 대기 대상 3개',
    );
  });

  it('shows a skeleton, a failed first read with 다시 시도, and a failed refresh over the numbers', () => {
    const loading = renderWithQueries(<AdminObservationMetrics />);
    expect(byTestId(loading, ROOT)?.text).toContain(copy.adminObservationIntro);
    expect(byTestId(loading, `${ROOT}-first-fill`)).toBeUndefined();
    expect(byTestId(loading, `${ROOT}-error`)).toBeUndefined();

    const failed = renderWithQueries(
      <AdminObservationMetrics />,
      [],
      (queryClient: QueryClient) => {
        queryClient.setQueryDefaults(ADMIN_OBSERVATION_METRICS_KEY, { retryOnMount: false });
        queryClient
          .getQueryCache()
          .build(queryClient, { queryKey: ADMIN_OBSERVATION_METRICS_KEY })
          .setState({ status: 'error', error: new Error('503'), fetchStatus: 'idle' });
      },
    );
    expect(byTestId(failed, `${ROOT}-error`)?.text).toContain(copy.errUnknown);
    expect(byTestId(failed, `${ROOT}-retry`)?.text).toBe(copy.retry);
    expect(byTestId(failed, `${ROOT}-first-fill`)).toBeUndefined();

    const stale = renderWithQueries(
      <AdminObservationMetrics />,
      [[ADMIN_OBSERVATION_METRICS_KEY, answer()]],
      (queryClient: QueryClient) => {
        queryClient
          .getQueryCache()
          .find({ queryKey: ADMIN_OBSERVATION_METRICS_KEY, exact: true })
          ?.setState({ status: 'error', error: new Error('503') });
      },
    );
    expect(byTestId(stale, `${ROOT}-stale`)?.text).toContain(copy.adminMarketRefreshFailed);
    expect(byTestId(stale, `${ROOT}-stale`)?.text).toContain(copy.retry);
    // The numbers held stay.
    expect(cells(stale, 'first-fill', CURRENT)[1]).toBe('42.9%');
  });
});
