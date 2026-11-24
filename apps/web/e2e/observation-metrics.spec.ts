import type { APIRequestContext, Page, Response } from '@playwright/test';
import {
  type AdminObservationMetrics,
  OBSERVATION_WEEKS_SHOWN,
  observationWeeks,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  discussionPostsComments,
  formatElapsed,
  observationCount,
  observationFraction,
  observationRatio,
} from '../src/lib/admin-observation-metrics';
import {
  adminAccount,
  commentThroughApi,
  createOpenMarket,
  dataOf,
  expect,
  expectNoSideScroll,
  freshEmail,
  freshTag,
  meOf,
  postThroughApi,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 관측 지표 (#96, ADR-0169; owner answers in ADR-0167, 96-7~96-11): an admin opens '관측 지표', the
 * last link of the admin menu, and reads four tables of 12 KST weeks — 첫 체결 전환, 정산 후 재참여,
 * 유효 토론, 신고 처리 시간 — that the server recounts from the records on every read. The e2e
 * database persists and other workers write at the same time, so a test says only that its own
 * writes are among the counts (deltas, `≥`), that the screen draws exactly the answer its own
 * request got, and the structure: 12 rows each, 진행 중 on the current week, the previous cohort
 * week 진행 중 unless it is 자료 없음 (a fresh database's previous week ended before the seed).
 */

const PATH = '/api/v1/admin/observation-metrics';
const ROOT = 'admin-observation-metrics';
const TABLES = ['first-fill', 'after-settlement', 'discussion', 'report-handling'] as const;

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

test.describe('관측 지표 (#96)', () => {
  test('관리자가 메뉴 끝의 관측 지표를 열면 네 표가 주 12개씩 보이고, 방금 쓴 글·댓글·신고 처리와 온보딩이 이번 주 값에 든다', async ({
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
      for (const table of TABLES) {
        // The current week is in progress in every table — never 자료 없음 on a seeded database
        // (and after 0064's deploy for 정산 후 재참여, 96-11).
        const row = page.getByTestId(`${ROOT}-${table}-${week}`);
        await expect(row).toHaveAttribute('data-in-progress', 'true');
        await expect(row).toHaveAttribute('data-no-data', 'false');
        await expect(row).toContainText(copy.adminObservationInProgress);
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
