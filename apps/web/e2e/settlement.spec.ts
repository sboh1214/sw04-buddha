import type { APIRequestContext } from '@playwright/test';
import type { AdminDispute, AdminMarket } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  DISPUTE_WINDOW_WAIT_MAX_MS,
  adminAccount,
  buyThroughPanel,
  chargeOnce,
  closeMarket,
  createOpenMarket,
  disputeWindowMs,
  documentSurvived,
  ensureChargePackage,
  expect,
  freshEmail,
  markDocument,
  resolveMarket,
  signIn,
  signUp,
  subscribed,
  test,
  workerProbeDisabled,
} from './helpers';

/**
 * 마감 · 정산 · 이의 (PLAN 13 M5): AC 7 — 관리자 정산 제안 → 이의 기간 → 워커 확정 → 잔고·포트폴리오
 * ·원장 — and the dispute round trip PLAN 5.5 describes (제기 → 관리자 기각 + 메모 → 제기자에게
 * 보임).
 *
 * Both tests wait out a REAL dispute window: the worker's `market.finalize` job is scheduled at
 * `disputeUntil`, and nothing in the product can shorten it. The API's window is
 * `TEST_DISPUTE_WINDOW_SECONDS` (default a day), so each test reads the window off the market it
 * resolved and SKIPS — naming the variable — rather than time out on a stack that was not
 * configured for it. CI runs the API with `TEST_DISPUTE_WINDOW_SECONDS=8`. The same goes for
 * the worker itself: with its probe disabled (`WORKER_HEALTH_PORT=0`) the config waits for no
 * worker, so both tests skip up front rather than wait for a job nobody may be running.
 *
 * Every market is created per run (helpers.ts), and the reader's tab is subscribed before it is
 * navigated, so a transition published while the page loads cannot be lost in the connect gap.
 */

/** U+2212, the sign `formatP` writes a loss with (PLAN 11.1-6). A literal: e2e imports no values from shared. */
const MINUS_SIGN = '−';

/** The evidence a dispute carries; a real URL, because the form asks the API's own rule. */
const EVIDENCE_URL = 'https://example.com/e2e-evidence';

/** `GET /admin/markets/:id` — the row with `resolvedAt`/`disputeUntil`, after the dialog resolved it. */
async function adminMarket(admin: APIRequestContext, marketId: string): Promise<AdminMarket> {
  const response = await admin.get(`/api/v1/admin/markets/${marketId}`);
  const body = await response.text();
  if (!response.ok()) throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  return (JSON.parse(body) as { data: AdminMarket }).data;
}

/** `GET /admin/disputes?marketId=` — the one dispute the spec filed, by its id. */
async function disputesOf(admin: APIRequestContext, marketId: string): Promise<AdminDispute[]> {
  const response = await admin.get(`/api/v1/admin/disputes?marketId=${marketId}`);
  const body = await response.text();
  if (!response.ok()) throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  return (JSON.parse(body) as { data: AdminDispute[] }).data;
}

/** Skips the test, naming the env var, when the stack's window is longer than a spec may wait. */
function skipUnlessShortWindow(windowMs: number): void {
  test.skip(
    windowMs > DISPUTE_WINDOW_WAIT_MAX_MS,
    `the dispute window is ${String(Math.round(windowMs / 1000))}s: set TEST_DISPUTE_WINDOW_SECONDS=8 for the API`,
  );
}

/** Skips the test before it makes a market, when no worker probe exists for the config to wait on. */
function skipWithoutWorkerProbe(): void {
  test.skip(
    workerProbeDisabled(),
    'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker',
  );
}

test.describe('정산', () => {
  test('AC 7: 정산 제안 → 이의 기간 → 자동 확정 → 상세 배지 · 포트폴리오 실현 손익 · 원장 정산 지급', async ({
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

    // A second tab of the SAME account parked on 지갑 before anything is resolved. The payout's
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

    // --- 정산 제안 through the ADMIN UI (PLAN 12: 결과 선택 → 확인 모달): a second browser
    // signed in as the seed admin, so the holder's tab is untouched.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await adminPage.getByTestId('market-resolve').click();
      await adminPage.getByTestId('market-resolve-yes').click();
      await adminPage.getByTestId('market-resolve-confirm').click();
      await expect(adminPage.getByText(copy.adminMarketResolved)).toBeVisible();
    } finally {
      await adminContext.close();
    }

    // The window the API is configured with, read off the market the dialog just resolved.
    const windowMs = disputeWindowMs(await adminMarket(admin, market.id));
    skipUnlessShortWindow(windowMs);

    // --- the holder's tab: 정산 중 now, 정산 완료 once the worker has finalized — through the
    // socket, on the document that was there before the admin pressed anything.
    await expect(badge).toHaveText(copy.marketStatusResolving);
    await expect(page.getByTestId('market-detail-result')).toHaveText(copy.yes);
    await expect(badge).toHaveText(copy.marketStatusSettled, { timeout: windowMs + 15_000 });
    expect(await documentSurvived(page), page.url()).toBe(true);
    await expect(page.getByTestId('market-status-notice-detail')).toHaveText(
      copy.marketSettledPayout,
    );

    // 확정된 시장은 결과만 남기고 이의 마감·정산 예정을 지운다. `dispute_until`은 행에도 DTO에도
    // 그대로 남아 있고(확정은 제안을 버리는 것이 아니라 완성한다) 관리자 상세가 감사 행으로 읽는다
    // — 잠근 것은 열이 아니라 공개 화면이다. 확정은 종료 상태라 이의 기간과 경주하지 않는다.
    const notice = page.getByTestId('market-status-notice');
    await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
    await expect(notice).not.toContainText(copy.marketDisputeUntil);
    await expect(page.getByTestId('market-rules')).not.toContainText(copy.rulesSettlement);

    // --- 포트폴리오: the holding moved to 정산 이력 with a positive 실현 손익 — 예 won, and a
    // winning contract pays 100P against a cost of well under that.
    await page.goto('/portfolio');
    const settledRow = page.getByTestId(`portfolio-settled-${market.id}-YES`);
    await expect(settledRow).toBeVisible({ timeout: windowMs + 15_000 });
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
      amounts.push(Number(((await cells.nth(2).textContent()) ?? '').replace(/[^\d-]/g, '')));
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
      timeout: windowMs + 15_000,
    });
    expect(await documentSurvived(wallet), wallet.url()).toBe(true);
    await wallet.close();
  });
});

test.describe('이의', () => {
  test('제기 → 접수됨 → 관리자 기각 + 메모 → 제기자 상세에 보인다', async ({
    browser,
    admin,
    page,
  }) => {
    skipWithoutWorkerProbe();
    const market = await createOpenMarket(admin);

    // A signed-in reader on the detail BEFORE the result is proposed: the section is absent for
    // a closed market, appears on the `market:status` the resolve publishes, and the whole
    // window budget is left for the dialog — which is why this test resolves via the API.
    await signUp(page, freshEmail());
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await closeMarket(admin, market.id);
    await expect(page.getByTestId('dispute-section')).toHaveCount(0);

    const resolved = await resolveMarket(admin, market.id, 'YES');
    const windowMs = disputeWindowMs(resolved);
    // Filing goes through a dialog, which the shortest window CI could set must leave room for.
    test.skip(
      windowMs < 5_000,
      `the dispute window is ${String(windowMs)}ms: too short to file through the dialog`,
    );

    // --- 이의 제기: the button, the dialog, the toast, then the filed block in its place.
    await page.getByTestId('dispute-open').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('dispute-reason').fill('정산 기준의 출처와 다른 결과입니다.');
    await dialog.getByTestId('dispute-evidence').fill(EVIDENCE_URL);
    await dialog.getByTestId('dispute-submit').click();
    await expect(page.getByText(copy.disputeFiled)).toBeVisible();
    const filed = page.getByTestId('dispute-filed');
    await expect(filed).toBeVisible();
    await expect(filed.getByTestId('dispute-status')).toHaveText(copy.disputeStatusOpen);
    await expect(filed.getByTestId('dispute-filed-evidence')).toHaveAttribute('href', EVIDENCE_URL);
    await expect(page.getByTestId('dispute-open')).toHaveCount(0);

    // One per account per market: a fresh load reads the row back and offers no second button.
    // This holds after the worker has finalized as well — a finished market keeps the card for
    // the account that filed (design 5.3).
    await page.reload();
    await expect(page.getByTestId('dispute-filed')).toBeVisible();
    await expect(page.getByTestId('dispute-open')).toHaveCount(0);

    // --- 관리자: the dispute is listed under its market, and 기각 with a note is a two-step
    // review that changes NO result (PLAN 12).
    const [dispute] = await disputesOf(admin, market.id);
    if (dispute === undefined) throw new Error('the filed dispute is missing from the admin list');
    const note = `근거 URL이 정산 기준의 출처가 아닙니다 ${market.tag}`;
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/disputes?marketId=${market.id}`);
      await expect(adminPage.getByTestId(`admin-dispute-${dispute.id}`)).toBeVisible();
      await adminPage.getByTestId(`admin-dispute-reject-${dispute.id}`).click();
      await adminPage.getByTestId('dispute-review-note').fill(note);
      await adminPage.getByTestId('dispute-review-confirm').click();
      await expect(adminPage.getByText(copy.adminDisputeReviewed)).toBeVisible();
    } finally {
      await adminContext.close();
    }

    // --- 제기자: the review reaches the detail on its next fetch — no event carries a dispute
    // (PLAN 8), so a reload is the honest way to ask again.
    await page.reload();
    const reviewed = page.getByTestId('dispute-filed');
    await expect(reviewed).toBeVisible();
    await expect(reviewed.getByTestId('dispute-status')).toHaveText(copy.disputeStatusRejected);
    await expect(reviewed.getByTestId('dispute-admin-note')).toHaveText(note);
  });
});
