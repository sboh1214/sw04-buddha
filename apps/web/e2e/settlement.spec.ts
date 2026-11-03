import type { APIRequestContext, Page, Request } from '@playwright/test';
import type { AdminMarket } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  SETTLEMENT_WAIT_MS,
  adminAccount,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  judgementEvidenceLink,
  kstLocalOf,
  leaveNoJudgement,
  markDocument,
  resolveWaitMs,
  secondAdminAccount,
  signIn,
  skipUnlessResolvable,
  subscribed,
  test,
  waitForSettled,
} from './helpers';

/**
 * 마감 · 판정 · 정산 (PLAN 13 M5 AC 7, ADR-0046; since #152, ADR-0103 — ADR-0093 decision 1 #173
 * items 1·5, decision 3 the #152 rows): 한 관리자가 판정을 등록하고 다른 관리자가 승인하면 잠정
 * 결과가 공개되고, 이의 기한이 지나면 워커가 결과를 확정하고 정산한다 — 시장을 보던 탭이 소켓으로
 * 잠정 결과를, 그다음 지급 완료를 받는다(#174의 라벨).
 *
 * Nobody holds the market: there is no way to trade until the CLOB lands (#119; D13), so the
 * holder's half of AC 7 — 포트폴리오 정산 이력, 원장 정산 지급 — comes back with the order
 * panel and its screen tests (#189). What stays is the lifecycle every market goes through,
 * holders or not.
 *
 * The dispute window is the release setting `market.dispute_window`, which the suite's global
 * setup enters as 1분 while it is 미정 (global-setup.ts): the approval fixes the deadline a minute
 * on, the worker's delayed `market.resolve` job confirms the result at it (the per-minute scan a
 * minute later should the job be lost), and the same worker queues `market.finalize` at once — so
 * the market reads `settled` a minute or two after the approval, through `resolved` and `settling`
 * (#174: the worker starts the payout, then finishes it). Those two last a few seconds at most, so
 * this spec waits for the FINAL `settled` alone and never asserts the badge in between — a 결과
 * 확정 or 지급 중 the worker has already moved past would be a flaky assertion, not a finding. The
 * intermediate states are pinned by the API's and the worker's integration tests
 * (admin-markets-lifecycle.controller.test.ts, market-resolve.test.ts, market-finalize.test.ts).
 *
 * The worker itself is still a prerequisite: with its probe disabled (`WORKER_HEALTH_PORT=0`) the
 * config waits for no worker, so the test skips up front rather than wait for a job nobody may
 * be running — and so it does on a database whose dispute window is longer than a spec waits out
 * (`skipUnlessResolvable`). The judgement's own screens — the refusals, the queue, 반려 and 철회,
 * 무효 — are judgement.spec.ts's.
 *
 * Every market is created per run (helpers.ts), and the reader's tab is subscribed before it is
 * navigated, so a transition published while the page loads cannot be lost in the connect gap.
 */

const MINUTE_MS = 60 * 1_000;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the panel's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The `POST /admin/markets/:id<suffix>` this page sends next. */
function nextWrite(page: Page, marketId: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}${suffix}`,
  );
}

/** The admin market as `context` reads it. */
async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  const response = await context.get(`/api/v1/admin/markets/${id}`);
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: AdminMarket }).data;
}

test.describe('정산', () => {
  test('AC 7: 한 관리자의 판정 등록 → 다른 관리자의 승인 → 잠정 결과 → 이의 기한 뒤 결과 확정 → 정산 → 상세 배지', async ({
    browser,
    admin,
    page,
  }) => {
    // The dispute window, a minute, is waited out, then the payout.
    test.slow();
    await skipUnlessResolvable(admin);
    const market = await createOpenMarket(admin);
    const link = judgementEvidenceLink(market.id);
    const collectedAt = minuteIso(Date.now() - 5 * MINUTE_MS);
    const description = `사건 기한 전에 확인 코드가 발표되었음을 1차 출처에서 확인했습니다 ${market.tag}`;
    const approval = `출처와 증거, NO 조건의 사건 기한을 확인했습니다 ${market.tag}`;

    // --- the reader: subscribed BEFORE the navigation, so the 마감, 잠정 결과 and 정산 transitions
    // below reach this tab through the socket, not a reload.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await markDocument(page);

    // --- 마감 through the API — a pause and another admin's approved 조기 마감 since #114
    // (helpers.ts `closeMarket`): trading stops, and the badge says so without a reload.
    await closeMarket(admin, market.id);
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusClosed);

    // --- 판정 등록 through the ADMIN UI (PLAN 12), in a second browser signed in as the first seed
    // admin, so the reader's tab is untouched. The closed market carries 판정 대기.
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-detail-awaiting')).toHaveText(
        copy.adminMarketAwaitingResolution,
      );
      // No 무효 button on the closed market: the admin void and its cost refund are gone (#125,
      // N03 §6) — 무효 is a judgement's result (#173 item 4) — and no one-admin 판정 (#152).
      await expect(firstPage.getByTestId('market-void')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-resolve')).toHaveCount(0);
      // No settlement step exists before the result is confirmed, so the panel is not drawn.
      await expect(firstPage.getByTestId('market-settlement-steps')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement')).toHaveAttribute(
        'data-status',
        'closed',
      );

      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-judgement-register').click();
      const form = firstPage.getByTestId('market-judgement-form');
      await form.getByTestId('market-judgement-result-yes').click();
      await form.getByTestId('market-judgement-source-0').click();
      await form.getByTestId('market-judgement-link-0').fill(link);
      await form.getByTestId('market-judgement-collected-at').fill(kstLocalOf(collectedAt));
      await form.getByTestId('market-judgement-description').fill(description);
      const registered = nextWrite(firstPage, market.id, '/judgements');
      await form.getByTestId('market-judgement-submit').click();
      await registered;
      await expect(firstPage.getByText(copy.adminMarketJudgementRegistered)).toBeVisible();
      // Registered, nothing changed: the market is CLOSED and the reader's badge with it.
      await expect(firstPage.getByTestId('market-judgement-pending-result')).toHaveText(copy.yes);
      await expect(firstPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusClosed,
      );
      await expect(badge).toHaveText(copy.marketStatusClosed);

      // --- 승인 by the second seed admin on their own screen: before the scheduled judgement
      // (days out, helpers.ts `timesFor`), so the dialog asks to confirm the NO condition's event
      // deadline.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-judgement-approve').click();
      const dialog = secondPage.getByTestId('market-judgement-approve-dialog');
      const confirm = dialog.getByTestId('market-judgement-approve-dialog-confirm');
      await expect(dialog.getByTestId('market-judgement-approve-deadline')).toBeVisible();
      await dialog.getByTestId('market-judgement-approve-reason').fill(approval);
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-approve-confirm-deadline').click();
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(secondPage.getByText(copy.adminMarketJudgementApproved)).toBeVisible();
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusProvisional,
      );

      // --- the reader's tab: 잠정 결과 with its result, through the socket, on the same document.
      await expect(badge).toHaveText(copy.marketStatusProvisional);
      const provisional = page.getByTestId('market-status-notice');
      await expect(provisional).toContainText(copy.marketProvisionalNotice);
      await expect(provisional.getByTestId('market-detail-result')).toHaveText(copy.yes);
      expect(await documentSurvived(page), page.url()).toBe(true);

      // --- 지급 완료 once the dispute deadline has passed and the worker has confirmed and settled
      // — on the document that was there before the admins pressed anything. Only the final state:
      // the 결과 확정 and 지급 중 in between last as long as the worker takes (the file comment).
      const judged = await adminMarketOf(admin, market.id);
      expect(judged.status).toBe('provisional');
      expect(judged.judgementVersion).toBe(1);
      await expect(secondPage.getByTestId('market-judgement-current-deadline')).toHaveText(
        formatKst(judged.disputeDeadline ?? ''),
      );
      await expect(badge).toHaveText(copy.marketStatusSettled, {
        timeout: resolveWaitMs(judged) + SETTLEMENT_WAIT_MS,
      });
      expect(await documentSurvived(page), page.url()).toBe(true);
      await expect(page.getByTestId('market-status-notice-detail')).toHaveText(
        copy.marketSettledPayout,
      );
      // The API says so too: confirmed at the deadline the approval fixed, never before it.
      const settled = await waitForSettled(admin, market.id);
      expect(settled.resolvedResult).toBe('YES');
      expect(Date.parse(settled.resolvedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(judged.disputeDeadline ?? ''),
      );

      // --- the approver's detail, left open, follows by itself — read again at the deadline and
      // every 5 s after it (#152), then the settlement's re-reads: 지급 완료, the one step 완료,
      // nothing waiting, the version the approval made, and when the result was confirmed.
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusSettled,
        { timeout: SETTLEMENT_WAIT_MS },
      );
      await expect(secondPage.getByTestId('market-detail-awaiting')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-settlement-step-coin-status')).toHaveText(
        copy.settlementStepStatusDone,
      );
      await expect(secondPage.getByTestId('market-detail-judgement-version')).toContainText(
        `${copy.ruleVersionName}1`,
      );
      await expect(secondPage.getByTestId('market-detail-resolved-at')).toBeVisible();
      await expect(secondPage.getByTestId('market-judgement-current-deadline-note')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-current-badge')).toHaveText(copy.yes);
    } finally {
      await leaveNoJudgement(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }

    // 정산된 시장은 결과만 남긴다. 공개 상세에는 이의 섹션도, 이의 기한(#175 — 잠정 결과 동안만
    // 보인다)·판정 이의 제출 링크·정산 예정 행도 없다. 옛 문구 키는 함께 지워졌으므로 화면에 남은 글자를
    // 직접 확인한다.
    const notice = page.getByTestId('market-status-notice');
    await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
    await expect(page.getByTestId('dispute-section')).toHaveCount(0);
    await expect(notice).not.toContainText('이의');
    // 규칙 as this width draws it (the detail holds one copy per width, ADR-0067).
    await expect(page.getByTestId(detailCopyTestId(page, 'market-rules'))).not.toContainText(
      '정산 예정',
    );
  });
});
