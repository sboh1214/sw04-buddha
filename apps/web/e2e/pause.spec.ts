import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type { AdminMarket, AdminMarketPauseDecisionItem, Market } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  accountIdOf,
  adminAccount,
  approvePauseDecisionAsReviewer,
  createOpenMarket,
  documentSurvived,
  expect,
  freshTag,
  helperTraders,
  kstLocalOf,
  leaveNoPauseDecision,
  leaveNoSupplement,
  markDocument,
  meOf,
  NO_FILL_CANCEL_REASON,
  pauseMarket,
  requestPauseDecision,
  requestSupplement,
  secondAdminAccount,
  sendPause,
  sendPauseDecision,
  sendPauseDecisionRequest,
  sendSupplementDecision,
  signIn,
  subscribed,
  test,
  tradeOnce,
  workerProbeDisabled,
} from './helpers';

/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4·13, decision 2
 * #172 items 14·15, decision 3 '#114 조기 결과의 공개 시각', the owner's answers Q1·Q2 of
 * 2026-11-02): an admin pauses an OPEN market on its admin detail, alone and at once, with one of
 * three reasons and a note — for an early result also when the result was published, typed in KST
 * — and a visitor's open detail reads 거래 일시 중단 without a reload. What comes next is asked for
 * by one admin and approved by another: 재개 (back to 거래 중) or 조기 마감 (to 거래 마감, never
 * reopened); its requester may not decide it — 승인·반려 are off under a note, and the API refuses
 * them — and alone may retract it. The request waits in 일시 중단 결정 대기, under 검수 대기. A
 * 실질 기준 변경 pause is asked for with its review result: 판정 불가 leaves 조기 마감 alone, its
 * VOID being the judgement's after the close (#152, judgement.spec.ts — the market is judged 무효
 * alone). A request names the pause it was asked on, and one naming a pause since resumed is
 * refused (`stale`). The close still comes on schedule while PAUSED: the worker closes the market
 * and ends its pause as 예정 마감, and a request still waiting is then ended by a 반려 or a 철회
 * alone. An early close of a market with no fill of a person's account ends it 취소 instead — the
 * result type empty, no judgement (#20, ADR-0117): the tests that close one trade a pair between
 * the helper's members first (helpers.ts `tradeOnce`), and one shows the cancel. A paused market's
 * category and tags are edited as an open one's, its rule version items
 * by a supplement alone. There is no one-admin 마감 any more: its button is gone and its route
 * answers 404. A supplement rejected as 의미 변경 leaves the market open, and the admin detail
 * offers the pause it calls for, filled in.
 *
 * Admin 1 (`admin`) makes, pauses and asks for every next path here, so admin 2 — `secondAdmin`,
 * or the reviewer `admin` is paired with (helpers.ts `approvePauseDecisionAsReviewer`) — is the
 * one who decides it, as on any database with the two seed admins. The test that waits for the
 * worker's close skips when its probe is off (`WORKER_HEALTH_PORT=0`), as scheduled-open.spec.ts's
 * does.
 *
 * Every refusal's details and order, the records (the `market_pauses` rows, the `paused`,
 * `resumed` and `closed` events, the admin actions), the database's guard of a pause, the close
 * job an early close cancels, two writes at once and the public answers' private fields are the
 * API's, the database's and the worker's integration tests (admin-market-pauses.controller.test.ts,
 * private-data.test.ts, packages/db market-pause.test.ts and schema.test.ts, worker
 * market-close.test.ts); the panel, its dialogs, the queue and what a refusal says are unit-tested
 * (market-pause-panel.test.tsx, admin-market-pause-decisions.test.tsx, lib/market-pause.test.ts).
 * The 일시 중단 결정 대기 list is oldest first, so a database every earlier run has added to may hold
 * a spec's request past its first page: the list is paged through until it shows
 * (`showInPauseDecisions`), and every test retracts what it left waiting.
 */

const MINUTE_MS = 60 * 1_000;

/**
 * How far ahead the market the worker closes has its close: room for its making and opening, its
 * pause and its request, and admin 2's first load, to land before it, on a slow box too (admin 2
 * signs in before it is set).
 */
const CLOSE_IN_MS = 70_000;

/**
 * How long that test waits for the close: the close, and then a whole minute more for the
 * per-minute scan should the delayed job be lost.
 */
const CLOSE_WAIT_MS = 150_000;

/**
 * How long the admin detail left open may take to show the close once the API answers `closed`:
 * one 5 s re-read past the close (`tradingMarketPollDelay`), with room for the read itself.
 */
const ADMIN_POLL_WAIT_MS = 15_000;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
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
 * The id of the pause lasting on a market — what its admin detail's request dialog names
 * (`pauseId`). Throws when none lasts.
 */
function lastingPauseOf(market: AdminMarket): string {
  const pause = market.pause.history.find((entry) => entry.endedAt === null);
  if (pause === undefined) throw new Error(`no pause lasts on market ${market.id}`);
  return pause.id;
}

/** The id of the next path waiting on a market. Throws when none waits. */
function pendingOf(market: AdminMarket): string {
  const requestId = market.pause.pending?.requestId;
  if (requestId === undefined) throw new Error(`no next path waits on market ${market.id}`);
  return requestId;
}

/** Every request id the 일시 중단 결정 대기 list holds, read through to its last page. */
async function waitingPauseDecisionIds(context: APIRequestContext): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await context.get(`/api/v1/admin/market-pause-decisions?limit=100${after}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketPauseDecisionItem[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((item) => item.requestId));
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return ids;
}

/**
 * Presses 더 보기 on the 일시 중단 결정 대기 list until `row` shows (rule-versions.spec.ts's
 * `showInSupplements`): the list is oldest first, and earlier runs may have left requests waiting.
 */
async function showInPauseDecisions(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-pause-decisions-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-pause-decisions',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-pause-decisions-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the panel's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The `POST /admin/markets/:id<suffix>` this page sends next: `/pause`, `/pause-decisions…`. */
function nextWrite(page: Page, marketId: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}${suffix}`,
  );
}

/** Skips the test before it makes a market when the config has no worker probe to wait on. */
function skipWithoutWorkerProbe(): void {
  test.skip(
    workerProbeDisabled(),
    'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
  );
}

test.describe('거래 일시 중단', () => {
  test('관리자 한 명이 화면에서 조기 결과를 사유로 공개 시각과 함께 거래를 일시 중단하면 방문자의 상세가 리프레시 없이 거래 일시 중단이 되고, 한 관리자가 재개를 요청하면 그 관리자는 승인하지 못하며, 다른 관리자가 일시 중단 결정 대기에서 찾아 승인하면 다시 거래 중이 된다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const firstName = first.profile.nickname;
    const secondName = second.profile.nickname;
    const market = await createOpenMarket(admin);
    const note = `발표 기관이 거래 마감 전에 결과를 공개했습니다 ${market.tag}`;
    // Published five minutes ago, to the minute: what the KST `datetime-local` holds.
    const publishedAt = minuteIso(Date.now() - 5 * MINUTE_MS);
    const requestReason = `공개된 결과를 확인했고 거래를 이어 가도 됩니다 ${market.tag}`;
    const approval = `재개 요청의 근거를 확인했습니다 ${market.tag}`;

    // --- the visitor, signed out, in the market's room first: 거래 중.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusOpen);
    await markDocument(page);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1's detail: the 거래 일시 중단 panel of an open market, no pause yet, and no
      // one-admin 마감 (#114: an early end is a pause and another admin's approved 조기 마감).
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const panel = firstPage.getByTestId('market-pause');
      await expect(panel).toHaveAttribute('data-status', 'open');
      await expect(firstPage.getByTestId('market-pause-history-empty')).toHaveText(
        copy.adminMarketPauseHistoryEmpty,
      );
      await expect(firstPage.getByTestId('market-close')).toHaveCount(0);

      // --- 거래 일시 중단: the three reasons, each with its line (실질 기준 변경's names a schedule
      // moved earlier, Q2); the confirm waits for a reason and a note, and an early result asks
      // for its publication instant too.
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-pause-start').click();
      const dialog = firstPage.getByTestId('market-pause-dialog');
      const confirm = dialog.getByTestId('market-pause-dialog-confirm');
      await expect(dialog).toContainText(copy.adminMarketPauseBody);
      for (const [reason, label] of [
        ['early_result', copy.pauseReasonEarlyResult],
        ['ledger_failure', copy.pauseReasonLedgerFailure],
        ['basis_change', copy.pauseReasonBasisChange],
      ] as const) {
        await expect(dialog.getByTestId(`market-pause-reason-${reason}`)).toContainText(label);
      }
      await expect(dialog.getByTestId('market-pause-reason-basis_change')).toContainText(
        copy.pauseReasonBasisChangeHint,
      );
      await expect(dialog.getByTestId('market-pause-published-at')).toHaveCount(0);
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-pause-reason-early_result').click();
      await expect(dialog.getByTestId('market-pause-reason-early_result')).toHaveAttribute(
        'data-state',
        'checked',
      );
      await dialog.getByTestId('market-pause-note').fill(note);
      const published = dialog.getByTestId('market-pause-published-at');
      await expect(published).toBeVisible();
      await expect(confirm).toBeDisabled();
      // An instant after now is said under the field at once, and nothing can be sent.
      await published.fill(kstLocalOf(new Date(Date.now() + 60 * MINUTE_MS).toISOString()));
      await expect(dialog.getByTestId('market-pause-published-at-error')).toHaveText(
        copy.errMarketPausePublishedAtAfter,
      );
      await expect(confirm).toBeDisabled();
      await published.fill(kstLocalOf(publishedAt));
      await expect(dialog.getByTestId('market-pause-published-at-error')).toHaveCount(0);
      await expect(confirm).toBeEnabled();
      const paused = nextWrite(firstPage, market.id, '/pause');
      await confirm.click();
      // Sent in UTC (ADR-0093 decision 3), naming admin 1.
      expect((await paused).postDataJSON()).toEqual({
        reason: 'early_result',
        note,
        resultPublishedAt: publishedAt,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketPaused)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- paused at once: the current pause — its reason, note, admin and publication instant —
      // and 재개·조기 마감 요청 where 거래 일시 중단 was.
      await expect(panel).toHaveAttribute('data-status', 'paused');
      await expect(firstPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusPaused,
      );
      await expect(firstPage.getByTestId('market-pause-start')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-pause-current-reason')).toHaveText(
        copy.pauseReasonEarlyResult,
      );
      await expect(firstPage.getByTestId('market-pause-current-note')).toHaveText(note);
      await expect(firstPage.getByTestId('market-pause-current-by')).toHaveText(firstName);
      await expect(firstPage.getByTestId('market-pause-current-published-at')).toHaveText(
        formatKst(publishedAt),
      );
      await expect(firstPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'ongoing',
      );
      await expect(firstPage.getByTestId('market-pause-history-0-end')).toHaveText(
        copy.pauseOngoing,
      );
      // The 이벤트 로그's 일시 중단: the reason and the publication instant, admin 1's.
      const atPause = await adminMarketOf(admin, market.id);
      const pauseId = lastingPauseOf(atPause);
      const pausedEvent = atPause.events[0];
      expect(pausedEvent).toMatchObject({
        type: 'paused',
        actorId: first.id,
        fromStatus: 'open',
        toStatus: 'paused',
        payload: { reason: 'early_result', resultPublishedAt: publishedAt },
      });
      const pausedRow = firstPage.getByTestId(`market-event-${String(pausedEvent?.id)}`);
      await expect(pausedRow).toContainText(copy.eventPaused);
      await expect(pausedRow).toContainText(
        `${copy.adminMarketPauseReason} ${copy.pauseReasonEarlyResult}`,
      );
      await expect(pausedRow).toContainText(
        `${copy.adminMarketPauseResultPublishedAt} ${formatKst(publishedAt)}`,
      );

      // --- the visitor's detail, never reloaded: 거래 일시 중단, its notice, and no order area.
      await expect(badge).toHaveText(copy.marketStatusPaused);
      await expect(page.getByTestId('market-status-notice')).toContainText(copy.marketPausedNotice);
      await expect(page.getByTestId('order-area')).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);
      // The public market says 거래 일시 중단 and nothing of the pause (#24 shows the reason and
      // the times later): no note, no publication instant (the ISO instant sent), no admin.
      const publicPaused = await publicMarketOf(request, market.id);
      expect(publicPaused.status).toBe('paused');
      expect(Object.keys(publicPaused)).not.toContain('pause');
      const publicBody = await (await request.get(`/api/v1/markets/${market.id}`)).text();
      for (const hidden of [note, publishedAt, first.id]) expect(publicBody).not.toContain(hidden);

      // --- 재개·조기 마감 요청: the dialog names the pause's reason; an early result's next path
      // takes no review result, and the operator picks it.
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-pause-request').click();
      const requestDialog = firstPage.getByTestId('market-pause-request-dialog');
      const requestConfirm = requestDialog.getByTestId('market-pause-request-dialog-confirm');
      await expect(requestDialog.getByTestId('market-pause-request-pause-reason')).toHaveText(
        `${copy.adminMarketPauseReason} ${copy.pauseReasonEarlyResult}`,
      );
      await expect(requestDialog.getByTestId('market-pause-request-review-judgeable')).toHaveCount(
        0,
      );
      await expect(requestConfirm).toBeDisabled();
      await requestDialog.getByTestId('market-pause-request-path-resume').click();
      await requestDialog.getByTestId('market-pause-request-reason').fill(requestReason);
      await expect(requestConfirm).toBeEnabled();
      const requested = nextWrite(firstPage, market.id, '/pause-decisions');
      await requestConfirm.click();
      // Naming the pause the dialog opened on (ADR-0102 9-2).
      expect((await requested).postDataJSON()).toEqual({
        pauseId,
        path: 'resume',
        reviewResult: null,
        reason: requestReason,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketPauseRequested)).toBeVisible();
      await expect(requestDialog).toHaveCount(0);

      // --- waiting: the path, the reason, who asked; its requester may not decide it (the note
      // says why) and alone may retract it, and one waits at a time.
      await expect(firstPage.getByTestId('market-pause-pending-path')).toHaveText(
        copy.pausePathResume,
      );
      await expect(firstPage.getByTestId('market-pause-pending-review')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-pause-pending-reason')).toHaveText(requestReason);
      await expect(firstPage.getByTestId('market-pause-pending-by')).toHaveText(firstName);
      await expect(firstPage.getByTestId('market-pause-requester-note')).toHaveText(
        copy.adminMarketPauseExcludedRequester,
      );
      await expect(firstPage.getByTestId('market-pause-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-pause-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-pause-retract')).toBeEnabled();
      await expect(firstPage.getByTestId('market-pause-request')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-pause-history-0-log-0')).toHaveAttribute(
        'data-status',
        'pending',
      );
      const waiting = await adminMarketOf(admin, market.id);
      const requestId = pendingOf(waiting);
      expect(waiting.status).toBe('paused');
      expect(
        await refusalOf(
          await sendPauseDecision(admin, market.id, requestId, 'approve', { reason: approval }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'requester' }]);
      expect(
        await refusalOf(
          await sendPauseDecisionRequest(admin, market.id, 'early_close'),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['pause'], message: 'pending' }]);
      // A paused market is not paused again.
      expect(
        await refusalOf(
          await sendPause(admin, market.id, 'ledger_failure'),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['status'], message: 'not open' }]);

      // --- admin 2 finds it in 일시 중단 결정 대기, under 검수 대기: the question to its detail,
      // the pause's reason, the path, who asked.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      expect(await waitingPauseDecisionIds(secondAdmin)).toContain(requestId);
      await secondPage.goto('/admin/markets/reviews');
      const row = secondPage.getByTestId(`admin-market-pause-decision-${requestId}`);
      await showInPauseDecisions(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(
        secondPage.getByTestId(`admin-market-pause-decision-reason-${requestId}`),
      ).toHaveText(copy.pauseReasonEarlyResult);
      await expect(
        secondPage.getByTestId(`admin-market-pause-decision-path-${requestId}`),
      ).toHaveText(copy.pausePathResume);
      await expect(
        secondPage.getByTestId(`admin-market-pause-decision-review-${requestId}`),
      ).toHaveText('—');
      await expect(
        secondPage.getByTestId(`admin-market-pause-decision-requested-by-${requestId}`),
      ).toHaveText(firstName);
      await secondPage.getByTestId(`admin-market-pause-decision-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- 승인 with a reason: the market trades again at once, and the pause ends as 재개.
      await expect(secondPage.getByTestId('market-pause-requester-note')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause-retract')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause-reject')).toBeEnabled();
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-pause-approve').click();
      const approveDialog = secondPage.getByTestId('market-pause-approve-dialog');
      const approveConfirm = approveDialog.getByTestId('market-pause-approve-dialog-confirm');
      await expect(approveDialog).toContainText(copy.adminMarketPauseApproveResumeBody);
      await expect(approveDialog.getByTestId('market-pause-approve-request')).toHaveText(
        `${copy.adminMarketPauseRequestPath} ${copy.pausePathResume}`,
      );
      await expect(approveConfirm).toBeDisabled();
      await approveDialog.getByTestId('market-pause-approve-reason').fill(approval);
      await expect(approveConfirm).toBeEnabled();
      const approved = nextWrite(secondPage, market.id, `/pause-decisions/${requestId}/approve`);
      await approveConfirm.click();
      expect((await approved).postDataJSON()).toEqual({
        reason: approval,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketPauseResumed)).toBeVisible();
      await expect(approveDialog).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause')).toHaveAttribute('data-status', 'open');
      await expect(secondPage.getByTestId('market-pause-pending')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause-current')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause-start')).toBeEnabled();
      // The 일시 중단 기록: the pause ended as 재개, who paused it and who approved its end, and
      // its request approved.
      await expect(secondPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'resumed',
      );
      await expect(secondPage.getByTestId('market-pause-history-0-end')).toHaveText(
        copy.pauseEndResumed,
      );
      const rows = secondPage.getByTestId('market-pause-history-0-rows');
      await expect(rows).toContainText(`${copy.adminMarketPausedBy} ${firstName}`);
      await expect(rows).toContainText(`${copy.pauseLogEndedBy} ${secondName}`);
      await expect(secondPage.getByTestId('market-pause-history-0-log-0')).toHaveAttribute(
        'data-status',
        'approved',
      );
      expect(await waitingPauseDecisionIds(secondAdmin)).not.toContain(requestId);
    } finally {
      await leaveNoPauseDecision(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }

    // --- the visitor's detail, never reloaded: 거래 중 again, with no notice.
    await expect(badge).toHaveText(copy.marketStatusOpen);
    await expect(page.getByTestId('market-status-notice')).toHaveCount(0);
    expect(await documentSurvived(page)).toBe(true);

    // --- the records: `resumed` by admin 2 after `paused` by admin 1, both naming the pause; the
    // pause ended as 재개 with no review result (an early result takes none); the close as it was.
    const resumed = await adminMarketOf(admin, market.id);
    const [pause] = resumed.pause.history;
    if (pause === undefined) throw new Error('no pause recorded');
    expect(resumed.status).toBe('open');
    expect(Date.parse(resumed.closeAt)).toBe(Date.parse(market.closeAt));
    expect(resumed.events.slice(0, 2)).toMatchObject([
      {
        type: 'resumed',
        actorId: second.id,
        fromStatus: 'paused',
        toStatus: 'open',
        payload: { pauseId: pause.id, requestedBy: first.id, reviewResult: null },
      },
      { type: 'paused', actorId: first.id, payload: { pauseId: pause.id } },
    ]);
    expect(pause).toMatchObject({
      reason: 'early_result',
      note,
      resultPublishedAt: publishedAt,
      pausedBy: { id: first.id },
      reviewResult: null,
      endKind: 'resumed',
      endedBy: { id: second.id },
    });
    expect(resumed.pause.pending).toBeNull();
    expect(resumed.pause.log.map((entry) => entry.status)).toEqual(['approved']);
  });

  test('두 번째 일시 중단은 실질 기준 변경이고 검토 결과가 판정 불가면 재개를 고를 수 없어 조기 마감만 요청하며, 다른 관리자가 승인하면 방문자의 상세가 리프레시 없이 마감되고 거래 마감 시각은 예정된 그대로다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createOpenMarket(admin);
    // One pair traded by the helper's members: an early close with no fill of a person's account
    // cancels the market instead (#20, the next test).
    await tradeOnce(admin, market.id);
    const note = `사건의 판정 기준이 실질적으로 바뀌었습니다 ${market.tag}`;
    const requestReason = `바뀐 기준으로는 기존 규칙으로 판정할 수 없습니다 ${market.tag}`;
    const approval = `판정 불가 검토를 확인했습니다 ${market.tag}`;

    // --- a first pause, for 담보·원장 장애, resumed: a market pauses again after a resume. Its
    // reason takes no review result, which the request refuses.
    const firstPauseId = lastingPauseOf(await pauseMarket(admin, market.id, 'ledger_failure'));
    try {
      expect(
        await refusalOf(
          await sendPauseDecisionRequest(admin, market.id, 'resume', { reviewResult: 'judgeable' }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['reviewResult'], message: 'only for basis_change' }]);
      await requestPauseDecision(admin, market.id, 'resume');
      expect((await approvePauseDecisionAsReviewer(admin, market.id)).status).toBe('open');
    } finally {
      // A failure before the approval leaves the request waiting; once approved, nothing waits.
      await leaveNoPauseDecision(admin, market.id);
    }

    // --- the visitor, signed out, in the market's room first.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusOpen);
    await markDocument(page);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1 pauses it again, for 실질 기준 변경: no publication instant is asked.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'resumed',
      );
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-pause-start').click();
      const dialog = firstPage.getByTestId('market-pause-dialog');
      await dialog.getByTestId('market-pause-reason-basis_change').click();
      await expect(dialog.getByTestId('market-pause-published-at')).toHaveCount(0);
      await dialog.getByTestId('market-pause-note').fill(note);
      const paused = nextWrite(firstPage, market.id, '/pause');
      await dialog.getByTestId('market-pause-dialog-confirm').click();
      expect((await paused).postDataJSON()).toEqual({
        reason: 'basis_change',
        note,
        resultPublishedAt: null,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketPaused)).toBeVisible();
      await expect(firstPage.getByTestId('market-pause')).toHaveAttribute('data-status', 'paused');
      // The newest pause first: this one lasting, the first ended as 재개.
      await expect(firstPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'ongoing',
      );
      await expect(firstPage.getByTestId('market-pause-history-1')).toHaveAttribute(
        'data-end',
        'resumed',
      );
      await expect(badge).toHaveText(copy.marketStatusPaused);
      const pauseId = lastingPauseOf(await adminMarketOf(admin, market.id));
      expect(pauseId).not.toBe(firstPauseId);

      // A request naming the first pause, ended by its 재개, decides nothing of this one — not
      // even a path this pause's reason allows: refused before the waiting request and the
      // reason's rules are looked at (ADR-0102 9-2), and nothing waits after it.
      expect(
        await refusalOf(
          await sendPauseDecisionRequest(admin, market.id, 'early_close', {
            pauseId: firstPauseId,
            reviewResult: 'not_judgeable',
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['pause'], message: 'stale' }]);
      expect((await adminMarketOf(admin, market.id)).pause.pending).toBeNull();

      // A 실질 기준 변경 pause's next path is asked with its review result, and 판정 불가 takes no
      // 재개 (#173 item 4: no reopening on rules that cannot judge the market).
      expect(
        await refusalOf(
          await sendPauseDecisionRequest(admin, market.id, 'resume'),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['reviewResult'], message: 'required' }]);
      expect(
        await refusalOf(
          await sendPauseDecisionRequest(admin, market.id, 'resume', {
            reviewResult: 'not_judgeable',
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['path'], message: 'early close only' }]);

      // --- the request dialog: the review result first; 판정 가능 leaves the choice (Q1), and
      // 판정 불가 drops a 재개 picked before it, turns 재개 off and says why.
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-pause-request').click();
      const requestDialog = firstPage.getByTestId('market-pause-request-dialog');
      const requestConfirm = requestDialog.getByTestId('market-pause-request-dialog-confirm');
      const resume = requestDialog.getByTestId('market-pause-request-path-resume');
      await expect(requestDialog.getByTestId('market-pause-request-pause-reason')).toHaveText(
        `${copy.adminMarketPauseReason} ${copy.pauseReasonBasisChange}`,
      );
      await requestDialog.getByTestId('market-pause-request-review-judgeable').click();
      await resume.click();
      await requestDialog.getByTestId('market-pause-request-reason').fill(requestReason);
      await expect(requestConfirm).toBeEnabled();
      await requestDialog.getByTestId('market-pause-request-review-not_judgeable').click();
      await expect(resume).toHaveAttribute('data-disabled');
      await expect(resume).toHaveAttribute('data-state', 'unchecked');
      await expect(requestDialog.getByTestId('market-pause-request-early-close-only')).toHaveText(
        copy.pauseReviewNotJudgeableHint,
      );
      await expect(requestConfirm).toBeDisabled();
      await requestDialog.getByTestId('market-pause-request-path-early_close').click();
      await expect(requestConfirm).toBeEnabled();
      const requested = nextWrite(firstPage, market.id, '/pause-decisions');
      await requestConfirm.click();
      expect((await requested).postDataJSON()).toEqual({
        pauseId,
        path: 'early_close',
        reviewResult: 'not_judgeable',
        reason: requestReason,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketPauseRequested)).toBeVisible();
      await expect(firstPage.getByTestId('market-pause-pending-path')).toHaveText(
        copy.pausePathEarlyClose,
      );
      await expect(firstPage.getByTestId('market-pause-pending-review')).toHaveText(
        copy.pauseReviewNotJudgeable,
      );
      const requestId = pendingOf(await adminMarketOf(admin, market.id));

      // --- admin 2 approves it on the detail: the dialog says the market closes and is never
      // reopened; the market closes at once.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-pause-approve').click();
      const approveDialog = secondPage.getByTestId('market-pause-approve-dialog');
      await expect(approveDialog).toContainText(copy.adminMarketPauseApproveEarlyCloseBody);
      await expect(approveDialog.getByTestId('market-pause-approve-request')).toHaveText(
        `${copy.adminMarketPauseRequestPath} ${copy.pausePathEarlyClose} · ` +
          `${copy.adminMarketPauseRequestReview} ${copy.pauseReviewNotJudgeable}`,
      );
      await approveDialog.getByTestId('market-pause-approve-reason').fill(approval);
      const approved = nextWrite(secondPage, market.id, `/pause-decisions/${requestId}/approve`);
      await approveDialog.getByTestId('market-pause-approve-dialog-confirm').click();
      expect((await approved).postDataJSON()).toEqual({
        reason: approval,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketPauseEarlyClosed)).toBeVisible();
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusClosed,
      );
      await expect(secondPage.getByTestId('market-pause')).toHaveAttribute('data-status', 'closed');
      await expect(secondPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'early_closed',
      );
      await expect(secondPage.getByTestId('market-pause-history-0-end')).toHaveText(
        copy.pauseEndEarlyClosed,
      );
      await expect(secondPage.getByTestId('market-pause-history-0-rows')).toContainText(
        `${copy.pauseLogReviewResult} ${copy.pauseReviewNotJudgeable}`,
      );
      await expect(secondPage.getByTestId('market-pause-history-1')).toHaveAttribute(
        'data-end',
        'resumed',
      );
      await expect(secondPage.getByTestId('market-pause-request')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-pause-start')).toHaveCount(0);

      // The 이벤트 로그 names the approved close 조기 마감, with its review result.
      const closedEvent = (await adminMarketOf(admin, market.id)).events[0];
      const closedRow = secondPage.getByTestId(`market-event-${String(closedEvent?.id)}`);
      await expect(closedRow).toContainText(copy.eventEarlyClosed);
      await expect(closedRow).toContainText(
        `${copy.pauseLogReviewResult} ${copy.pauseReviewNotJudgeable}`,
      );
    } finally {
      await leaveNoPauseDecision(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }

    // --- the visitor's detail, never reloaded: 거래 마감 and its notice.
    await expect(badge).toHaveText(copy.marketStatusClosed);
    await expect(page.getByTestId('market-status-notice')).toContainText(copy.marketClosedNotice);
    expect(await documentSurvived(page)).toBe(true);

    // --- the records: `closed` by admin 2 from PAUSED, an early close naming the pause, the
    // request and its requester and the review result; the close the scheduled one still — the
    // actual instant is the event's `closedAt` (#80's rule version keeps `close_at`).
    const closed = await adminMarketOf(admin, market.id);
    const [pause, earlier] = closed.pause.history;
    if (pause === undefined || earlier === undefined) throw new Error('two pauses expected');
    expect(closed.status).toBe('closed');
    expect(Date.parse(closed.closeAt)).toBe(Date.parse(market.closeAt));
    expect(closed.events[0]).toMatchObject({
      type: 'closed',
      actorId: second.id,
      fromStatus: 'paused',
      toStatus: 'closed',
      payload: {
        source: 'early_close',
        pauseId: pause.id,
        requestedBy: first.id,
        reviewResult: 'not_judgeable',
      },
    });
    expect(pause).toMatchObject({
      reason: 'basis_change',
      note,
      resultPublishedAt: null,
      reviewResult: 'not_judgeable',
      endKind: 'early_closed',
      endedBy: { id: second.id },
    });
    expect(earlier).toMatchObject({ reason: 'ledger_failure', endKind: 'resumed' });
    expect(Date.parse((await publicMarketOf(request, market.id)).closeAt)).toBe(
      Date.parse(market.closeAt),
    );
    // Never reopened, never paused again.
    expect(
      await refusalOf(
        await sendPauseDecisionRequest(admin, market.id, 'resume', { reviewResult: 'judgeable' }),
        400,
        'VALIDATION_ERROR',
      ),
    ).toEqual([{ path: ['status'], message: 'not paused' }]);
    expect(
      await refusalOf(await sendPause(admin, market.id, 'basis_change'), 400, 'VALIDATION_ERROR'),
    ).toEqual([{ path: ['status'], message: 'not open' }]);
  });

  test('사용자가 낀 체결이 한 건도 없는 시장의 조기 마감을 다른 관리자가 승인하면 마감 대신 취소되고, 방문자의 상세가 리프레시 없이 취소가 되며, 이벤트 로그는 취소와 그 사유다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    // #20 (ADR-0117; ADR-0107 결정 4 '#120·#20'): nobody traded, so the approved early close ends
    // the market CANCELLED — the result type empty, no judgement — with the system sentence.
    const second = await meOf(secondAdmin);
    const market = await createOpenMarket(admin);
    await pauseMarket(admin, market.id, 'basis_change');
    const requestId = pendingOf(
      await requestPauseDecision(admin, market.id, 'early_close', { reviewResult: 'judgeable' }),
    );

    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusPaused);
    await markDocument(page);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-pause-approve').click();
      const approveDialog = secondPage.getByTestId('market-pause-approve-dialog');
      // The dialog says a market nobody traded is cancelled rather than closed.
      await expect(approveDialog).toContainText(copy.adminMarketPauseApproveEarlyCloseBody);
      await approveDialog
        .getByTestId('market-pause-approve-reason')
        .fill(`체결 없는 시장의 조기 마감을 확인했습니다 ${market.tag}`);
      const approved = nextWrite(secondPage, market.id, `/pause-decisions/${requestId}/approve`);
      await approveDialog.getByTestId('market-pause-approve-dialog-confirm').click();
      await approved;
      await expect(secondPage.getByText(copy.adminMarketPauseEarlyCancelled)).toBeVisible();
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusCancelled,
      );
      // The pause ended as an early close all the same (the end kind says how the pause ended).
      await expect(secondPage.getByTestId('market-pause-history-0')).toHaveAttribute(
        'data-end',
        'early_closed',
      );
      // The 이벤트 로그: 취소, by the early close, with the system sentence.
      const cancelledEvent = (await adminMarketOf(admin, market.id)).events[0];
      const cancelledRow = secondPage.getByTestId(`market-event-${String(cancelledEvent?.id)}`);
      await expect(cancelledRow).toContainText(copy.eventCancelled);
      await expect(cancelledRow).toContainText(
        `${copy.eventCancelSource} ${copy.eventCancelSourceEarlyClose}`,
      );
      await expect(cancelledRow).toContainText(NO_FILL_CANCEL_REASON);
    } finally {
      await leaveNoPauseDecision(admin, market.id);
      await secondContext.close();
    }

    // --- the visitor's detail, never reloaded: 취소 and its notice.
    await expect(badge).toHaveText(copy.marketStatusCancelled);
    await expect(page.getByTestId('market-status-notice')).toContainText(
      copy.marketCancelledNotice,
    );
    expect(await documentSurvived(page)).toBe(true);

    // --- the records: `cancelled` from PAUSED by admin 2, the result type empty; never reopened.
    const cancelled = await adminMarketOf(admin, market.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resolvedResult).toBeNull();
    expect(cancelled.events[0]).toMatchObject({
      type: 'cancelled',
      actorId: second.id,
      fromStatus: 'paused',
      toStatus: 'cancelled',
      payload: { source: 'early_close', reason: NO_FILL_CANCEL_REASON },
    });
    expect(cancelled.pause.history[0]?.endKind).toBe('early_closed');
    const shown = await publicMarketOf(request, market.id);
    expect(shown.status).toBe('cancelled');
    expect(shown.resolvedResult).toBeNull();
    expect(
      await refusalOf(await sendPause(admin, market.id, 'basis_change'), 400, 'VALIDATION_ERROR'),
    ).toEqual([{ path: ['status'], message: 'not open' }]);
  });

  test('거래 일시 중단 중인 시장도 카테고리·태그는 기록과 함께 바로 고치고 규칙 항목은 보충으로만 바뀌며, 기다리는 요청은 요청한 관리자만 철회하고 다른 관리자는 반려한다', async ({
    admin,
    secondAdmin,
    browser,
  }) => {
    const first = await meOf(admin);
    const market = await createOpenMarket(admin);
    const added = freshTag();
    await pauseMarket(admin, market.id, 'ledger_failure');

    const adminContext = await browser.newContext();
    try {
      // --- the edit card of a paused market: the version items are the supplement's, the
      // category, tags and image the card's — saved after a confirmation in its own words.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusPaused,
      );
      await expect(adminPage.getByTestId('market-edit-supplement-only')).toHaveText(
        copy.adminMarketEditSupplementOnly,
      );
      await expect(adminPage.getByTestId('market-edit-locked')).toHaveCount(0);
      const box = adminPage.getByTestId('market-tags-input');
      await box.fill(added);
      await box.press('Enter');
      await expect(adminPage.getByTestId('market-tags-list').locator('li')).toHaveText([
        market.tag,
        added,
      ]);
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-save').click();
      // The open market's edit confirmation is a ConfirmDialog: `role="alertdialog"`.
      const confirmDialog = adminPage.getByRole('alertdialog');
      await expect(confirmDialog).toContainText(copy.adminMarketEditPausedTitle);
      await expect(confirmDialog).toContainText(copy.adminMarketEditPausedBody);
      const saved = adminPage.waitForRequest(
        (sent) =>
          sent.method() === 'PATCH' &&
          new URL(sent.url()).pathname === `/api/v1/admin/markets/${market.id}`,
      );
      await adminPage.getByTestId('market-edit-confirm').click();
      expect((await saved).postDataJSON()).toEqual({
        tags: [market.tag, added],
        expectedAccountId: first.id,
      });
      await expect(adminPage.getByText(copy.adminMarketSaved)).toBeVisible();
      await expect(adminPage.getByTestId('market-detail-tags')).toHaveText(
        `${market.tag}, ${added}`,
      );
      // Still paused; a version item is refused as on an open market — a supplement's.
      const edited = await adminMarketOf(admin, market.id);
      expect(edited).toMatchObject({ status: 'paused', tags: [market.tag, added] });
      expect(
        await refusalOf(
          await admin.patch(`/api/v1/admin/markets/${market.id}`, {
            data: {
              title: `${market.title} (고친 제목)`,
              expectedAccountId: await accountIdOf(admin),
            },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['title'], message: 'supplement only while open' }]);

      // --- a 재개 asked for: admin 2 may not retract it, admin 1 does on screen.
      const retracted = await requestPauseDecision(admin, market.id, 'resume');
      const retractedId = pendingOf(retracted);
      expect(
        await refusalOf(
          await sendPauseDecision(secondAdmin, market.id, retractedId, 'retract'),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'not_requester' }]);
      await adminPage.reload();
      await expect(adminPage.getByTestId('market-pause-retract')).toBeEnabled();
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-pause-retract').click();
      const retractDialog = adminPage.getByTestId('market-pause-retract-dialog');
      await expect(retractDialog.getByTestId('market-pause-retract-request')).toHaveText(
        `${copy.adminMarketPauseRequestPath} ${copy.pausePathResume}`,
      );
      const retractedWrite = nextWrite(
        adminPage,
        market.id,
        `/pause-decisions/${retractedId}/retract`,
      );
      await retractDialog.getByTestId('market-pause-retract-dialog-confirm').click();
      expect((await retractedWrite).postDataJSON()).toEqual({ expectedAccountId: first.id });
      await expect(adminPage.getByText(copy.adminMarketPauseRetracted)).toBeVisible();
      await expect(adminPage.getByTestId('market-pause-pending')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-pause-request')).toBeEnabled();
      await expect(adminPage.getByTestId('market-pause-history-0-log-0')).toHaveAttribute(
        'data-status',
        'retracted',
      );

      // --- a 조기 마감 asked for next: admin 2 rejects it, and the market stays paused.
      const rejected = await requestPauseDecision(admin, market.id, 'early_close');
      const rejectedId = pendingOf(rejected);
      const rejection = `장애가 복구되면 재개합니다 ${market.tag}`;
      await dataOf<AdminMarket>(
        await sendPauseDecision(secondAdmin, market.id, rejectedId, 'reject', {
          reason: rejection,
        }),
      );
      const after = await adminMarketOf(admin, market.id);
      expect(after.status).toBe('paused');
      expect(after.pause.pending).toBeNull();
      expect(after.pause.log.map((entry) => entry.status)).toEqual(['rejected', 'retracted']);
      expect(after.pause.log[0]).toMatchObject({ decisionReason: rejection });
      // Decided, it is decided by no one again.
      expect(
        await refusalOf(
          await sendPauseDecision(secondAdmin, market.id, rejectedId, 'approve', {
            reason: rejection,
          }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'decided' }]);
    } finally {
      await leaveNoPauseDecision(admin, market.id);
      await adminContext.close();
    }
  });

  test('관리자 한 명의 마감은 없다: 그 경로는 404이고 거래 중인 시장은 그대로다', async ({
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    const before = await adminMarketOf(admin, market.id);
    // --- the interim close's route is gone (#114, as #21's open): the router answers 404, and the
    // market is untouched.
    const gone = await admin.post(`/api/v1/admin/markets/${market.id}/close`, {
      data: { expectedAccountId: await accountIdOf(admin) },
    });
    const body = await gone.text();
    expect(gone.status(), body).toBe(404);
    expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    const after = await adminMarketOf(admin, market.id);
    expect(after.status).toBe('open');
    expect(after.events.map((event) => event.type)).toEqual(
      before.events.map((event) => event.type),
    );
  });

  test('보충을 의미 변경으로 반려한 거래 중인 시장은 일시 중단 칸이 실질 기준 변경과 반려 설명을 채운 일시 중단을 권하고, 누르면 그대로 일시 중단된다', async ({
    admin,
    secondAdmin,
    browser,
  }) => {
    const first = await meOf(admin);
    const market = await createOpenMarket(admin);
    const reworded = `사건 기한까지 확인 코드가 두 번 발표되면 YES입니다. 확인 코드 ${market.tag}.`;
    const rejection = `두 번 발표를 요구하면 질문의 뜻이 바뀝니다 ${market.tag}`;

    const adminContext = await browser.newContext();
    try {
      // --- admin 1 asks for a YES 조건 that changes what YES means; admin 2 rejects it as 의미
      // 변경. The 반려 does not pause the market (ADR-0101): it stays open.
      const asked = await requestSupplement(admin, market.id, { yesCondition: reworded });
      const supplementId = asked.supplement.pending?.requestId ?? '';
      const rejected = await dataOf<AdminMarket>(
        await sendSupplementDecision(secondAdmin, market.id, supplementId, 'reject', {
          rejectReason: 'meaning_change',
          reason: rejection,
        }),
      );
      expect(rejected.status).toBe('open');

      // --- the detail offers the pause in place of the plain button (#172 item 15).
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      const offer = adminPage.getByTestId('market-pause-offer');
      await expect(offer).toContainText(copy.adminMarketPauseOffer);
      await expect(adminPage.getByTestId('market-pause-start')).toHaveCount(0);

      // --- pressed, the pause dialog opens as 실질 기준 변경 with the 반려's 설명 as its note, and
      // sends that at once.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-pause-offer-pause').click();
      const dialog = adminPage.getByTestId('market-pause-dialog');
      await expect(dialog.getByTestId('market-pause-reason-basis_change')).toHaveAttribute(
        'data-state',
        'checked',
      );
      await expect(dialog.getByTestId('market-pause-note')).toHaveValue(rejection);
      const confirm = dialog.getByTestId('market-pause-dialog-confirm');
      await expect(confirm).toBeEnabled();
      const paused = nextWrite(adminPage, market.id, '/pause');
      await confirm.click();
      expect((await paused).postDataJSON()).toEqual({
        reason: 'basis_change',
        note: rejection,
        resultPublishedAt: null,
        expectedAccountId: first.id,
      });
      await expect(adminPage.getByText(copy.adminMarketPaused)).toBeVisible();
      await expect(adminPage.getByTestId('market-pause')).toHaveAttribute('data-status', 'paused');
      await expect(offer).toHaveCount(0);
      await expect(adminPage.getByTestId('market-pause-current-reason')).toHaveText(
        copy.pauseReasonBasisChange,
      );
      await expect(adminPage.getByTestId('market-pause-current-note')).toHaveText(rejection);
      // The rules stay as they were: still v1, the YES 조건 as it was.
      expect(await adminMarketOf(admin, market.id)).toMatchObject({
        status: 'paused',
        ruleVersion: 1,
        yesCondition: market.yesCondition,
      });
    } finally {
      await leaveNoSupplement(admin, market.id);
      await adminContext.close();
    }
  });

  test('거래 일시 중단 중에도 거래 마감 시각은 예정대로 와서 워커가 마감하고 일시 중단 기록은 예정 마감이며, 기다리던 요청은 승인할 수 없어 다른 관리자가 반려로 끝낸다', async ({
    admin,
    secondAdmin,
    browser,
  }) => {
    skipWithoutWorkerProbe();
    test.slow(); // the close is more than a real minute away
    // Admin 2 signs in before the clock starts: CLOSE_IN_MS budgets the market's making, its pause
    // and request and the page's first load, not a sign-in as well.
    const second = await meOf(secondAdmin);
    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      // The helper's members too (their sign-up, once per worker): the market trades one pair
      // before its pause, so the worker's close is 거래 마감 — with no fill it would be 취소 (#20).
      await helperTraders(admin);
      const closeAt = new Date(Date.now() + CLOSE_IN_MS).toISOString();
      const market = await createOpenMarket(admin, { closeAt });
      try {
        await tradeOnce(admin, market.id);
        await pauseMarket(admin, market.id, 'basis_change');
        const requestId = pendingOf(
          await requestPauseDecision(admin, market.id, 'resume', { reviewResult: 'judgeable' }),
        );
        const rejection = `거래 마감 시각이 지나 요청을 끝냅니다 ${market.tag}`;

        // --- admin 2 on its detail before the close: the request may be approved.
        await secondPage.goto(`/admin/markets/${market.id}`);
        const panel = secondPage.getByTestId('market-pause');
        await expect(panel).toHaveAttribute('data-status', 'paused');
        await expect(secondPage.getByTestId('market-pause-approve')).toBeEnabled();
        await markDocument(secondPage);

        // --- nobody presses anything: at its close the worker closes the paused market — the
        // delayed job the approval registered at the open, or the per-minute scan behind it.
        await expect
          .poll(async () => (await adminMarketOf(admin, market.id)).status, {
            timeout: CLOSE_WAIT_MS,
            intervals: [2_000],
          })
          .toBe('closed');
        const closed = await adminMarketOf(admin, market.id);
        // The worker's: no actor, from PAUSED, its source the job; the pause ended 예정 마감 with
        // no approver and no review result; the request still waits.
        expect(closed.events[0]).toMatchObject({
          type: 'closed',
          actorId: null,
          fromStatus: 'paused',
          toStatus: 'closed',
          payload: { source: 'job' },
        });
        expect(closed.pause.history[0]).toMatchObject({
          endKind: 'closed_at_close',
          endedBy: null,
          reviewResult: null,
        });
        expect(Date.parse(closed.pause.history[0]?.endedAt ?? '')).toBeGreaterThanOrEqual(
          Date.parse(closeAt),
        );
        expect(closed.pause.pending?.requestId).toBe(requestId);
        // Moot: its approval is refused by the status.
        expect(
          await refusalOf(
            await sendPauseDecision(secondAdmin, market.id, requestId, 'approve', {
              reason: rejection,
            }),
            400,
            'VALIDATION_ERROR',
          ),
        ).toEqual([{ path: ['status'], message: 'not paused' }]);

        // --- admin 2's detail, left open, read it again by itself (it re-reads a market OPEN or
        // PAUSED from its close until it is neither, `tradingMarketPollDelay`): 거래 마감, the
        // pause 예정 마감, and the request's 승인 off under the note why — its 반려 still on.
        await expect(panel).toHaveAttribute('data-status', 'closed', {
          timeout: ADMIN_POLL_WAIT_MS,
        });
        expect(await documentSurvived(secondPage)).toBe(true);
        await expect(secondPage.getByTestId('market-pause-history-0')).toHaveAttribute(
          'data-end',
          'closed_at_close',
        );
        await expect(secondPage.getByTestId('market-pause-history-0-end')).toHaveText(
          copy.pauseEndClosedAtClose,
        );
        await expect(secondPage.getByTestId('market-pause-pending-closed')).toHaveText(
          copy.adminMarketPausePendingClosed,
        );
        await expect(secondPage.getByTestId('market-pause-approve')).toBeDisabled();
        await expect(secondPage.getByTestId('market-pause-reject')).toBeEnabled();

        // --- 반려 with a reason ends it in any status.
        await letToastsGo(secondPage);
        await secondPage.getByTestId('market-pause-reject').click();
        const rejectDialog = secondPage.getByTestId('market-pause-reject-dialog');
        await expect(rejectDialog.getByTestId('market-pause-reject-request')).toHaveText(
          `${copy.adminMarketPauseRequestPath} ${copy.pausePathResume} · ` +
            `${copy.adminMarketPauseRequestReview} ${copy.pauseReviewJudgeable}`,
        );
        await rejectDialog.getByTestId('market-pause-reject-reason').fill(rejection);
        const rejected = nextWrite(secondPage, market.id, `/pause-decisions/${requestId}/reject`);
        await rejectDialog.getByTestId('market-pause-reject-dialog-confirm').click();
        expect((await rejected).postDataJSON()).toEqual({
          reason: rejection,
          expectedAccountId: second.id,
        });
        await expect(secondPage.getByText(copy.adminMarketPauseRejected)).toBeVisible();
        await expect(secondPage.getByTestId('market-pause-pending')).toHaveCount(0);
        await expect(secondPage.getByTestId('market-pause-history-0-log-0')).toHaveAttribute(
          'data-status',
          'rejected',
        );
        expect((await adminMarketOf(admin, market.id)).status).toBe('closed');
      } finally {
        await leaveNoPauseDecision(admin, market.id);
      }
    } finally {
      await secondContext.close();
    }
  });
});

/**
 * The dialogs at a phone's width (PLAN 13 M4 AC 5's 375px, pinned here so both projects measure
 * them): the pause dialog with an early result's publication instant, and the request dialog of a
 * 실질 기준 변경 pause with its review result and 판정 불가's note, stay inside the screen.
 */
test.describe('거래 일시 중단 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  /** Whether `dialog` stays inside the screen's width and scrolls nothing sideways itself. */
  async function expectInsideWidth(page: Page, dialog: Locator): Promise<void> {
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const box = await dialog.boundingBox();
    if (box === null) throw new Error('the dialog has no bounding box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test('375px에서 일시 중단 창과 재개·조기 마감 요청 창은 가로로 넘치지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    try {
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      await letToastsGo(page);
      await page.getByTestId('market-pause-start').click();
      const dialog = page.getByTestId('market-pause-dialog');
      await dialog.getByTestId('market-pause-reason-early_result').click();
      await expect(dialog.getByTestId('market-pause-published-at')).toBeVisible();
      await expectInsideWidth(page, dialog);

      // Paused for 실질 기준 변경, then its request dialog with 판정 불가 picked.
      await dialog.getByTestId('market-pause-reason-basis_change').click();
      await dialog.getByTestId('market-pause-note').fill(`좁은 화면의 일시 중단 ${market.tag}`);
      await dialog.getByTestId('market-pause-dialog-confirm').click();
      await expect(page.getByTestId('market-pause')).toHaveAttribute('data-status', 'paused');
      await letToastsGo(page);
      await page.getByTestId('market-pause-request').click();
      const requestDialog = page.getByTestId('market-pause-request-dialog');
      await requestDialog.getByTestId('market-pause-request-review-not_judgeable').click();
      await expect(
        requestDialog.getByTestId('market-pause-request-early-close-only'),
      ).toBeVisible();
      await expectInsideWidth(page, requestDialog);
      await requestDialog.getByTestId('market-pause-request-dialog-cancel').click();
      await expect(requestDialog).toHaveCount(0);
    } finally {
      await leaveNoPauseDecision(admin, market.id);
    }
  });
});
