import type { APIRequestContext, Page, Response } from '@playwright/test';
import {
  type AdminObservationMetrics,
  OBSERVATION_WEEKS_SHOWN,
  observationWeekFlags,
  observationWeeks,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  discussionPostsComments,
  formatElapsed,
  observationCount,
  observationCoverageOf,
  observationFraction,
  observationRatio,
} from '../src/lib/admin-observation-metrics';
import {
  adminAccount,
  closeMarket,
  commentThroughApi,
  createOpenMarket,
  dataOf,
  expect,
  expectNoSideScroll,
  freshEmail,
  freshTag,
  helperTraders,
  judgeMarket,
  meOf,
  postThroughApi,
  signIn,
  signUp,
  test,
  watchThroughApi,
} from './helpers';

/**
 * 관측 지표 (#96, ADR-0169; #151, ADR-0170; owner answers in ADR-0167, 96-7~96-11, 151-1~151-6):
 * an admin opens '관측 지표', the last link of the admin menu, and reads six tables of 12 KST weeks
 * — 첫 체결 전환, 정산 후 재참여, 유효 토론, 신고 처리 시간, then #151's 관심 등록 후 재방문 and 결과
 * 조회 — that the server recounts from the records on every read. The e2e database persists and
 * other workers write at the same time, so a test says only that its own writes are among the
 * counts (deltas, `≥`), that the screen draws exactly the answer its own request got, and the
 * structure: 12 rows each, 진행 중 on the current week, the previous cohort week 진행 중 unless it
 * is 자료 없음 (a fresh database's previous week ended before the seed).
 *
 * #151's two tables read the visit records, collected from migration 0082 on: on a database
 * migrated to 0082 after its accounts existed (the local persistent one) the weeks up to the one
 * 0082 ran in are 자료 없음 — with zeros — until the next Monday (ADR-0167 결정 8의 7). Every check
 * of their counts therefore reads the answer's `noData` for the week first, and under 자료 없음
 * checks the row says so and skips the count (an annotation says why); on CI's fresh database
 * 0082's marker precedes the seed and nothing is cut.
 */

const PATH = '/api/v1/admin/observation-metrics';
const VISITS = '/api/v1/me/market-visits';
const ROOT = 'admin-observation-metrics';
/** #96's four, whose current week is never 자료 없음 on a seeded database. */
const OCCURRENCE_AND_FILL_TABLES = [
  'first-fill',
  'after-settlement',
  'discussion',
  'report-handling',
] as const;
/** #151's two, appended after the four (96-7). */
const VISIT_TABLES = ['revisit', 'result-view'] as const;
const TABLES = [...OCCURRENCE_AND_FILL_TABLES, ...VISIT_TABLES] as const;

function metricsOf(context: APIRequestContext): Promise<AdminObservationMetrics> {
  return context.get(PATH).then((response) => dataOf<AdminObservationMetrics>(response));
}

/** The screen's own read of the answer, as it lands. */
function nextRead(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === PATH,
  );
}

/** The value cells of one row, the week and the 상태 left out. */
async function valueCells(page: Page, table: string, week: string): Promise<string[]> {
  const cells = await page.getByTestId(`${ROOT}-${table}-${week}`).locator('td').allInnerTexts();
  return cells.slice(1, -1).map((text) => text.trim());
}

/** The POST the market detail sends once per open (#151), as it lands. */
function nextVisit(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === VISITS,
  );
}

/** Whether a visit table's week is 자료 없음 in `answer`; if so, says why the count is skipped. */
function visitWeekCut(
  week: { week: string; noData: boolean },
  table: (typeof VISIT_TABLES)[number],
): boolean {
  if (!week.noData) return false;
  test.info().annotations.push({
    type: 'skip-reason',
    description:
      `${table} ${week.week} is 자료 없음 (visits collected from 0082 on, after this ` +
      'database’s accounts existed — ADR-0167 결정 8의 7): its count is not compared',
  });
  return true;
}

test.describe('관측 지표 (#96)', () => {
  test('관리자가 메뉴 끝의 관측 지표를 열면 여섯 표가 주 12개씩 보이고, 방금 쓴 글·댓글·신고 처리와 온보딩이 이번 주 값에 든다', async ({
    page,
    admin,
    browser,
  }) => {
    const tag = freshTag();
    const before = await metricsOf(admin);
    expect(before.firstFill).toHaveLength(OBSERVATION_WEEKS_SHOWN);

    const market = await createOpenMarket(admin);
    const authorContext = await browser.newContext();
    const reporterContext = await browser.newContext();
    try {
      // Member A finishes onboarding (첫 체결 전환's start) and writes a post and a comment.
      const author = await authorContext.newPage();
      await signUp(author, freshEmail());
      const postId = await postThroughApi(
        author.request,
        market.id,
        `관측 지표 글 ${tag}`,
        `관측 지표 본문 ${tag}`,
      );
      await commentThroughApi(author.request, postId, null, `관측 지표 댓글 ${tag}`);

      // Member B — not the author, not an admin (결정 8의 2) — reports the post, and the admin
      // dismisses it: one closing on one target, one 건 of 신고 처리 시간.
      const reporter = await reporterContext.newPage();
      await signUp(reporter, freshEmail());
      const reporterMe = await meOf(reporter.request);
      const reported = await reporter.request.post(`/api/v1/posts/${postId}/reports`, {
        data: {
          reason: 'other',
          description: `관측 지표 신고 ${tag}`,
          expectedAccountId: reporterMe.id,
        },
      });
      expect(reported.status(), await reported.text()).toBe(201);
      const reportId = ((await reported.json()) as { data: { id: string } }).data.id;
      const operator = await meOf(admin);
      const dismissed = await admin.post('/api/v1/admin/reports/dismiss', {
        data: {
          reportIds: [reportId],
          reason: `관측 지표 시험의 정리 ${tag}`,
          expectedAccountId: operator.id,
        },
      });
      expect(dismissed.status(), await dismissed.text()).toBe(200);

      const after = await metricsOf(admin);
      const current = after.firstFill[0]!.week;
      if (current === before.firstFill[0]!.week) {
        // Other workers may hide or delete their own rows meanwhile, so each count is compared
        // with what this test added alone.
        expect(after.discussion[0]!.posts).toBeGreaterThanOrEqual(1);
        expect(after.discussion[0]!.comments).toBeGreaterThanOrEqual(1);
        expect(after.firstFill[0]!.accounts).toBeGreaterThanOrEqual(
          before.firstFill[0]!.accounts + 2,
        );
        expect(after.reportHandling[0]!.cases).toBeGreaterThanOrEqual(
          before.reportHandling[0]!.cases + 1,
        );
      } else {
        test.info().annotations.push({
          type: 'note',
          description: 'the run crossed Monday 00:00 in Seoul: this week’s growth is not compared',
        });
      }

      // --- the menu: 관측 지표 last (96-7).
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/markets');
      const nav = page.getByTestId('admin-nav');
      await expect(nav.getByRole('link').last()).toHaveText(copy.adminObservationMetrics);
      const read = nextRead(page);
      await nav.getByRole('link', { name: copy.adminObservationMetrics, exact: true }).click();
      await expect(page).toHaveURL('/admin/observation-metrics');
      const response = await read;
      expect(response.status()).toBe(200);
      const shown = ((await response.json()) as { data: AdminObservationMetrics }).data;

      const screen = page.getByTestId(ROOT);
      await expect(screen.getByRole('heading', { level: 3 })).toHaveText(
        copy.adminObservationMetrics,
      );
      await expect(screen).toContainText(copy.adminObservationIntro);
      await expect(page.getByTestId(`${ROOT}-as-of`)).toContainText(copy.adminObservationAsOf);
      for (const table of TABLES) {
        await expect(page.getByTestId(`${ROOT}-${table}`).locator('tbody tr')).toHaveCount(
          OBSERVATION_WEEKS_SHOWN,
        );
      }

      // --- 진행 중 and 자료 없음, as the answer the screen got says.
      const week = shown.firstFill[0]!.week;
      for (const table of OCCURRENCE_AND_FILL_TABLES) {
        // The current week is in progress in every table — never 자료 없음 on a seeded database
        // (and after 0064's deploy for 정산 후 재참여, 96-11).
        const row = page.getByTestId(`${ROOT}-${table}-${week}`);
        await expect(row).toHaveAttribute('data-in-progress', 'true');
        await expect(row).toHaveAttribute('data-no-data', 'false');
        await expect(row).toContainText(copy.adminObservationInProgress);
      }
      // #151's two: the flags the answer carries, recomputed with the one shared function from
      // the answer's coverage (the collection start, the purge horizon), the 상태 cell as they say.
      const coverage = observationCoverageOf(shown);
      const asOf = new Date(shown.asOf);
      for (const [table, metric, rows] of [
        ['revisit', 'revisit', shown.revisit],
        ['result-view', 'resultView', shown.resultView],
      ] as const) {
        expect(rows).toHaveLength(OBSERVATION_WEEKS_SHOWN);
        for (const [index, weekOf] of observationWeeks(asOf).entries()) {
          const row = rows[index]!;
          expect(row.week).toBe(weekOf.week);
          expect(
            { inProgress: row.inProgress, noData: row.noData },
            `${table} ${row.week}`,
          ).toEqual(observationWeekFlags(weekOf, metric, asOf, coverage));
        }
        for (const row of rows.slice(0, 2)) {
          const drawn = page.getByTestId(`${ROOT}-${table}-${row.week}`);
          await expect(drawn).toHaveAttribute('data-no-data', String(row.noData));
          await expect(drawn).toHaveAttribute('data-in-progress', String(row.inProgress));
          // The two newest weeks: 진행 중 unless 자료 없음 (결정 8의 6·7).
          await expect(page.getByTestId(`${ROOT}-${table}-${row.week}-state`)).toHaveText(
            row.noData ? copy.adminObservationNoData : copy.adminObservationInProgress,
          );
        }
      }
      for (const [table, rows] of [
        ['first-fill', shown.firstFill],
        ['after-settlement', shown.afterSettlement],
      ] as const) {
        const previous = rows[1]!;
        const row = page.getByTestId(`${ROOT}-${table}-${previous.week}`);
        await expect(row).toHaveAttribute('data-no-data', String(previous.noData));
        await expect(row).toHaveAttribute('data-in-progress', String(!previous.noData));
        await expect(row).toContainText(
          previous.noData ? copy.adminObservationNoData : copy.adminObservationInProgress,
        );
      }
      // The occurrence tables' previous week is over.
      for (const [table, rows] of [
        ['discussion', shown.discussion],
        ['report-handling', shown.reportHandling],
      ] as const) {
        await expect(page.getByTestId(`${ROOT}-${table}-${rows[1]!.week}`)).toHaveAttribute(
          'data-in-progress',
          'false',
        );
      }

      // --- the current week's numbers are the answer's, cell for cell.
      const firstFill = shown.firstFill[0]!;
      expect(await valueCells(page, 'first-fill', week)).toEqual([
        observationRatio(firstFill.filled, firstFill.accounts).text,
        observationFraction(firstFill.filled, firstFill.accounts),
      ]);
      const settlement = shown.afterSettlement[0]!;
      expect(await valueCells(page, 'after-settlement', week)).toEqual([
        observationRatio(settlement.returned, settlement.pairs).text,
        observationFraction(settlement.returned, settlement.pairs),
      ]);
      const discussion = shown.discussion[0]!;
      expect(await valueCells(page, 'discussion', week)).toEqual([
        discussionPostsComments(discussion),
        observationCount(discussion.authors),
        observationCount(discussion.markets),
      ]);
      const reports = shown.reportHandling[0]!;
      expect(await valueCells(page, 'report-handling', week)).toEqual([
        observationCount(reports.cases),
        formatElapsed(reports.medianMs),
        formatElapsed(reports.p90Ms),
        observationCount(reports.pendingTargets),
      ]);
      for (const [table, rows] of [
        ['revisit', shown.revisit.map((row) => [row.revisited, row.pairs, row.noData] as const)],
        [
          'result-view',
          shown.resultView.map((row) => [row.viewed, row.pairs, row.noData] as const),
        ],
      ] as const) {
        const [numerator, denominator, noData] = rows[0]!;
        expect(await valueCells(page, table, week)).toEqual(
          noData
            ? [copy.adminObservationNoData, copy.adminObservationNoData]
            : [
                observationRatio(numerator, denominator).text,
                observationFraction(numerator, denominator),
              ],
        );
      }
      if (week === after.firstFill[0]!.week) {
        expect(discussion.posts).toBeGreaterThanOrEqual(1);
        expect(reports.cases).toBeGreaterThanOrEqual(1);
      }

      // Counts only (95-10): no link, no account, no post on the screen.
      await expect(screen.locator('a')).toHaveCount(0);
      await expect(screen).not.toContainText(reporterMe.profile.nickname);
      await expect(screen).not.toContainText(tag);
      await expectNoSideScroll(page);
    } finally {
      await authorContext.close();
      await reporterContext.close();
    }
  });

  test('자료가 없는 주는 모든 칸이 자료 없음이고 진행 중이 아니며, 좁은 화면에서도 페이지가 옆으로 밀리지 않는다', async ({
    page,
  }) => {
    // An empty database's answer (dataStart null): every week of every table is 자료 없음.
    const asOf = new Date();
    const weeks = observationWeeks(asOf);
    const flags = { inProgress: false, noData: true };
    const empty: AdminObservationMetrics = {
      asOf: asOf.toISOString(),
      dataStart: null,
      visitsSince: null,
      visitsPurgedThrough: null,
      firstFill: weeks.map(({ week }) => ({ week, ...flags, accounts: 0, filled: 0 })),
      afterSettlement: weeks.map(({ week }) => ({ week, ...flags, pairs: 0, returned: 0 })),
      discussion: weeks.map(({ week }) => ({
        week,
        ...flags,
        posts: 0,
        comments: 0,
        authors: 0,
        markets: 0,
      })),
      reportHandling: weeks.map(({ week }) => ({
        week,
        ...flags,
        cases: 0,
        medianMs: null,
        p90Ms: null,
        pendingTargets: 0,
      })),
      pendingTargetsEarlier: 0,
      revisit: weeks.map(({ week }) => ({ week, ...flags, pairs: 0, revisited: 0 })),
      resultView: weeks.map(({ week }) => ({ week, ...flags, pairs: 0, viewed: 0 })),
    };
    await page.route(`**${PATH}`, (route) => route.fulfill({ json: { data: empty } }));

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/observation-metrics');
    const screen = page.getByTestId(ROOT);
    await expect(page.getByTestId(`${ROOT}-as-of`)).toBeVisible();
    for (const table of TABLES) {
      const rows = page.getByTestId(`${ROOT}-${table}`).locator('tbody tr');
      await expect(rows).toHaveCount(OBSERVATION_WEEKS_SHOWN);
      for (const { week } of weeks) {
        const row = page.getByTestId(`${ROOT}-${table}-${week}`);
        await expect(row).toHaveAttribute('data-no-data', 'true');
        await expect(row).toHaveAttribute('data-in-progress', 'false');
        // The 상태 cell reads 자료 없음, never 진행 중 (the cohort note's sentence under the
        // definition mentions 진행 중 on every answer, so the check is the cell's, not the screen's).
        await expect(page.getByTestId(`${ROOT}-${table}-${week}-state`)).toHaveText(
          copy.adminObservationNoData,
        );
      }
      const cells = await valueCells(page, table, weeks[0]!.week);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((text) => text === copy.adminObservationNoData)).toBe(true);
    }
    await expect(screen.getByText(copy.adminObservationInProgress, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId(`${ROOT}-pending-earlier`)).toHaveCount(0);
    // At 375px each table scrolls inside its own frame; the page never does.
    await expectNoSideScroll(page);
  });

  test('체결한 회원이 잠정 결과가 공개된 날 시장 상세를 열면 결과 조회에 들고, 관심 등록한 회원은 재방문의 대상 쌍에 들며, 관리자의 방문도 204로 끝난다 (#151)', async ({
    page,
    admin,
    browser,
    baseURL,
  }) => {
    test.slow();
    const traders = await helperTraders(admin);
    const market = await createOpenMarket(admin);
    const before = await metricsOf(admin);
    const traderContext = await browser.newContext({
      baseURL,
      storageState: await traders[0].storageState(),
    });
    const watcherContext = await browser.newContext({ baseURL });
    try {
      // --- 결과 조회 (151-2): the helper's two members trade once (`closeMarket`), the market is
      // judged — version 1 published now, a cohort of this week — and one of them opens the
      // detail the same day (95-12: D counts).
      await closeMarket(admin, market.id);
      await judgeMarket(admin, market.id);
      const judged = await metricsOf(admin);
      const current = judged.resultView[0]!;
      const sameWeek = current.week === before.resultView[0]!.week;
      if (sameWeek && !visitWeekCut(current, 'result-view')) {
        // The two members' sides, among whatever other workers added.
        expect(current.pairs).toBeGreaterThanOrEqual(before.resultView[0]!.pairs + 2);
      }

      const traderPage = await traderContext.newPage();
      const visit = nextVisit(traderPage);
      await traderPage.goto(`/markets/${market.slug}`);
      const recorded = await visit;
      expect(recorded.status()).toBe(204);
      // The market travels in the body, never the path (the request log keeps the path).
      expect(new URL(recorded.url()).pathname).toBe(VISITS);
      expect(recorded.request().postDataJSON()).toEqual({
        expectedAccountId: (await meOf(traders[0])).id,
        marketId: market.id,
      });

      const viewed = await metricsOf(admin);
      const viewedRow = viewed.resultView[0]!;
      if (viewedRow.week === current.week && !visitWeekCut(viewedRow, 'result-view')) {
        expect(viewedRow.viewed).toBeGreaterThanOrEqual(current.viewed + 1);
      }

      // --- 관심 등록 후 재방문 (151-1): a fresh member's first watch is a start of this week; its
      // same-day open is not a revisit (D+1~D+7), and the D+1 boundaries live in the db and api
      // tests — the e2e has no clock of its own.
      const watcher = await watcherContext.newPage();
      await signUp(watcher, freshEmail());
      const beforeWatch = await metricsOf(admin);
      await watchThroughApi(watcher, market.id);
      const watcherVisit = nextVisit(watcher);
      await watcher.goto(`/markets/${market.slug}`);
      expect((await watcherVisit).status()).toBe(204);
      const watched = await metricsOf(admin);
      const watchedRow = watched.revisit[0]!;
      if (
        watchedRow.week === beforeWatch.revisit[0]!.week &&
        !visitWeekCut(watchedRow, 'revisit')
      ) {
        expect(watchedRow.pairs).toBeGreaterThanOrEqual(beforeWatch.revisit[0]!.pairs + 1);
      }

      // --- the admin's own open (151-3): the same answer, 204, and nothing said about a row (no
      // assertion on the totals — other workers write meanwhile).
      await signIn(page, adminAccount.email, adminAccount.password);
      const adminVisit = nextVisit(page);
      await page.goto(`/markets/${market.slug}`);
      expect((await adminVisit).status()).toBe(204);

      // --- the screen draws the answer its own read got, for both tables' current week.
      const read = nextRead(page);
      await page.goto('/admin/observation-metrics');
      const shown = ((await (await read).json()) as { data: AdminObservationMetrics }).data;
      for (const [table, numerator, denominator, row] of [
        ['revisit', shown.revisit[0]!.revisited, shown.revisit[0]!.pairs, shown.revisit[0]!],
        [
          'result-view',
          shown.resultView[0]!.viewed,
          shown.resultView[0]!.pairs,
          shown.resultView[0]!,
        ],
      ] as const) {
        await expect(page.getByTestId(`${ROOT}-${table}-${row.week}`)).toHaveAttribute(
          'data-no-data',
          String(row.noData),
        );
        await expect(page.getByTestId(`${ROOT}-${table}-${row.week}-state`)).toHaveText(
          row.noData ? copy.adminObservationNoData : copy.adminObservationInProgress,
        );
        expect(await valueCells(page, table, row.week)).toEqual(
          row.noData
            ? [copy.adminObservationNoData, copy.adminObservationNoData]
            : [
                observationRatio(numerator, denominator).text,
                observationFraction(numerator, denominator),
              ],
        );
      }
      await expect(page.getByTestId(`${ROOT}-revisit-note`)).toHaveText(
        copy.adminObservationVisitCohortNote,
      );
      await expect(page.getByTestId(`${ROOT}-result-view-note`)).toHaveText(
        copy.adminObservationVisitCohortNote,
      );
      // Counts only (95-10): no market, no account on the screen.
      await expect(page.getByTestId(ROOT)).not.toContainText(market.tag);
    } finally {
      await traderContext.close();
      await watcherContext.close();
    }
  });

  test('관리자가 아닌 계정은 /admin/observation-metrics를 열 수 없고, API는 거절한다', async ({
    page,
  }) => {
    await signUp(page, freshEmail());
    await page.goto('/admin/observation-metrics');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId(ROOT)).toHaveCount(0);
    const refused = await page.request.get(PATH);
    expect(refused.status()).toBe(403);
  });
});
