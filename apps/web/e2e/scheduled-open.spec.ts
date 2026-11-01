import type { APIRequestContext, Page, Request } from '@playwright/test';
import type { AdminMarket } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  accountIdOf,
  adminAccount,
  approveAsReviewer,
  createDraftMarket,
  documentSurvived,
  expect,
  expectYellowWarning,
  markDocument,
  meOf,
  REVIEW_CHECKLIST,
  secondAdminAccount,
  sendBackToDraft,
  signIn,
  submitForReview,
  subscribed,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * 예정 개장 (#21, ADR-0100; ADR-0093 decision 1 #173 item 1, decision 2 #172 item 6 and decision 3
 * '#21 앞당긴 개장'): a market opens only from 개장 예정, at its scheduled open, with nobody pressing
 * anything — the worker's `market.open` job the approval registered, and its per-minute scan behind
 * it — and the event log names 시스템 as its opener. Approved after its scheduled open, it opens in
 * the approval itself: the approving admin sees 거래 중 at once, its 연 시각 is the approval's and
 * the event log names that admin. There is no 열기 on any status, and its route is gone. A 개장 예정
 * market whose close passes before it opens never opens: its admin detail warns, and an admin
 * sends it back to a draft to fix its times (#172 item 6). Moving the scheduled open earlier to a
 * time already come opens it at once too — market-times.spec.ts walks that through the dialog.
 * Every open records the content the review locked as rule v1 at its instant, made by its opener —
 * nobody for the worker's (#80, ADR-0101; rule-versions.spec.ts reads it on the detail).
 *
 * The scheduled open must come before the close (#172 item 12, whole minutes), so with the worker
 * running a market opens before its close; only a worker down from its scheduled open to its close
 * leaves it 개장 예정 past the close. That wait is the worker's integration test
 * (apps/worker/src/jobs/market-open.test.ts: the job skips it, `close_passed`, and the scan never
 * picks it); the admin detail reads its warning off the browser's clock (lib/market-review.ts
 * `scheduledCloseLapsed`), so here the browser's clock stands a minute past a close two hours away.
 *
 * Admin 1 (`admin`) makes and submits every market; admin 2 approves it — on screen as
 * `secondAdmin`, or through the API as the reviewer `admin` is paired with (helpers.ts
 * `approveAsReviewer`). The test that waits for the worker skips when its probe is off
 * (`WORKER_HEALTH_PORT=0`), as settlement.spec.ts does. The records — the `opened` event's actor
 * and source, the jobs registered and moved — are the API's and the worker's integration tests
 * (admin-markets-review.controller.test.ts, market-open.test.ts); the panel's note and warning and
 * the toasts' choice are unit-tested (market-review-panel.test.tsx, lib/market-review.test.ts).
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How far ahead the market the worker opens has its scheduled open: room for its making, its
 * submission and its approval, and the visitor's and the admin's first loads, to land before it, on
 * a slow box too (the admin signs in before it is set).
 */
const OPEN_IN_MS = 70_000;

/**
 * How long that test waits for the open: the scheduled open, and then a whole minute more for the
 * per-minute scan should the delayed job be lost.
 */
const OPEN_WAIT_MS = 150_000;

/**
 * How long the admin detail left open may take to show the open once the API answers `open`: one
 * 5 s poll (`SCHEDULED_OPEN_POLL_MS`), with room for the read itself.
 */
const ADMIN_POLL_WAIT_MS = 15_000;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** A time the spec set, which the type allows to be null. */
function present(iso: string | null): string {
  if (iso === null) throw new Error('the market has no such time');
  return iso;
}

/** The admin market as `context` reads it. */
async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  const response = await context.get(`/api/v1/admin/markets/${id}`);
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: AdminMarket }).data;
}

/** The `POST /admin/markets/:id/<write>` this page sends next. */
function nextWrite(page: Page, id: string, write: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${id}/${write}`,
  );
}

/** A row of the admin market detail (`market-detail-…`): its value. */
const detailRow = (page: Page, testId: string) => page.getByTestId(testId).locator('dd');

/** The 검수 기록's entries, newest first, by type. */
function logTypes(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('market-review-log')
    .locator('[data-type]')
    .evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-type')));
}

/** Skips the test before it makes a market when the config has no worker probe to wait on. */
function skipWithoutWorkerProbe(): void {
  test.skip(
    workerProbeDisabled(),
    'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
  );
}

test.describe('예정 개장', () => {
  test('예정 개장 시각이 지난 뒤에 다른 관리자가 승인하면 그 승인으로 바로 거래 중이 되어, 연 시각은 승인한 시각이고 이벤트 로그의 열림은 승인한 관리자가 했다고 보이며, 방문자의 상세도 거래 중이다', async ({
    admin,
    secondAdmin,
    browser,
    page,
  }) => {
    const second = await meOf(secondAdmin);
    // Its scheduled open a minute before this one (helpers.ts `timesFor`), submitted by admin 1.
    const market = await createDraftMarket(admin);
    const scheduledOpenAt = present(market.times.scheduledOpenAt);
    const submitted = await submitForReview(admin, market.id);
    const reason = `예정 개장 시각이 지나 승인과 함께 엽니다 ${market.tag}`;

    const secondContext = await browser.newContext();
    try {
      // --- admin 2 on the detail of a market in review: no 연 시각 yet.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      const status = secondPage.getByTestId('market-detail-status');
      await expect(status).toHaveText(copy.marketStatusReview);
      await expect(detailRow(secondPage, 'market-detail-open-at')).toHaveText('—');

      // --- 승인, as any approval: the dialog says a market past its scheduled open opens at once.
      await secondPage.getByTestId('market-review-approve').click();
      const dialog = secondPage.getByTestId('market-review-approve-dialog');
      await expect(dialog).toContainText(copy.adminMarketReviewApproveBody);
      for (const item of REVIEW_CHECKLIST) {
        await dialog.getByTestId(`market-review-check-${item}`).click();
      }
      await dialog.getByTestId('market-review-approve-reason').fill(reason);
      const approved = nextWrite(secondPage, market.id, 'approve');
      await dialog.getByTestId('market-review-approve-dialog-confirm').click();
      expect((await approved).postDataJSON()).toEqual({
        requestId: submitted.review.pending?.requestId,
        checklist: REVIEW_CHECKLIST,
        reason,
        expectedAccountId: second.id,
      });
      // The answer is the OPEN market: its toast, and 거래 중 straight from 검수 중.
      await expect(secondPage.getByText(copy.adminMarketReviewApprovedOpened)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(status).toHaveText(copy.marketStatusOpen);

      // --- opened by the approval, at its instant: the `opened` event after the `approved` one,
      // both admin 2's, and 연 시각 that event's instant — not before the scheduled open.
      const opened = await adminMarketOf(secondAdmin, market.id);
      expect(opened.status).toBe('open');
      expect(opened.events.slice(0, 2)).toMatchObject([
        {
          type: 'opened',
          actorId: second.id,
          fromStatus: 'scheduled',
          toStatus: 'open',
          payload: { source: 'approval' },
        },
        { type: 'approved', actorId: second.id, fromStatus: 'review', toStatus: 'scheduled' },
      ]);
      const openedEvent = opened.events.find((event) => event.type === 'opened');
      if (openedEvent === undefined) throw new Error('no opened event');
      const openAt = present(opened.openAt);
      expect(Date.parse(openAt)).toBe(Date.parse(openedEvent.createdAt));
      expect(Date.parse(openAt)).toBeGreaterThanOrEqual(Date.parse(scheduledOpenAt));
      // The open recorded the content it locked as rule v1 (#80, ADR-0101; #172 item 6): admin 2's,
      // at the open's instant, no request, no reason — and no market event of its own.
      expect(opened.ruleVersion).toBe(1);
      expect(opened.ruleVersions).toMatchObject([
        {
          version: 1,
          changedItems: [],
          reason: null,
          approvalId: null,
          requestedBy: null,
          createdBy: { id: second.id },
          settlementImpact: null,
          content: { title: market.title, yesCondition: market.yesCondition },
        },
      ]);
      expect(Date.parse(opened.ruleVersions[0]?.createdAt ?? '')).toBe(Date.parse(openAt));

      // --- on screen: 연 시각, and the event log's 열림 row with admin 2 as its actor. The 검수 기록
      // ends at the approval — the open is no review record — and nothing is left to decide.
      await expect(detailRow(secondPage, 'market-detail-open-at')).toHaveText(formatKst(openAt));
      const row = secondPage.getByTestId(`market-event-${openedEvent.id}`);
      await expect(row).toContainText(copy.eventOpened);
      await expect(row).toContainText(second.id);
      expect(await logTypes(secondPage)).toEqual(['approved', 'submitted']);
      await expect(secondPage.getByTestId('market-review-scheduled')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-review-actions')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-open')).toHaveCount(0);
    } finally {
      await sendBackToDraft(admin, market.id);
      await secondContext.close();
    }

    // --- a visitor: 거래 중 at its address, and no 개장 예정 notice.
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusOpen);
    await expect(page.getByTestId('market-status-notice')).toHaveCount(0);
  });

  test('예정 개장 시각 전에 승인된 시장은 개장 예정으로 기다리다 그 시각에 아무도 누르지 않아도 거래 중이 되어, 보던 방문자의 상세가 새로 고침 없이 바뀌고 이벤트 로그의 열림은 시스템이 했다고 보인다', async ({
    admin,
    browser,
    page,
  }) => {
    skipWithoutWorkerProbe();
    test.slow(); // the scheduled open is more than a real minute away
    // Admin 1 signs in before the clock starts: OPEN_IN_MS budgets the market's making, submission
    // and approval and the two pages' first loads, not a sign-in as well.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      const scheduledOpenAt = new Date(Date.now() + OPEN_IN_MS).toISOString();
      const market = await createDraftMarket(admin, { times: { scheduledOpenAt } });
      const submitted = await submitForReview(admin, market.id);
      // Approved before its scheduled open: 개장 예정, the worker's to open. (A box so slow that the
      // approval came after it would have opened it here, and the test would say so.)
      const approved = await approveAsReviewer(
        admin,
        market.id,
        submitted.review.pending?.requestId,
      );
      expect(approved.status).toBe('scheduled');

      // --- a visitor on its public detail (#173 item 12: 개장 예정 is public), in its room first.
      const joined = subscribed(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      await joined;
      const badge = page.getByTestId('market-status-badge');
      await expect(badge).toHaveText(copy.marketStatusScheduled);
      await expect(page.getByTestId('market-status-notice')).toContainText(
        copy.marketScheduledNotice,
      );
      await markDocument(page);

      // --- admin 1 on its detail: 개장 예정, the note that it opens by itself at its scheduled
      // open, no 연 시각 yet, and no 열기.
      await adminPage.goto(`/admin/markets/${market.id}`);
      const status = adminPage.getByTestId('market-detail-status');
      await expect(status).toHaveText(copy.marketStatusScheduled);
      await expect(adminPage.getByTestId('market-review-scheduled')).toHaveText(
        copy.adminMarketReviewScheduledNote,
      );
      await expect(detailRow(adminPage, 'market-detail-scheduled-open-at')).toHaveText(
        formatKst(scheduledOpenAt),
      );
      await expect(detailRow(adminPage, 'market-detail-open-at')).toHaveText('—');
      await expect(adminPage.getByTestId('market-open')).toHaveCount(0);
      await markDocument(adminPage);

      // --- nobody presses anything: at its scheduled open the worker opens it — the delayed job
      // the approval registered, or the per-minute scan behind it.
      await expect
        .poll(async () => (await adminMarketOf(admin, market.id)).status, {
          timeout: OPEN_WAIT_MS,
          intervals: [2_000],
        })
        .toBe('open');
      const opened = await adminMarketOf(admin, market.id);
      const openedEvent = opened.events.find((event) => event.type === 'opened');
      if (openedEvent === undefined) throw new Error('no opened event');
      // The worker's: no actor (ADR-0095), its source the job, at or after the scheduled open.
      expect(openedEvent).toMatchObject({
        actorId: null,
        fromStatus: 'scheduled',
        toStatus: 'open',
        payload: { source: 'job' },
      });
      const openAt = present(opened.openAt);
      expect(Date.parse(openAt)).toBeGreaterThanOrEqual(Date.parse(scheduledOpenAt));
      // Rule v1 by the worker (#80, ADR-0101): no admin made it, at the open's instant.
      expect(opened.ruleVersion).toBe(1);
      expect(opened.ruleVersions).toMatchObject([
        { version: 1, changedItems: [], requestedBy: null, createdBy: null },
      ]);
      expect(Date.parse(opened.ruleVersions[0]?.createdAt ?? '')).toBe(Date.parse(openAt));

      // --- the visitor's detail took the `market:status` the worker published: 거래 중 and no
      // 개장 예정 notice, without a reload.
      await expect(badge).toHaveText(copy.marketStatusOpen);
      await expect(page.getByTestId('market-status-notice')).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);

      // --- the admin detail, left open, read it again by itself (it re-reads a 개장 예정 market from
      // its scheduled open until it opens, `scheduledMarketPollDelay`): 거래 중, its 연 시각, and
      // the event log's 열림 row with 시스템 as its actor; the note is gone with 개장 예정.
      await expect(status).toHaveText(copy.marketStatusOpen, { timeout: ADMIN_POLL_WAIT_MS });
      expect(await documentSurvived(adminPage)).toBe(true);
      await expect(detailRow(adminPage, 'market-detail-open-at')).toHaveText(formatKst(openAt));
      const row = adminPage.getByTestId(`market-event-${openedEvent.id}`);
      await expect(row).toContainText(copy.eventOpened);
      await expect(row).toContainText(copy.eventSystem);
      await expect(adminPage.getByTestId('market-review-scheduled')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-open')).toHaveCount(0);
    } finally {
      await adminContext.close();
    }
  });

  test('열기는 어느 상태에도 없고 그 경로는 404이며, 초안은 검수 제출로만 초안을 벗어난다', async ({
    admin,
    page,
  }) => {
    const market = await createDraftMarket(admin);
    const path = `/api/v1/admin/markets/${market.id}`;
    try {
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      const status = page.getByTestId('market-detail-status');
      await expect(status).toHaveText(copy.marketStatusDraft);
      // --- the draft: 검수 제출 and no 열기 (`market-open-items`, the notice, is another id).
      await expect(page.getByTestId('market-review-submit')).toBeEnabled();
      await expect(page.getByTestId('market-open')).toHaveCount(0);

      // --- the interim open's route is gone: the router answers 404, and the draft is untouched.
      const gone = await admin.post(`${path}/open`, {
        data: { expectedAccountId: await accountIdOf(admin) },
      });
      const body = await gone.text();
      expect(gone.status(), body).toBe(404);
      expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      const after = await adminMarketOf(admin, market.id);
      expect(after.status).toBe('draft');
      expect(after.events.map((event) => event.type)).toEqual(['created']);

      // --- in review: still no 열기, and 검수 제출 has gone with the draft. (개장 예정 and 거래 중
      // are the tests above.)
      await page.getByTestId('market-review-submit').click();
      await expect(page.getByText(copy.adminMarketReviewSubmitted)).toBeVisible();
      await expect(status).toHaveText(copy.marketStatusReview);
      await expect(page.getByTestId('market-review-submit')).toHaveCount(0);
      await expect(page.getByTestId('market-open')).toHaveCount(0);
    } finally {
      await sendBackToDraft(admin, market.id);
    }
  });

  test('개장 예정인 채 거래 마감 시각이 지난 시장은 관리자 상세가 열리지 않는다고 경고하고, 관리자가 초안으로 되돌린다', async ({
    admin,
    browser,
  }) => {
    // Approved an hour before its scheduled open, its close an hour after that: 개장 예정.
    const scheduledOpenAt = minuteIso(Date.now() + HOUR_MS);
    const closeAt = minuteIso(Date.now() + 2 * HOUR_MS);
    const market = await createDraftMarket(admin, { closeAt, times: { scheduledOpenAt } });
    const submitted = await submitForReview(admin, market.id);
    expect(
      (await approveAsReviewer(admin, market.id, submitted.review.pending?.requestId)).status,
    ).toBe('scheduled');
    const first = await meOf(admin);
    const reason = `열리기 전에 거래 마감 시각이 지나 시각을 고칩니다 ${market.tag}`;

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      // --- the browser's clock a minute past the close: the detail as it reads once the close
      // has passed on a market the worker never opened.
      await adminPage.clock.setFixedTime(new Date(Date.parse(closeAt) + MINUTE_MS));
      await adminPage.goto(`/admin/markets/${market.id}`);
      const status = adminPage.getByTestId('market-detail-status');
      await expect(status).toHaveText(copy.marketStatusScheduled);
      // The warning, yellow as every 주의 안내, in place of the note that it opens by itself.
      const warning = adminPage.getByTestId('market-review-close-passed');
      await expect(warning).toHaveText(copy.adminMarketReviewCloseLapsed);
      await expectYellowWarning(warning);
      await expect(adminPage.getByTestId('market-review-scheduled')).toHaveCount(0);
      await expect(detailRow(adminPage, 'market-detail-open-at')).toHaveText('—');

      // --- the way on is the one it names: 초안으로 되돌리기, with a reason (#172 item 6).
      await expect(adminPage.getByTestId('market-review-revert')).toBeEnabled();
      await adminPage.getByTestId('market-review-revert').click();
      const dialog = adminPage.getByTestId('market-review-revert-dialog');
      await dialog.getByTestId('market-review-revert-reason').fill(reason);
      const reverted = nextWrite(adminPage, market.id, 'revert');
      await dialog.getByTestId('market-review-revert-dialog-confirm').click();
      expect((await reverted).postDataJSON()).toEqual({ reason, expectedAccountId: first.id });
      await expect(adminPage.getByText(copy.adminMarketReviewReverted)).toBeVisible();
      await expect(status).toHaveText(copy.marketStatusDraft);
      await expect(warning).toHaveCount(0);

      // A draft again, never opened.
      const draft = await adminMarketOf(admin, market.id);
      expect(draft.status).toBe('draft');
      expect(draft.openAt).toBeNull();
      expect(draft.events.map((event) => event.type)).not.toContain('opened');
    } finally {
      await sendBackToDraft(admin, market.id);
      await adminContext.close();
    }
  });
});
