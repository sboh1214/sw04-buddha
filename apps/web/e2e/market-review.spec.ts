import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  AdminMarketReviewItem,
  Market,
  MarketReviewChecklistItem,
  MarketReviewEventType,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  accountIdOf,
  adminAccount,
  createDraftMarket,
  expect,
  kstLocalOf,
  meOf,
  REVIEW_CHECKLIST,
  secondAdminAccount,
  signIn,
  subscribed,
  test,
  type TestMarket,
} from './helpers';

/**
 * 개설 검수 (#78, ADR-0099; ADR-0093 decision 2 #172 items 4·5·6, decision 3 '#78 수정 기록의 사유'
 * and '#21 앞당긴 개장'): a complete draft is 검수 제출 on its admin detail, which locks its content
 * (검수 중 — the form and the API refuse an edit); the 검수 대기 list, right after 시장 in the admin
 * menu, holds it until another admin decides. Its creator, any admin who edited its content and
 * its submitter decide nothing — their 승인·반려 are off under a note, and the API refuses them
 * (APPROVAL_NOT_ALLOWED: 'creator', 'editor', 'requester', in that precedence). Another admin
 * approves with every checklist item confirmed and a reason (개장 예정, public), or rejects with a
 * reason from the list and a 설명 the creator reads in the 검수 기록 (초안). Any admin, the creator
 * too, sends a market in review or 개장 예정 back to a draft with a reason (되돌리기) — from 개장
 * 예정 it leaves the public screens: a visitor's open detail says so, its address is a 404. 개장
 * 예정's one change is its scheduled open, with a reason and no new review, still before the close.
 * A draft the open-items check finds incomplete cannot be submitted. 검수 제출 is the one way out of
 * a draft: there is no 열기 beside it since #21 (ADR-0100).
 *
 * Admin 1 (`admin`) makes every market here, so admin 2 (`secondAdmin`) is the one who may decide
 * it, as on any database with the two seed admins. The markets are opened publicly by their ASCII
 * slugs (helpers.ts `createDraftMarket`), and a market that reaches 개장 예정 here has its scheduled
 * open an hour ahead, so it stays 개장 예정 while a test looks: the worker opens it only at that
 * time, and an approval past it opens it at once (#21, scheduled-open.spec.ts). Nothing here
 * writes a release setting (docs/SETTINGS.md): no market has an announcement time, so the lead
 * close never depends on one.
 *
 * Every refusal's details, the records (market events, admin actions, approval requests), the lock
 * order and an approval racing a 되돌리기 are the API's integration tests
 * (admin-markets-review.controller.test.ts); the panel per status and viewer, the dialogs' gating
 * and what a refusal says are unit-tested (market-review-panel.test.tsx,
 * lib/market-review.test.ts).
 * The 검수 대기 list is oldest first, so a database every earlier run has added to may hold a
 * spec's market past its first page: the list is paged through until it shows (`showInQueue`).
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The checklist's items (#172 item 4) as the approval dialog names them; the record's type makes it
 * whole. Their order is helpers.ts's `REVIEW_CHECKLIST`, MARKET_REVIEW_CHECKLIST's.
 */
const CHECK_LABEL: Readonly<Record<MarketReviewChecklistItem, string>> = {
  knownResult: copy.reviewCheckKnownResult,
  ambiguity: copy.reviewCheckAmbiguity,
  duplicate: copy.reviewCheckDuplicate,
  requiredItems: copy.reviewCheckRequiredItems,
  timeOrder: copy.reviewCheckTimeOrder,
  leadClose: copy.reviewCheckLeadClose,
  independence: copy.reviewCheckIndependence,
};

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** A time the spec set, which the type allows to be null. */
function present(iso: string | null): string {
  if (iso === null) throw new Error('the market has no such time');
  return iso;
}

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** A refusal's `details`, once its status and code are the ones expected. */
async function refusalOf(response: APIResponse, status: number, code: string): Promise<unknown> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  const { error } = JSON.parse(body) as { error: { code: string; details: unknown } };
  expect(error.code).toBe(code);
  return error.details;
}

/** The admin market as `context` reads it. */
async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  return dataOf<AdminMarket>(await context.get(`/api/v1/admin/markets/${id}`));
}

/**
 * `POST /admin/markets/:id/<write>` as the admin `context` is signed in as (ADR-0092). A 승인 or
 * 반려 names the pending request it decides (`requestId`), read here unless the body names one.
 */
async function reviewWrite(
  context: APIRequestContext,
  id: string,
  write: 'submit' | 'approve' | 'reject' | 'revert' | 'reschedule',
  body: Record<string, unknown> = {},
): Promise<APIResponse> {
  const decides = write === 'approve' || write === 'reject';
  const requestId = decides
    ? ((await adminMarketOf(context, id)).review.pending?.requestId ?? NO_REQUEST)
    : undefined;
  return context.post(`/api/v1/admin/markets/${id}/${write}`, {
    data: { requestId, ...body, expectedAccountId: await accountIdOf(context) },
  });
}

/** A well-formed request id that names no request. */
const NO_REQUEST = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

/** An approval's body: every checklist item confirmed, and its reason. */
function approval(reason: string): Record<string, unknown> {
  return { checklist: REVIEW_CHECKLIST, reason };
}

/**
 * A complete draft of admin 1's whose scheduled open is an hour ahead (#21: the worker opens a 개장
 * 예정 market only at that time, so approved, it stays 개장 예정 here), submitted by admin 1.
 */
async function marketInReview(admin: APIRequestContext): Promise<TestMarket> {
  const market = await createDraftMarket(admin, {
    times: { scheduledOpenAt: minuteIso(Date.now() + HOUR_MS) },
  });
  expect((await dataOf<AdminMarket>(await reviewWrite(admin, market.id, 'submit'))).status).toBe(
    'review',
  );
  return market;
}

/** `marketInReview`, approved by admin 2 with every item and a reason: 개장 예정, public. */
async function scheduledMarket(
  admin: APIRequestContext,
  secondAdmin: APIRequestContext,
): Promise<TestMarket> {
  const market = await marketInReview(admin);
  const approved = await dataOf<AdminMarket>(
    await reviewWrite(secondAdmin, market.id, 'approve', approval('확인했습니다')),
  );
  expect(approved.status).toBe('scheduled');
  return market;
}

/**
 * Sends a market a test left in review back to a draft, so the 검수 대기 list of a persistent
 * database does not grow by the markets of failed runs: the submitter's own 되돌리기 retracts its
 * request. Best effort, for a `finally`.
 */
async function leaveNoReview(context: APIRequestContext, id: string): Promise<void> {
  const market = await adminMarketOf(context, id).catch(() => null);
  if (market?.status !== 'review') return;
  await reviewWrite(context, id, 'revert', { reason: '시험 정리' });
}

/** Every market id the 검수 대기 list holds, read through to its last page. */
async function pendingReviewIds(context: APIRequestContext): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await context.get(`/api/v1/admin/market-reviews?limit=100${after}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketReviewItem[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((item) => item.marketId));
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return ids;
}

/**
 * Presses 더 보기 on the 검수 대기 list until `row` shows (account-restrictions.spec.ts's
 * `showInRequests`): the list is oldest first, and earlier runs may have left markets in review.
 */
async function showInQueue(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-reviews-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-reviews',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-reviews-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
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

/** The 검수 기록's status row: '상태 초안 → 검수 중', as the badges name the statuses. */
function statusRow(from: string, to: string): string {
  return `${copy.reviewLogStatus} ${from} → ${to}`;
}

/**
 * The 검수 기록's entry `index` (0 the newest): its record's type, its name, who wrote it, and its
 * rows (`reviewLogRows`), each '<name> <value>'.
 */
async function expectLogEntry(
  page: Page,
  index: number,
  entry: { type: MarketReviewEventType; label: string; actor: string; rows: string[] },
): Promise<void> {
  const id = `market-review-log-${String(index)}`;
  await expect(page.getByTestId(id)).toHaveAttribute('data-type', entry.type);
  await expect(page.getByTestId(`${id}-type`)).toHaveText(entry.label);
  await expect(page.getByTestId(`${id}-actor`)).toHaveText(entry.actor);
  await expect(page.getByTestId(`${id}-rows`).locator(':scope > *')).toHaveText(entry.rows);
}

/** The 검수 기록's entries, newest first, by type. */
function logTypes(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('market-review-log')
    .locator('[data-type]')
    .evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-type')));
}

test.describe('개설 검수', () => {
  test('관리자가 완전한 초안을 상세에서 검수 제출하면 검수 중이 되어 내용이 잠기고 검수 기록에 남으며, 만든 관리자에게는 승인·반려가 꺼져 API도 거절하고, 다른 관리자가 검수 대기에서 찾아 체크리스트를 모두 확인하고 사유와 함께 승인하면 개장 예정이 되어 공개 상세에 보이고 검수 대기에서 빠진다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const firstName = first.profile.nickname;
    const secondName = second.profile.nickname;
    const market = await createDraftMarket(admin, {
      times: { scheduledOpenAt: minuteIso(Date.now() + HOUR_MS) },
    });
    const path = `/api/v1/admin/markets/${market.id}`;
    const reason = `체크리스트를 모두 확인했습니다 ${market.tag}`;

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1, the creator: the draft's 검수, before anything is submitted.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const status = firstPage.getByTestId('market-detail-status');
      const panel = firstPage.getByTestId('market-review');
      await expect(status).toHaveText(copy.marketStatusDraft);
      await expect(panel).toHaveAttribute('data-status', 'draft');
      await expect(firstPage.getByTestId('market-review-log-empty')).toHaveText(
        copy.adminMarketReviewLogEmpty,
      );
      // Who will not decide it once submitted: its creator, the admin on screen (#172 item 5).
      const excluded = firstPage.getByTestId('market-review-excluded');
      await expect(excluded.getByRole('listitem')).toHaveCount(1);
      const creatorRow = firstPage.getByTestId(`market-review-excluded-${first.id}`);
      await expect(creatorRow).toHaveAttribute('data-viewer', 'true');
      await expect(creatorRow).toHaveText(
        `${firstName} ${copy.adminMarketReviewViewer} · ${copy.adminMarketReviewRoleCreator}`,
      );
      await expect(firstPage.getByTestId('market-review-actions')).toHaveCount(0);
      // Nothing is missing: 검수 제출 is on, the one way out of a draft — no 열기 (#21).
      await expect(firstPage.getByTestId('market-open-items')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-review-submit')).toBeEnabled();
      await expect(firstPage.getByTestId('market-open')).toHaveCount(0);

      // --- 검수 제출: one press, naming the admin on screen (ADR-0092).
      const submitted = nextWrite(firstPage, market.id, 'submit');
      await firstPage.getByTestId('market-review-submit').click();
      expect((await submitted).postDataJSON()).toEqual({ expectedAccountId: first.id });
      await expect(firstPage.getByText(copy.adminMarketReviewSubmitted)).toBeVisible();
      await expect(status).toHaveText(copy.marketStatusReview);
      await expect(panel).toHaveAttribute('data-status', 'review');
      await expect(firstPage.getByTestId('market-review-submit')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-open')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-review-pending-by')).toHaveText(firstName);
      // And when (#78's acceptance criteria: the submitter and the time stay), as the API kept it.
      const pending = (await adminMarketOf(admin, market.id)).review.pending;
      expect(pending?.requestedBy.id).toBe(first.id);
      await expect(firstPage.getByTestId('market-review-pending-at')).toHaveText(
        formatKst(pending?.requestedAt ?? ''),
      );
      await expectLogEntry(firstPage, 0, {
        type: 'submitted',
        label: copy.eventSubmitted,
        actor: firstName,
        rows: [statusRow(copy.marketStatusDraft, copy.marketStatusReview)],
      });
      // The creator is the submitter too: one row, both places.
      await expect(creatorRow).toHaveText(
        `${firstName} ${copy.adminMarketReviewViewer} · ${copy.adminMarketReviewRoleCreator} · ` +
          copy.adminMarketReviewRoleRequester,
      );

      // --- the content is locked from the submission (#172 item 6 (a)): the form says why and
      // saves nothing; the API refuses an edit.
      await expect(firstPage.getByTestId('market-edit-locked')).toHaveText(
        copy.adminMarketEditLockedReview,
      );
      await expect(firstPage.getByTestId('market-title')).toBeDisabled();
      await expect(firstPage.getByTestId('market-save')).toBeDisabled();
      expect(
        await refusalOf(
          await admin.patch(path, {
            data: { title: `${market.title} 고침`, expectedAccountId: first.id },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['status'], message: 'market is review' }]);

      // --- the creator decides nothing (#172 item 5): 승인 and 반려 are off under the note, only
      // 되돌리기 is on, and the API refuses both decisions naming the creator — the first of the
      // three exclusions, though admin 1 submitted it too.
      const exclusion = firstPage.getByTestId('market-review-exclusion');
      await expect(exclusion).toHaveAttribute('data-exclusion', 'creator');
      await expect(exclusion).toHaveText(copy.adminMarketReviewExcludedCreator);
      await expect(firstPage.getByTestId('market-review-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-review-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-review-revert')).toBeEnabled();
      expect(
        await refusalOf(
          await reviewWrite(admin, market.id, 'approve', approval(reason)),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'creator' }]);
      expect(
        await refusalOf(
          await reviewWrite(admin, market.id, 'reject', {
            rejectReason: 'other',
            reason: '스스로 반려합니다',
          }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'creator' }]);

      // --- admin 2: 검수 대기, right after 시장 in the menu, lists it with who submitted it and
      // who made it.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto('/admin/markets');
      const nav = secondPage.getByTestId('admin-nav');
      const queueLink = nav.getByRole('link', { name: copy.adminMarketReviews, exact: true });
      await expect(queueLink).toBeVisible();
      expect((await nav.getByRole('link').allTextContents()).slice(0, 3)).toEqual([
        copy.adminMarkets,
        copy.adminMarketReviews,
        copy.adminThemes,
      ]);
      await queueLink.click();
      await expect(secondPage).toHaveURL(/\/admin\/markets\/reviews$/);
      await expect(secondPage.getByTestId('admin-market-reviews')).toBeVisible();
      const row = secondPage.getByTestId(`admin-market-review-${market.id}`);
      await showInQueue(secondPage, row);
      await expect(row).toContainText(market.title);
      await expect(
        secondPage.getByTestId(`admin-market-review-requested-by-${market.id}`),
      ).toHaveText(firstName);
      await expect(
        secondPage.getByTestId(`admin-market-review-created-by-${market.id}`),
      ).toHaveText(firstName);
      await secondPage.getByTestId(`admin-market-review-link-${market.id}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- its detail: no note for admin 2, and the markets with the same YES condition and event
      // deadline — none, the condition holding the market's own tag.
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusReview,
      );
      await expect(secondPage.getByTestId('market-review-exclusion')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-review-same-condition-empty')).toHaveText(
        copy.adminMarketReviewSameConditionEmpty,
      );
      await expect(
        secondPage.getByTestId('market-review-excluded').getByRole('listitem'),
      ).toHaveCount(1);
      await expect(
        secondPage.getByTestId(`market-review-excluded-${first.id}`),
      ).not.toHaveAttribute('data-viewer');

      // --- 승인: every item a checkbox with its name, in the checklist's order; the confirm waits
      // for all of them and a reason (#172 item 4). It names the submission it was opened on.
      const requested = await adminMarketOf(secondAdmin, market.id);
      await secondPage.getByTestId('market-review-approve').click();
      const dialog = secondPage.getByTestId('market-review-approve-dialog');
      await expect(dialog).toBeVisible();
      expect(
        await dialog
          .getByTestId('market-review-checklist')
          .locator('[data-testid^="market-review-check-"]')
          .evaluateAll((boxes) => boxes.map((box) => box.getAttribute('data-testid'))),
      ).toEqual(REVIEW_CHECKLIST.map((item) => `market-review-check-${item}`));
      const confirm = dialog.getByTestId('market-review-approve-dialog-confirm');
      await expect(confirm).toBeDisabled();
      for (const item of REVIEW_CHECKLIST.slice(0, -1)) {
        const box = dialog.getByTestId(`market-review-check-${item}`);
        await expect(box).toContainText(CHECK_LABEL[item]);
        await box.click();
        await expect(box).toHaveAttribute('data-state', 'checked');
      }
      await dialog.getByTestId('market-review-approve-reason').fill(reason);
      // One item short: still off.
      await expect(confirm).toBeDisabled();
      const last = dialog.getByTestId(`market-review-check-${REVIEW_CHECKLIST.at(-1) ?? ''}`);
      await last.click();
      await expect(last).toHaveAttribute('data-state', 'checked');
      await expect(confirm).toBeEnabled();
      const approved = nextWrite(secondPage, market.id, 'approve');
      await confirm.click();
      expect((await approved).postDataJSON()).toEqual({
        requestId: requested.review.pending?.requestId,
        checklist: REVIEW_CHECKLIST,
        reason,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketReviewApproved)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- 개장 예정: still locked, its one change and 되돌리기 offered; the 검수 기록 says who
      // approved it, the checklist and the reason.
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusScheduled,
      );
      await expect(secondPage.getByTestId('market-review-scheduled')).toHaveText(
        copy.adminMarketReviewScheduledNote,
      );
      await expect(secondPage.getByTestId('market-review-approve')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-review-reschedule')).toBeEnabled();
      await expect(secondPage.getByTestId('market-review-revert')).toBeEnabled();
      await expect(secondPage.getByTestId('market-review-excluded')).toHaveCount(0);
      await expectLogEntry(secondPage, 0, {
        type: 'approved',
        label: copy.eventApproved,
        actor: secondName,
        rows: [
          statusRow(copy.marketStatusReview, copy.marketStatusScheduled),
          `${copy.reviewLogChecklist} ${String(REVIEW_CHECKLIST.length)}/` +
            `${String(REVIEW_CHECKLIST.length)}${copy.reviewLogChecklistTail}`,
          `${copy.reviewLogReason} ${reason}`,
        ],
      });
      expect(await logTypes(secondPage)).toEqual(['approved', 'submitted']);

      // --- the 검수 대기 list no longer holds it, on screen or on any page of the API's.
      await secondPage.goto('/admin/markets/reviews');
      await expect(
        secondPage
          .getByTestId('admin-market-reviews-list')
          .or(secondPage.getByTestId('admin-market-reviews-empty')),
      ).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(await pendingReviewIds(secondAdmin)).not.toContain(market.id);
    } finally {
      await leaveNoReview(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }

    // --- a visitor: 개장 예정 is public (#173 item 12), by its address and in the API.
    expect((await dataOf<Market>(await request.get(`/api/v1/markets/${market.slug}`))).status).toBe(
      'scheduled',
    );
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusScheduled);
  });

  test('다른 관리자가 반려 사유를 고르고 설명을 적어 반려하면 초안으로 돌아가고, 만든 관리자는 검수 기록에서 그 사유와 설명을 읽고 다시 검수 제출할 수 있다', async ({
    admin,
    secondAdmin,
    browser,
    page,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const firstName = first.profile.nickname;
    const secondName = second.profile.nickname;
    const market = await marketInReview(admin);
    const description = `YES 조건의 확인 코드가 무엇인지 출처마다 다르게 읽힙니다 ${market.tag}`;

    const secondContext = await browser.newContext();
    try {
      // --- admin 2: 반려 waits for a reason from the list and a 설명, and names the submission.
      const requested = await adminMarketOf(admin, market.id);
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusReview,
      );
      // Admin 1 made and submitted it: one row, both places, not the viewer's.
      await expect(secondPage.getByTestId(`market-review-excluded-${first.id}`)).toHaveText(
        `${firstName} · ${copy.adminMarketReviewRoleCreator} · ` +
          copy.adminMarketReviewRoleRequester,
      );
      await expect(secondPage.getByTestId('market-review-reject')).toBeEnabled();
      await secondPage.getByTestId('market-review-reject').click();
      const dialog = secondPage.getByTestId('market-review-reject-dialog');
      const select = dialog.getByTestId('market-review-reject-reason');
      const confirm = dialog.getByTestId('market-review-reject-dialog-confirm');
      await expect(select).toHaveValue('');
      // The list is the checklist's names and 기타 (#172 item 4).
      await expect(select.locator('option:not([value=""])')).toHaveText([
        ...REVIEW_CHECKLIST.map((item) => CHECK_LABEL[item]),
        copy.reviewRejectOther,
      ]);
      await expect(confirm).toBeDisabled();
      await select.selectOption('ambiguity');
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-review-reject-description').fill(description);
      await expect(confirm).toBeEnabled();
      const rejected = nextWrite(secondPage, market.id, 'reject');
      await confirm.click();
      expect((await rejected).postDataJSON()).toEqual({
        requestId: requested.review.pending?.requestId,
        rejectReason: 'ambiguity',
        reason: description,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketReviewRejected)).toBeVisible();
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusDraft,
      );
    } finally {
      await leaveNoReview(admin, market.id);
      await secondContext.close();
    }

    // --- admin 1, the creator: the 검수 기록 says who rejected it, why and the 설명 — no
    // notification (#172 item 4) — and the draft can be fixed and submitted again.
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    await expect(page.getByTestId('market-detail-status')).toHaveText(copy.marketStatusDraft);
    await expectLogEntry(page, 0, {
      type: 'rejected',
      label: copy.eventRejected,
      actor: secondName,
      rows: [
        statusRow(copy.marketStatusReview, copy.marketStatusDraft),
        `${copy.reviewLogRejectReason} ${copy.reviewCheckAmbiguity}`,
        `${copy.reviewLogDescription} ${description}`,
      ],
    });
    await expectLogEntry(page, 1, {
      type: 'submitted',
      label: copy.eventSubmitted,
      actor: firstName,
      rows: [statusRow(copy.marketStatusDraft, copy.marketStatusReview)],
    });
    await expect(page.getByTestId('market-edit-locked')).toHaveCount(0);
    await expect(page.getByTestId('market-title')).toBeEnabled();
    await expect(page.getByTestId('market-review-submit')).toBeEnabled();
  });

  test('승인 창을 연 뒤 시장이 초안으로 되돌려져 다시 제출되면 그 창의 승인은 거절되고, 창은 검수 제출이 바뀌었다고 말하며 확인이 꺼진다', async ({
    admin,
    secondAdmin,
    browser,
  }) => {
    // Codex review of #78: a confirmation given to one submission's content decides no other.
    const market = await marketInReview(admin);
    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await secondPage.getByTestId('market-review-approve').click();
      const dialog = secondPage.getByTestId('market-review-approve-dialog');
      for (const item of REVIEW_CHECKLIST) {
        await dialog.getByTestId(`market-review-check-${item}`).click();
      }
      await dialog.getByTestId('market-review-approve-reason').fill(`확인했습니다 ${market.tag}`);
      const confirm = dialog.getByTestId('market-review-approve-dialog-confirm');
      await expect(confirm).toBeEnabled();

      // --- meanwhile admin 1, its submitter, sends it back (retracting the request) and submits it
      // again: a new request on content admin 2 has not seen.
      const sentBack = await reviewWrite(admin, market.id, 'revert', { reason: '고칩니다' });
      expect(sentBack.status(), await sentBack.text()).toBe(200);
      const resubmitted = await reviewWrite(admin, market.id, 'submit');
      expect(resubmitted.status(), await resubmitted.text()).toBe(200);

      // --- admin 2's confirmation names the old request: refused, nothing decided.
      await confirm.click();
      await expect(dialog.getByTestId('market-review-approve-dialog-refusal')).toHaveText(
        copy.errApprovalRetracted,
      );
      await expect(confirm).toBeDisabled();
      const after = await adminMarketOf(secondAdmin, market.id);
      expect(after.status).toBe('review');
      expect(after.review.pending).not.toBeNull();
    } finally {
      await secondContext.close();
    }
  });

  test('개장 예정 시장을 만든 관리자가 사유와 함께 초안으로 되돌리면 공개에서 내려가, 열어 둔 방문자의 상세는 초안이라 부르지 않고 지금 공개되어 있지 않다고 말하며 그 주소는 404가 되고, 그 시장에 쓴 글은 남되 시장 칸은 공개되지 않은 시장이라고만 보인다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    const first = await meOf(admin);
    const market = await scheduledMarket(admin, secondAdmin);
    const reason = `예정 판정 시각을 고쳐 다시 검수받습니다 ${market.tag}`;
    // A post on it while it is public (개장 예정 takes posts, ADR-0093 decision 3), by admin 2.
    const written = await secondAdmin.post('/api/v1/posts', {
      data: {
        marketId: market.id,
        title: `되돌릴 시장의 글 ${market.tag}`,
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '개장 전에 쓴 글' }] }],
        },
        expectedAccountId: (await meOf(secondAdmin)).id,
      },
    });
    expect(written.status(), await written.text()).toBe(201);
    const postId = ((await written.json()) as { data: { id: string } }).data.id;

    // --- a visitor on the public detail, in the market's room before anything moves.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusScheduled);

    const firstContext = await browser.newContext();
    try {
      // --- admin 1, who made it: 되돌리기 is anyone's (#172 item 6), with a reason.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const status = firstPage.getByTestId('market-detail-status');
      await expect(status).toHaveText(copy.marketStatusScheduled);
      await firstPage.getByTestId('market-review-revert').click();
      const dialog = firstPage.getByTestId('market-review-revert-dialog');
      await expect(dialog).toContainText(copy.adminMarketReviewRevertScheduledBody);
      const confirm = dialog.getByTestId('market-review-revert-dialog-confirm');
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-review-revert-reason').fill(reason);
      await expect(confirm).toBeEnabled();
      const reverted = nextWrite(firstPage, market.id, 'revert');
      await confirm.click();
      expect((await reverted).postDataJSON()).toEqual({ reason, expectedAccountId: first.id });
      await expect(firstPage.getByText(copy.adminMarketReviewReverted)).toBeVisible();
      await expect(status).toHaveText(copy.marketStatusDraft);
      await expectLogEntry(firstPage, 0, {
        type: 'reverted',
        label: copy.eventReverted,
        actor: first.profile.nickname,
        rows: [
          statusRow(copy.marketStatusScheduled, copy.marketStatusDraft),
          `${copy.reviewLogReason} ${reason}`,
        ],
      });
      expect(await logTypes(firstPage)).toEqual(['reverted', 'approved', 'submitted']);
      // A draft again: editable, and 검수 제출 is back.
      await expect(firstPage.getByTestId('market-title')).toBeEnabled();
      await expect(firstPage.getByTestId('market-review-submit')).toBeEnabled();
    } finally {
      await firstContext.close();
    }

    // --- the visitor: the `market:status` the 되돌리기 published is not drawn — 초안 is an admin's
    // word — and the refetch it set off finds the market gone, which the detail says.
    await expect(page.getByTestId('market-detail-refresh-failed')).toHaveText(
      copy.marketNoLongerPublic,
    );
    await expect(badge).toHaveText(copy.marketStatusScheduled);
    // Its address is a 404 now, for the page and the API.
    expect((await request.get(`/api/v1/markets/${market.slug}`)).status()).toBe(404);
    expect((await page.reload())?.status()).toBe(404);

    // --- the post stays, its market named by nothing of the draft until it is public again
    // (ADR-0099, owner answer 2026-11-01): '공개되지 않은 시장', no title, badge or link.
    const post = (await (await request.get(`/api/v1/posts/${postId}`)).json()) as {
      data: { market: unknown };
    };
    expect(post.data.market).toBeNull();
    await page.goto(`/community?q=${market.tag}`);
    const card = page.getByTestId(`post-card-${postId}`);
    await expect(card.getByTestId('post-card-market-hidden')).toHaveText(copy.postMarketNotPublic);
    await expect(card.getByTestId('post-card-market')).toHaveCount(0);
    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-market-hidden')).toHaveText(copy.postMarketNotPublic);
    await expect(page.getByTestId('post-market-link')).toHaveCount(0);
  });

  test('개장 예정 시장의 예정 개장 시각은 새 검수 없이 사유와 함께 바꾸고, 거래 마감 시각과 같거나 늦은 시각은 입력 아래에서 거절되며 API도 거절하고, 바꾼 이전·이후 시각과 사유가 검수 기록에 남는다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    const first = await meOf(admin);
    const market = await scheduledMarket(admin, secondAdmin);
    const before = present(market.times.scheduledOpenAt);
    const reason = `발표 일정이 당겨져 일찍 엽니다 ${market.tag}`;
    const path = `/api/v1/admin/markets/${market.id}`;

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    const status = page.getByTestId('market-detail-status');
    await expect(status).toHaveText(copy.marketStatusScheduled);
    // Locked but for this one change (#172 item 6): the form says why; the API refuses an edit.
    await expect(page.getByTestId('market-edit-locked')).toHaveText(
      copy.adminMarketEditLockedReview,
    );
    expect(
      await refusalOf(
        await admin.patch(path, {
          data: { scheduledOpenAt: minuteIso(Date.now()), expectedAccountId: first.id },
        }),
        400,
        'VALIDATION_ERROR',
      ),
    ).toEqual([{ path: ['status'], message: 'market is scheduled' }]);

    // --- the dialog opens on the stored time, beside the close; the confirm waits for a change.
    await page.getByTestId('market-review-reschedule').click();
    const dialog = page.getByTestId('market-review-reschedule-dialog');
    await expect(dialog.getByTestId('market-review-reschedule-current')).toHaveText(
      `${copy.adminMarketScheduledOpenAt} ${formatKst(before)} · ${copy.adminMarketCloseAt} ` +
        formatKst(market.closeAt),
    );
    const at = dialog.getByTestId('market-review-reschedule-at');
    const atError = dialog.getByTestId('market-review-reschedule-at-error');
    const confirm = dialog.getByTestId('market-review-reschedule-dialog-confirm');
    await expect(at).toHaveValue(kstLocalOf(before));
    await dialog.getByTestId('market-review-reschedule-reason').fill(reason);
    await expect(confirm).toBeDisabled();

    // --- at the close's minute, or after it: the order rule (#172 item 12, whole minutes) under
    // the field, and nothing to send.
    for (const refused of [
      market.closeAt,
      new Date(Date.parse(market.closeAt) + HOUR_MS).toISOString(),
    ]) {
      await at.fill(kstLocalOf(refused));
      await expect(at).toHaveAccessibleErrorMessage(copy.errMarketTimeOpenBeforeClose);
      await expect(atError).toHaveText(copy.errMarketTimeOpenBeforeClose);
      await expect(confirm).toBeDisabled();
    }
    // The API refuses it naming both ends, as the PATCH does; and the stored time again.
    expect(
      await refusalOf(
        await reviewWrite(admin, market.id, 'reschedule', {
          scheduledOpenAt: minuteIso(Date.parse(market.closeAt)),
          reason,
        }),
        400,
        'VALIDATION_ERROR',
      ),
    ).toEqual([
      { path: ['scheduledOpenAt'], message: 'must be before closeAt' },
      { path: ['closeAt'], message: 'must be after scheduledOpenAt' },
    ]);
    expect(
      await refusalOf(
        await reviewWrite(admin, market.id, 'reschedule', { scheduledOpenAt: before, reason }),
        400,
        'VALIDATION_ERROR',
      ),
    ).toEqual([{ path: ['scheduledOpenAt'], message: 'unchanged' }]);

    // --- an ordered time: sent with the reason, as the admin on screen, and the market stays
    // 개장 예정 with the new time.
    const after = minuteIso(Date.now() + 2 * HOUR_MS);
    await at.fill(kstLocalOf(after));
    await expect(at).not.toHaveAttribute('aria-invalid', 'true');
    await expect(atError).toHaveCount(0);
    await expect(confirm).toBeEnabled();
    const rescheduled = nextWrite(page, market.id, 'reschedule');
    await confirm.click();
    expect((await rescheduled).postDataJSON()).toEqual({
      scheduledOpenAt: after,
      reason,
      expectedAccountId: first.id,
    });
    await expect(page.getByText(copy.adminMarketReviewRescheduled)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(status).toHaveText(copy.marketStatusScheduled);
    await expect(detailRow(page, 'market-detail-scheduled-open-at')).toHaveText(formatKst(after));
    // No status change: the entry's rows are the two times and the reason.
    await expectLogEntry(page, 0, {
      type: 'open_rescheduled',
      label: copy.eventOpenRescheduled,
      actor: first.profile.nickname,
      rows: [
        `${copy.reviewLogOpenBefore} ${formatKst(before)}`,
        `${copy.reviewLogOpenAfter} ${formatKst(after)}`,
        `${copy.reviewLogReason} ${reason}`,
      ],
    });
    expect(Date.parse(present((await adminMarketOf(admin, market.id)).scheduledOpenAt))).toBe(
      Date.parse(after),
    );
  });

  test('초안의 내용을 수정한 적이 있는 관리자와 검수를 제출한 관리자는 승인·반려할 수 없고 API가 editor·requester로 거절하며, 수정한 관리자는 되돌린 뒤의 다음 검수에서도 결정하지 못한다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const edited = await createDraftMarket(admin);
    const submittedBySecond = await createDraftMarket(admin);
    try {
      // --- admin 2 edits admin 1's draft: an editor of it from now on (#172 item 5).
      const afterEdit = await dataOf<AdminMarket>(
        await secondAdmin.patch(`/api/v1/admin/markets/${edited.id}`, {
          data: { title: `${edited.title} 다듬음`, expectedAccountId: second.id },
        }),
      );
      expect(afterEdit.review.editors.map((editor) => editor.id)).toEqual([second.id]);
      expect(
        (await dataOf<AdminMarket>(await reviewWrite(admin, edited.id, 'submit'))).status,
      ).toBe('review');
      for (const [write, body] of [
        ['approve', approval('확인했습니다')],
        ['reject', { rejectReason: 'other', reason: '다시 봅니다' }],
      ] as const) {
        expect(
          await refusalOf(
            await reviewWrite(secondAdmin, edited.id, write, body),
            409,
            'APPROVAL_NOT_ALLOWED',
          ),
        ).toEqual([{ path: ['request'], message: 'editor' }]);
      }

      // --- on admin 2's screen: the editor's note, the buttons off, '(나)' in the list.
      await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
      await page.goto(`/admin/markets/${edited.id}`);
      const exclusion = page.getByTestId('market-review-exclusion');
      await expect(exclusion).toHaveAttribute('data-exclusion', 'editor');
      await expect(exclusion).toHaveText(copy.adminMarketReviewExcludedEditor);
      await expect(page.getByTestId('market-review-approve')).toBeDisabled();
      await expect(page.getByTestId('market-review-reject')).toBeDisabled();
      await expect(page.getByTestId(`market-review-excluded-${second.id}`)).toHaveText(
        `${second.profile.nickname} ${copy.adminMarketReviewViewer} · ` +
          copy.adminMarketReviewRoleEditor,
      );

      // --- admin 1, the submitter, sends it back (its request is retracted) and submits it again:
      // an edit counts in every review cycle.
      const back = await dataOf<AdminMarket>(
        await reviewWrite(admin, edited.id, 'revert', { reason: '제목을 다시 봅니다' }),
      );
      expect(back.status).toBe('draft');
      expect(back.review.log[0]).toMatchObject({
        type: 'reverted',
        actor: { id: first.id },
        fromStatus: 'review',
        toStatus: 'draft',
      });
      expect(
        (await dataOf<AdminMarket>(await reviewWrite(admin, edited.id, 'submit'))).status,
      ).toBe('review');
      expect(
        await refusalOf(
          await reviewWrite(secondAdmin, edited.id, 'approve', approval('확인했습니다')),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'editor' }]);

      // --- admin 2 submits admin 1's draft, which it never edited: the submitter is refused as
      // such, and admin 1 as the creator — the first exclusion that applies.
      expect(
        (await dataOf<AdminMarket>(await reviewWrite(secondAdmin, submittedBySecond.id, 'submit')))
          .review.pending?.requestedBy.id,
      ).toBe(second.id);
      expect(
        await refusalOf(
          await reviewWrite(secondAdmin, submittedBySecond.id, 'approve', approval('확인했습니다')),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'requester' }]);
      expect(
        await refusalOf(
          await reviewWrite(admin, submittedBySecond.id, 'approve', approval('확인했습니다')),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'creator' }]);
    } finally {
      await leaveNoReview(admin, edited.id);
      await leaveNoReview(secondAdmin, submittedBySecond.id);
    }
  });

  test('개설 항목이 빠진 초안은 검수 제출이 꺼져 빠진 항목이 보이고 API도 OPEN_ITEMS_MISSING으로 거절하며, 채워 저장하면 켜진다', async ({
    admin,
    page,
  }) => {
    // A draft without tags (#17: 1..5 to open or submit), complete otherwise.
    const market = await createDraftMarket(admin, { tags: [] });
    expect(
      await refusalOf(await reviewWrite(admin, market.id, 'submit'), 422, 'OPEN_ITEMS_MISSING'),
    ).toEqual([{ path: ['tags'], message: 'required' }]);

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    await expect(page.getByTestId('market-detail-status')).toHaveText(copy.marketStatusDraft);
    const notice = page.getByTestId('market-open-items');
    await expect(notice).toHaveText(`${copy.adminMarketOpenItems}: ${copy.openItemTags}`);
    const submit = page.getByTestId('market-review-submit');
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId('market-review-log-empty')).toBeVisible();

    // --- a tag, saved: nothing missing, and 검수 제출 is on.
    await page.getByTestId('market-tags-input').fill(market.tag);
    await page.getByTestId('market-tags-input').press('Enter');
    await page.getByTestId('market-save').click();
    await expect(page.getByText(copy.adminMarketSaved)).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(submit).toBeEnabled();
    expect((await adminMarketOf(admin, market.id)).missingOpenItems).toEqual([]);
  });
});
