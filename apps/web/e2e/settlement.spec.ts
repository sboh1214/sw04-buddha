import { copy } from '../src/copy';
import {
  SETTLEMENT_WAIT_MS,
  adminAccount,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  expect,
  markDocument,
  signIn,
  subscribed,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * 마감 · 판정 · 정산 (PLAN 13 M5 AC 7, ADR-0046): 관리자 판정 → 워커 정산 → 시장을 보던 탭이
 * 소켓으로 정산 완료를 받는다.
 *
 * Nobody holds the market: there is no way to trade until the CLOB lands (#119; D13), so the
 * holder's half of AC 7 — 포트폴리오 정산 이력, 원장 정산 지급 — comes back with the order
 * panel and its screen tests (#189). What stays is the lifecycle every market goes through,
 * holders or not.
 *
 * There is no dispute window to wait out any more: the 판정 is final at once, the API queues the
 * worker's `market.finalize` with no delay, and the market reads `settled` moments later. That
 * makes `resolved` a state of a few seconds at most, so this spec waits for the FINAL `settled`
 * alone and never asserts the badge in between — a 판정 완료 the worker has already moved past
 * would be a flaky assertion, not a finding. The intermediate state is pinned by the API's and
 * the worker's integration tests.
 *
 * The worker itself is still a prerequisite: with its probe disabled (`WORKER_HEALTH_PORT=0`) the
 * config waits for no worker, so the test skips up front rather than wait for a job nobody may
 * be running.
 *
 * Every market is created per run (helpers.ts), and the reader's tab is subscribed before it is
 * navigated, so a transition published while the page loads cannot be lost in the connect gap.
 */

/** Skips the test before it makes a market, when no worker probe exists for the config to wait on. */
function skipWithoutWorkerProbe(): void {
  test.skip(
    workerProbeDisabled(),
    'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
  );
}

test.describe('정산', () => {
  test('AC 7: 관리자 판정 → 즉시 정산 → 상세 배지', async ({ browser, admin, page }) => {
    skipWithoutWorkerProbe();
    const market = await createOpenMarket(admin);

    // --- the reader: subscribed BEFORE the navigation, so the 마감 and 정산 transitions below
    // reach this tab through the socket, not a reload.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await markDocument(page);

    // --- 마감 through the API: trading stops, and the badge says so without a reload.
    await closeMarket(admin, market.id);
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusClosed);

    // --- 판정 through the ADMIN UI (PLAN 12: 결과 선택 → 확인 모달): a second browser signed in
    // as the seed admin, so the reader's tab is untouched. The closed market carries 판정 대기.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await expect(adminPage.getByTestId('market-detail-awaiting')).toHaveText(
        copy.adminMarketAwaitingResolution,
      );
      // No 무효 on the closed market: the admin void and its cost refund are gone (#125,
      // N03 §6), so 판정 is the only way on.
      await expect(adminPage.getByTestId('market-void')).toHaveCount(0);
      // No settlement step exists before the 판정, so the panel is not drawn at all.
      await expect(adminPage.getByTestId('market-settlement-steps')).toHaveCount(0);
      await adminPage.getByTestId('market-resolve').click();
      await expect(adminPage.getByText(copy.adminMarketResolveBody)).toBeVisible();
      await adminPage.getByTestId('market-resolve-yes').click();
      await adminPage.getByTestId('market-resolve-confirm').click();
      await expect(adminPage.getByText(copy.adminMarketResolved)).toBeVisible();
      // The answer already carries the coin step; a judged market offers no second 판정
      // (ADR-0046) and no void (#125).
      await expect(adminPage.getByTestId('market-settlement-steps')).toBeVisible();
      await expect(adminPage.getByTestId('market-resolve')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-void')).toHaveCount(0);

      // --- the reader's tab: 정산 완료 once the worker has settled — through the socket, on the
      // document that was there before the admin pressed anything. Only the final state: the
      // 판정 완료 in between lasts as long as the worker takes (see the file comment).
      await expect(badge).toHaveText(copy.marketStatusSettled, { timeout: SETTLEMENT_WAIT_MS });
      expect(await documentSurvived(page), page.url()).toBe(true);
      await expect(page.getByTestId('market-status-notice-detail')).toHaveText(
        copy.marketSettledPayout,
      );

      // --- the admin's 정산 단계, read again: the one step is 완료 and nothing is waiting.
      await adminPage.reload();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusSettled,
      );
      await expect(adminPage.getByTestId('market-detail-awaiting')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-settlement-step-coin-status')).toHaveText(
        copy.settlementStepStatusDone,
      );
    } finally {
      await adminContext.close();
    }

    // 정산된 시장은 결과만 남긴다. 이의 단계가 없으므로(ADR-0046) 이의 섹션도, 이의 마감·정산 예정
    // 행도 없다. 문구 키는 함께 지워졌으므로 화면에 남은 글자를 직접 확인한다.
    const notice = page.getByTestId('market-status-notice');
    await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
    await expect(page.getByTestId('dispute-section')).toHaveCount(0);
    await expect(notice).not.toContainText('이의');
    await expect(page.getByTestId('market-rules')).not.toContainText('정산 예정');
  });
});
