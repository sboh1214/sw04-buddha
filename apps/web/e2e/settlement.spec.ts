import { copy } from '../src/copy';
import {
  SETTLEMENT_WAIT_MS,
  adminAccount,
  buyThroughPanel,
  chargeOnce,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  ensureChargePackage,
  expect,
  freshEmail,
  markDocument,
  signIn,
  signUp,
  subscribed,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * 마감 · 판정 · 정산 (PLAN 13 M5 AC 7, ADR-0046): 관리자 판정 → 워커 정산 → 보유자 탭이 소켓으로
 * 정산 완료를 받는다 → 포트폴리오 정산 이력 · 리더보드 · 원장 정산 지급.
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

/** U+2212, the sign `formatP` writes a loss with (PLAN 11.1-6). A literal: e2e imports no values from shared. */
const MINUS_SIGN = '−';

/** Skips the test before it makes a market, when no worker probe exists for the config to wait on. */
function skipWithoutWorkerProbe(): void {
  test.skip(
    workerProbeDisabled(),
    'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
  );
}

test.describe('정산', () => {
  test('AC 7: 관리자 판정 → 즉시 정산 → 상세 배지 · 포트폴리오 실현 손익 · 원장 정산 지급', async ({
    browser,
    admin,
    page,
  }) => {
    skipWithoutWorkerProbe();
    const market = await createOpenMarket(admin);
    await ensureChargePackage(admin);

    // --- the holder: 가입 → 충전 → 매수 예 5,000P. Subscribed BEFORE the navigation, so the
    // 마감 and 정산 transitions below reach this tab through the socket, not a reload.
    await signUp(page, freshEmail());
    await chargeOnce(page);
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await buyThroughPanel(page, 'YES', '5000');
    await markDocument(page);

    // A second tab of the SAME account parked on 지갑 before anything is judged. The payout's
    // `user:balance` moves the balance chip there through the socket, but a `LedgerEntry` cannot
    // be built from that event — it carries the id of the row and none of its columns — so the
    // 정산 지급 row is only ever a refetch. Parked here rather than visited at the end, because
    // a `goto` would fetch the ledger anyway and prove nothing about the live path.
    const wallet = await page.context().newPage();
    await wallet.goto('/wallet');
    await expect(wallet.getByTestId('ledger-list')).toBeVisible();
    await markDocument(wallet);

    // --- 마감 through the API: trading stops, and the badge says so without a reload.
    await closeMarket(admin, market.id);
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusClosed);

    // --- 판정 through the ADMIN UI (PLAN 12: 결과 선택 → 확인 모달): a second browser signed in
    // as the seed admin, so the holder's tab is untouched. The closed market carries 판정 대기.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await expect(adminPage.getByTestId('market-detail-awaiting')).toHaveText(
        copy.adminMarketAwaitingResolution,
      );
      // No settlement step exists before the 판정, so the panel is not drawn at all.
      await expect(adminPage.getByTestId('market-settlement-steps')).toHaveCount(0);
      await adminPage.getByTestId('market-resolve').click();
      await expect(adminPage.getByText(copy.adminMarketResolveBody)).toBeVisible();
      await adminPage.getByTestId('market-resolve-yes').click();
      await adminPage.getByTestId('market-resolve-confirm').click();
      await expect(adminPage.getByText(copy.adminMarketResolved)).toBeVisible();
      // The answer already carries the coin step; a judged market offers neither a second
      // 판정 nor a void (ADR-0046).
      await expect(adminPage.getByTestId('market-settlement-steps')).toBeVisible();
      await expect(adminPage.getByTestId('market-resolve')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-void')).toHaveCount(0);

      // --- the holder's tab: 정산 완료 once the worker has settled — through the socket, on the
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

    // --- 포트폴리오: the holding moved to 정산 이력 with a positive 실현 손익 — 예 won, and a
    // winning contract pays 100P against a cost of well under that.
    await page.goto('/portfolio');
    const settledRow = page.getByTestId(`portfolio-settled-${market.id}-YES`);
    await expect(settledRow).toBeVisible({ timeout: SETTLEMENT_WAIT_MS });
    await expect(settledRow).toContainText(copy.positionRealizedPnl);
    const realized = new RegExp(`${copy.positionRealizedPnl}\\s*([${MINUS_SIGN}\\d,]+)P`).exec(
      (await settledRow.textContent()) ?? '',
    );
    expect(realized, '실현 손익 row').not.toBeNull();
    const amount = realized?.[1] ?? '';
    expect(amount.startsWith(MINUS_SIGN), amount).toBe(false);
    expect(amount, amount).not.toBe('0');

    // --- 리더보드(M6 선택): the same realized figure, now in the public ranking. Reached the way
    // a reader reaches it — the link this screen carries.
    //
    // The assertion is "on the board, OR beaten by twenty", not "on the board": the ranking is
    // GLOBAL and the development database this suite runs against accumulates every account
    // every previous run created, all of which realized the same 3,958P from the same fixture.
    // A run that demanded its own nickname in the top 20 would pass on a fresh database and fail
    // on a used one — which is exactly what it did the first time. What is always true is that a
    // board of twenty is either short enough to include this account or entirely made of
    // accounts that did at least as well.
    const me = (await (await page.request.get('/api/v1/me')).json()) as {
      data: { profile: { nickname: string } };
    };
    await page.getByRole('link', { name: copy.leaderboardLink }).click();
    await expect(page).toHaveURL(/leaderboard$/);
    const board = page.getByTestId('leaderboard-table');
    await expect(board).toBeVisible();
    const rows = board.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount, 'the board has rows').toBeGreaterThan(0);
    expect(rowCount, 'at most LEADERBOARD_LIMIT rows').toBeLessThanOrEqual(20);
    // Descending, densely ranked: what the service promises, read out of the rendered table.
    const amounts: number[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      const cells = rows.nth(i).locator('td');
      await expect(cells.nth(0)).toHaveText(String(i + 1));
      // The MINUS_SIGN goes to an ASCII one BEFORE the strip: `[^\d-]` keeps a hyphen, and
      // U+2212 is not one, so a loss came through as its own absolute value. Losses are on
      // this board by contract — the service leaves out only a zero (`having(ne(total, 0))`,
      // "Losses stay in") — so a parse that drops the sign checks the order of ABSOLUTE
      // values, which is neither necessary nor sufficient for the one the service promises:
      // it fails a correctly ordered board with two different losses on it, and passes one
      // ordered −900P before −100P.
      const cell = ((await cells.nth(2).textContent()) ?? '').replaceAll(MINUS_SIGN, '-');
      amounts.push(Number(cell.replace(/[^\d-]/g, '')));
    }
    expect(
      [...amounts].sort((a, b) => b - a),
      'ordered by realized P&L',
    ).toEqual(amounts);

    const mine = await board.getByText(me.data.profile.nickname).count();
    if (mine === 0) {
      const realizedP = Number(amount.replace(/[^\d]/g, ''));
      expect(
        amounts.at(-1) ?? 0,
        'off the board only because twenty accounts did as well or better',
      ).toBeGreaterThanOrEqual(realizedP);
    }

    // --- 지갑: the payout is a 정산 지급 ledger row, and it reaches the tab that was ALREADY
    // there — no navigation, no reload. The balance chip moved on the event itself; this row is
    // the refetch the event triggers, because nothing in a `user:balance` can draw a ledger row.
    await expect(wallet.getByText(copy.ledgerTypeSettlement).first()).toBeVisible({
      timeout: SETTLEMENT_WAIT_MS,
    });
    expect(await documentSurvived(wallet), wallet.url()).toBe(true);
    await wallet.close();
  });
});
