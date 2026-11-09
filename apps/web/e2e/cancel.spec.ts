import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type { AdminMarket, Market, Order, PlaceOrderResult } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  NO_FILL_CANCEL_REASON,
  adminAccount,
  approveAsReviewer,
  createDraftMarket,
  createOpenMarket,
  expect,
  freshEmail,
  helperTraders,
  meOf,
  secondAdminAccount,
  sendJudgementRegistration,
  signIn,
  signUp,
  submitForReview,
  test,
  tradeOnce,
  workerProbeDisabled,
} from './helpers';

/**
 * 거래 없는 시장의 취소 (#20, ADR-0117; ADR-0107 결정 5 '#20·#120 거래가 전혀 없던과 자동 CANCELLED',
 * '#20 운영자의 취소 경로', '#20 CANCELLED 시장의 결과 유형', '#20 CANCELLED의 라벨·공개·필터',
 * '#20·#120·#177 7항'). Two paths, end to end:
 *
 * - the worker's close at `close_at`: a market where a member's 지정가 order rests and nothing
 *   fills reaches its close as 취소 — the result type empty, the member's order 만료 with its lock
 *   back, the system sentence its reason, the public detail '취소' with its notice, and no judgement
 *   to register — while its twin, where the helper's two members traded one pair, closes as 거래
 *   마감 (the judgement is the fills', not the orders'). A worker to wait on, as pause.spec.ts's
 *   close: skipped when its probe is off;
 * - the operator's: admin 1 asks on a 개장 예정 market's admin detail to cancel it, with a reason
 *   (the cancel's public one), and may not approve it — 승인·반려 off under a note, and the API
 *   refuses it — and admin 2 finds the request in 시장 취소 대기, under 검수 대기, follows it to
 *   the detail and approves it there: the market is 취소 at once, never opened;
 * - the request's other two ends, on screen: its requester's 철회 and another admin's 반려, after
 *   which the market is still 개장 예정 and takes a new request.
 *
 * The early close that finds no fill is pause.spec.ts's. Every refusal's details and order, the
 * records, the races with the intake and the open, the held markets of a ledger failure and the
 * production effect (the intake closed, every closing market cancelled) are the database's, the
 * API's and the worker's integration tests (packages/db market-cancel.test.ts,
 * market-close.test.ts, market-pause.test.ts, orders.test.ts,
 * admin-market-cancels.controller.test.ts, admin-market-pauses.controller.test.ts, worker
 * market-close.test.ts, market-cancelled.test.ts); the panel, the queue and what a refusal says
 * are unit-tested too (market-cancel-panel.test.tsx, admin-market-cancel-requests.test.tsx,
 * lib/market-cancel.test.ts). The queue is oldest first, and earlier runs may have left requests
 * waiting (`showInCancelRequests`). Every market is created per run, every request a test leaves
 * waiting is retracted and every browser context it opens is closed in its `finally`.
 */

/**
 * How far ahead the markets the worker closes have their close: room for their making and opening,
 * the member's order and the helper's trade, on a slow box too (the accounts sign up before it is
 * set).
 */
const CLOSE_IN_MS = 70_000;

/**
 * How long the test waits for the close: the close, and then a whole minute more for the
 * per-minute scan should the delayed job be lost.
 */
const CLOSE_WAIT_MS = 150_000;

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The ISO instant of the whole minute `ms` falls in (scheduled-open.spec.ts's). */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
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

/** The public market as a signed-out visitor reads it (`request` carries no cookie). */
async function publicMarketOf(request: APIRequestContext, id: string): Promise<Market> {
  return dataOf<Market>(await request.get(`/api/v1/markets/${id}`));
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the panel's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/**
 * Presses 더 보기 on the 시장 취소 대기 list until `row` shows (pause.spec.ts's
 * `showInPauseDecisions`): the list is oldest first, and earlier runs may have left requests
 * waiting.
 */
async function showInCancelRequests(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-cancel-requests-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-cancel-requests',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-cancel-requests-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
}

/** A 개장 예정 market: approved an hour before its scheduled open, its close two hours later. */
async function createScheduledMarket(admin: APIRequestContext) {
  const scheduledOpenAt = minuteIso(Date.now() + HOUR_MS);
  const closeAt = minuteIso(Date.now() + 3 * HOUR_MS);
  const market = await createDraftMarket(admin, { closeAt, times: { scheduledOpenAt } });
  const submitted = await submitForReview(admin, market.id);
  expect(
    (await approveAsReviewer(admin, market.id, submitted.review.pending?.requestId)).status,
  ).toBe('scheduled');
  return market;
}

/** The `POST /admin/markets/:id<suffix>` this page sends next. */
function nextWrite(page: Page, marketId: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}${suffix}`,
  );
}

test.describe('거래 없는 시장의 취소 (#20)', () => {
  test('사람이 낀 체결 없이 거래 마감 시각이 온 시장은 워커가 취소하고 남은 주문은 만료로 잠금을 돌려주며 결과는 비고, 한 쌍이 체결된 쌍둥이 시장은 거래 마감이다', async ({
    admin,
    page,
    request,
  }) => {
    test.skip(
      workerProbeDisabled(),
      'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
    );
    test.slow(); // the close is more than a real minute away
    // The accounts first: CLOSE_IN_MS budgets the markets, the order and the trade, not sign-ups.
    await signUp(page, freshEmail());
    const member = page.request;
    await helperTraders(admin);
    const closeAt = new Date(Date.now() + CLOSE_IN_MS).toISOString();
    const [quiet, traded] = await Promise.all([
      createOpenMarket(admin, { closeAt }),
      createOpenMarket(admin, { closeAt }),
    ]);

    // --- the member's GTC NO buy of one at 40 rests on the quiet market: an order, no fill.
    const resting = (
      await dataOf<PlaceOrderResult>(
        await member.post(`/api/v1/markets/${quiet.id}/orders`, {
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          data: {
            outcome: 'NO',
            side: 'buy',
            timeInForce: 'gtc',
            limitPriceCoin: 40,
            qty: 1,
            expectedAccountId: (await meOf(member)).id,
          },
        }),
      )
    ).order;
    expect(resting).toMatchObject({ status: 'open', filledQty: 0 });
    const lockedBefore = BigInt((await meOf(member)).balance.lockedCoin);
    expect(lockedBefore).toBeGreaterThanOrEqual(40n);
    // --- the twin: one pair between the helper's members.
    await tradeOnce(admin, traded.id);

    // --- nobody presses anything: at the close the worker closes both — the delayed job the
    // approval registered at the open, or the per-minute scan behind it.
    await expect
      .poll(
        async () =>
          Promise.all([
            adminMarketOf(admin, quiet.id).then((market) => market.status),
            adminMarketOf(admin, traded.id).then((market) => market.status),
          ]),
        { timeout: CLOSE_WAIT_MS, intervals: [2_000] },
      )
      .toEqual(['cancelled', 'closed']);

    // --- the quiet market: 취소 by the worker, the system sentence its reason, no result.
    const cancelled = await adminMarketOf(admin, quiet.id);
    expect(cancelled.resolvedResult).toBeNull();
    expect(cancelled.events[0]).toMatchObject({
      type: 'cancelled',
      actorId: null,
      fromStatus: 'open',
      toStatus: 'cancelled',
      payload: { source: 'job', reason: NO_FILL_CANCEL_REASON },
    });
    // The member's order ended 만료 in the same transaction, its whole lock back.
    const expired = await dataOf<Order>(await member.get(`/api/v1/me/orders/${resting.id}`));
    expect(expired).toMatchObject({ status: 'expired', filledQty: 0 });
    expect(expired.endedAt).not.toBeNull();
    expect(BigInt((await meOf(member)).balance.lockedCoin)).toBe(lockedBefore - 40n);
    // No judgement follows a cancelled market: its registration is refused by the status.
    expect(
      await refusalOf(await sendJudgementRegistration(admin, quiet.id), 400, 'VALIDATION_ERROR'),
    ).toEqual([{ path: ['status'], message: 'not closed' }]);
    // Public: 취소 with the result type empty, and the detail says so.
    const shown = await publicMarketOf(request, quiet.id);
    expect(shown.status).toBe('cancelled');
    expect(shown.resolvedResult).toBeNull();
    await page.goto(`/markets/${quiet.slug}`);
    await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusCancelled);
    await expect(page.getByTestId('market-status-notice')).toContainText(
      copy.marketCancelledNotice,
    );

    // --- the twin: one fill with a person on it, so 거래 마감, waiting for its judgement.
    const closed = await adminMarketOf(admin, traded.id);
    expect(closed.events[0]).toMatchObject({
      type: 'closed',
      actorId: null,
      toStatus: 'closed',
    });
    expect(closed.resolvedResult).toBeNull();
  });

  test('개장 예정 시장은 한 관리자가 사유와 함께 취소를 요청하고 그 관리자는 승인하지 못하며, 다른 관리자가 승인하면 열리지 않고 바로 취소된다', async ({
    admin,
    secondAdmin,
    browser,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createScheduledMarket(admin);
    const reason = `판정 출처가 운영을 멈춰 열지 않고 끝냅니다 ${market.tag}`;
    const approval = `출처가 멈춘 것을 확인했습니다 ${market.tag}`;

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    let requestId: string | undefined;
    try {
      // --- admin 1 asks on the detail, with the reason the public record will carry.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const panel = firstPage.getByTestId('market-cancel');
      await expect(panel).toHaveAttribute('data-status', 'scheduled');
      await firstPage.getByTestId('market-cancel-request').click();
      const dialog = firstPage.getByTestId('market-cancel-request-dialog');
      await expect(dialog).toContainText(copy.adminMarketCancelRequestBody);
      await expect(dialog).toContainText(copy.adminMarketCancelReasonHint);
      const confirm = dialog.getByTestId('market-cancel-request-dialog-confirm');
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-cancel-request-reason').fill(reason);
      const requested = nextWrite(firstPage, market.id, '/cancel-requests');
      await confirm.click();
      expect((await requested).postDataJSON()).toEqual({ reason, expectedAccountId: first.id });
      await expect(firstPage.getByText(copy.adminMarketCancelRequested)).toBeVisible();
      await expect(firstPage.getByTestId('market-cancel-pending-reason')).toHaveText(reason);
      // Its requester decides nothing: 승인·반려 off under the note, 철회 its own.
      await expect(firstPage.getByTestId('market-cancel-requester-note')).toHaveText(
        copy.adminMarketPauseExcludedRequester,
      );
      await expect(firstPage.getByTestId('market-cancel-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-cancel-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-cancel-retract')).toBeEnabled();
      requestId = (await adminMarketOf(admin, market.id)).cancel.pending?.requestId;
      if (requestId === undefined) throw new Error('no cancel request waits after the request');
      // … and the API refuses it as the panel does; nothing changed.
      expect(
        await refusalOf(
          await admin.post(
            `/api/v1/admin/markets/${market.id}/cancel-requests/${requestId}/approve`,
            {
              data: { reason: approval, expectedAccountId: first.id },
            },
          ),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'requester' }]);
      expect((await adminMarketOf(admin, market.id)).status).toBe('scheduled');

      // --- admin 2 finds it in 시장 취소 대기, under 검수 대기: the question to its detail, the
      // market 개장 예정, the request's reason, who asked.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto('/admin/markets/reviews');
      const row = secondPage.getByTestId(`admin-market-cancel-request-${requestId}`);
      await showInCancelRequests(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(row).toContainText(copy.marketStatusScheduled);
      await expect(
        secondPage.getByTestId(`admin-market-cancel-request-reason-${requestId}`),
      ).toHaveText(reason);
      await expect(
        secondPage.getByTestId(`admin-market-cancel-request-requested-by-${requestId}`),
      ).toHaveText(first.profile.nickname);
      await secondPage.getByTestId(`admin-market-cancel-request-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- and approves it there: 취소 at once.
      await letToastsGo(secondPage);
      await expect(secondPage.getByTestId('market-cancel-pending-reason')).toHaveText(reason);
      await secondPage.getByTestId('market-cancel-approve').click();
      const approveDialog = secondPage.getByTestId('market-cancel-approve-dialog');
      await expect(approveDialog).toContainText(copy.adminMarketCancelApproveBody);
      await approveDialog.getByTestId('market-cancel-approve-reason').fill(approval);
      const approved = nextWrite(secondPage, market.id, `/cancel-requests/${requestId}/approve`);
      await approveDialog.getByTestId('market-cancel-approve-dialog-confirm').click();
      expect((await approved).postDataJSON()).toEqual({
        reason: approval,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketCancelled)).toBeVisible();
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusCancelled,
      );
      await expect(secondPage.getByTestId('market-cancel-log-0')).toHaveAttribute(
        'data-status',
        'approved',
      );
      await expect(secondPage.getByTestId('market-cancel-request')).toHaveCount(0);
      // The 이벤트 로그: 취소 by the operator, with the request's reason.
      const cancelledEvent = (await adminMarketOf(admin, market.id)).events[0];
      const cancelledRow = secondPage.getByTestId(`market-event-${String(cancelledEvent?.id)}`);
      await expect(cancelledRow).toContainText(copy.eventCancelled);
      await expect(cancelledRow).toContainText(
        `${copy.eventCancelSource} ${copy.eventCancelSourceOperator}`,
      );
      await expect(cancelledRow).toContainText(reason);
    } finally {
      // A failure before the approval leaves the request waiting; once approved, nothing waits.
      if (requestId !== undefined) {
        await admin
          .post(`/api/v1/admin/markets/${market.id}/cancel-requests/${requestId}/retract`, {
            data: { expectedAccountId: first.id },
          })
          .catch(() => undefined);
      }
      await firstContext.close();
      await secondContext.close();
    }

    // --- the records: SCHEDULED → CANCELLED by admin 2, never opened, the result type empty.
    const cancelled = await adminMarketOf(admin, market.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', openAt: null, resolvedResult: null });
    expect(cancelled.events[0]).toMatchObject({
      type: 'cancelled',
      actorId: second.id,
      fromStatus: 'scheduled',
      toStatus: 'cancelled',
      payload: { source: 'operator', reason, requestedBy: first.id },
    });
    // Its public detail stays (ADR-0107 결정 5 '#20 CANCELLED의 라벨·공개·필터').
    const shown = await publicMarketOf(request, market.id);
    expect(shown.status).toBe('cancelled');
    expect(shown.resolvedResult).toBeNull();
  });

  test('기다리는 취소 요청은 요청한 관리자만 화면에서 철회하고 다른 관리자는 반려하며, 그 뒤에도 시장은 개장 예정이다', async ({
    admin,
    secondAdmin,
    browser,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createScheduledMarket(admin);
    /** Admin 1's cancel request, sent to the API: the waiting request's id. */
    const ask = async (reason: string): Promise<string> => {
      const asked = await dataOf<AdminMarket>(
        await admin.post(`/api/v1/admin/markets/${market.id}/cancel-requests`, {
          data: { reason, expectedAccountId: first.id },
        }),
      );
      const requestId = asked.cancel.pending?.requestId;
      if (requestId === undefined) throw new Error('no cancel request waits after the request');
      return requestId;
    };

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    let waiting: string | undefined;
    try {
      // --- 철회: admin 2 may not retract admin 1's request; admin 1 does, on screen.
      const retractedReason = `출처 확인 전에 낸 요청입니다 ${market.tag}`;
      const retractedId = await ask(retractedReason);
      waiting = retractedId;
      expect(
        await refusalOf(
          await secondAdmin.post(
            `/api/v1/admin/markets/${market.id}/cancel-requests/${retractedId}/retract`,
            { data: { expectedAccountId: second.id } },
          ),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'not_requester' }]);
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-cancel-retract').click();
      const retractDialog = firstPage.getByTestId('market-cancel-retract-dialog');
      await expect(retractDialog.getByTestId('market-cancel-retract-request')).toHaveText(
        `${copy.adminMarketCancelReason} ${retractedReason}`,
      );
      const retracted = nextWrite(firstPage, market.id, `/cancel-requests/${retractedId}/retract`);
      await retractDialog.getByTestId('market-cancel-retract-dialog-confirm').click();
      expect((await retracted).postDataJSON()).toEqual({ expectedAccountId: first.id });
      waiting = undefined;
      await expect(firstPage.getByText(copy.adminMarketPauseRetracted)).toBeVisible();
      await expect(firstPage.getByTestId('market-cancel-pending')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-cancel-request')).toBeEnabled();
      await expect(firstPage.getByTestId('market-cancel-log-0')).toHaveAttribute(
        'data-status',
        'retracted',
      );

      // --- 반려: admin 1 asks again, and admin 2 rejects it on its detail with a reason.
      const rejectedReason = `판정 출처가 멈췄습니다 ${market.tag}`;
      const rejection = `출처가 다시 열려 그대로 엽니다 ${market.tag}`;
      const rejectedId = await ask(rejectedReason);
      waiting = rejectedId;
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await letToastsGo(secondPage);
      await expect(secondPage.getByTestId('market-cancel-retract')).toHaveCount(0);
      await secondPage.getByTestId('market-cancel-reject').click();
      const rejectDialog = secondPage.getByTestId('market-cancel-reject-dialog');
      await expect(rejectDialog).toContainText(copy.adminMarketCancelRejectTitle);
      await expect(rejectDialog.getByTestId('market-cancel-reject-request')).toHaveText(
        `${copy.adminMarketCancelReason} ${rejectedReason}`,
      );
      const confirm = rejectDialog.getByTestId('market-cancel-reject-dialog-confirm');
      await expect(confirm).toBeDisabled();
      await rejectDialog.getByTestId('market-cancel-reject-reason').fill(rejection);
      const rejected = nextWrite(secondPage, market.id, `/cancel-requests/${rejectedId}/reject`);
      await confirm.click();
      expect((await rejected).postDataJSON()).toEqual({
        reason: rejection,
        expectedAccountId: second.id,
      });
      waiting = undefined;
      await expect(secondPage.getByText(copy.adminMarketPauseRejected)).toBeVisible();
      await expect(secondPage.getByTestId('market-cancel-pending')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-cancel-log-0')).toHaveAttribute(
        'data-status',
        'rejected',
      );
      await expect(secondPage.getByTestId('market-cancel-log-1')).toHaveAttribute(
        'data-status',
        'retracted',
      );
      // Nothing cancelled: still 개장 예정, and a new request may be made.
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusScheduled,
      );
      await expect(secondPage.getByTestId('market-cancel-request')).toBeEnabled();
    } finally {
      if (waiting !== undefined) {
        await admin
          .post(`/api/v1/admin/markets/${market.id}/cancel-requests/${waiting}/retract`, {
            data: { expectedAccountId: first.id },
          })
          .catch(() => undefined);
      }
      await firstContext.close();
      await secondContext.close();
    }

    const after = await adminMarketOf(admin, market.id);
    expect(after).toMatchObject({ status: 'scheduled', resolvedResult: null });
    expect(after.cancel).toMatchObject({
      pending: null,
      log: [{ status: 'rejected' }, { status: 'retracted' }],
    });
    expect(after.events.some((event) => event.type === 'cancelled')).toBe(false);
  });
});
