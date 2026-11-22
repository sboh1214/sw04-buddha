import type { APIRequestContext, APIResponse, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  LedgerEntry,
  MySettlement,
  PlaceOrderResult,
  Position,
} from '@buddha/shared';
import { formatCoin } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  SETTLEMENT_WAIT_MS,
  adminAccount,
  accountIdOf,
  approvePauseDecisionAsReviewer,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  expectNoSideScroll,
  judgementEvidenceLink,
  freshEmail,
  inboxOf,
  judgeMarket,
  kstLocalOf,
  leaveNoJudgement,
  markDocument,
  meOf,
  notificationRow,
  onlyNoticeOf,
  openCounted,
  pauseMarket,
  requestPauseDecision,
  resolveWaitMs,
  secondAdminAccount,
  signIn,
  signUp,
  skipUnlessResolvable,
  subscribed,
  test,
  waitForSettled,
  watchThroughApi,
} from './helpers';

/**
 * 마감 · 판정 · 정산 (PLAN 13 M5 AC 7, ADR-0046; since #152, ADR-0103 — ADR-0093 decision 1 #173
 * items 1·5, decision 3 the #152 rows): 한 관리자가 판정을 등록하고 다른 관리자가 승인하면 잠정
 * 결과가 공개되고, 이의 기한이 지나면 워커가 결과를 확정하고 정산한다 — 시장을 보던 탭이 소켓으로
 * 잠정 결과를, 그다음 지급 완료를 받는다(#174의 라벨).
 *
 * The lifecycle case uses the helper's pair. Separate payout cases mint a pair at YES 30 / NO 70
 * and check each member's balance, retired position and own ledger for YES, NO and VOID — and,
 * since #188 (ADR-0160; 52-1, 52-12, 52-15, 188-1), each holder's two 판정·정산 알림: the 잠정 결과
 * and, at the payout, the 최종 정산 with the confirmed result and the member's own payout (0
 * included, 무효 a 지급), whose row opens the settled market; the YES case adds a watcher who
 * holds nothing and reads the sentence without a payout.
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

async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** A result as the detail and the history name it: YES·NO·무효. */
function resultLabelOf(result: MySettlement['result']): string {
  return result === 'VOID' ? copy.marketResultVoid : result === 'YES' ? copy.yes : copy.no;
}

/**
 * 종료 시장의 복기 (#34, ADR-0145; ADR-0135 I1·I3, 결과 4) on a holder's own detail of the market
 * that has just paid out: 내 포지션's block for the contract held — every settlement figure the
 * record's (`GET /me/settlements`), the quantity held then rather than the row's 0, 실현 손익 the
 * row's cumulative one (`GET /me/positions?status=settled`), both times — and nothing of the other
 * holder's contract, no '환불' in the card (other cards name 지급 완료 too, hence the scope), the
 * one fill in 내 거래 with its way to MY's fills, and the round trip through MY's settlement records
 * of this market back to the detail's result (수용 기준 3·7·8·9).
 */
async function expectDetailRecap(
  holderPage: Page,
  market: { id: string; slug: string; title: string },
  outcome: 'YES' | 'NO',
  record: MySettlement,
): Promise<void> {
  const narrow = (holderPage.viewportSize()?.width ?? 0) < 768;
  const positions = await dataOf<Position[]>(
    await holderPage.request.get('/api/v1/me/positions?status=settled'),
  );
  const position = positions.find((row) => row.marketId === market.id && row.outcome === outcome);
  expect(position).toBeDefined();
  await holderPage.goto(`/markets/${market.slug}`);
  const card = holderPage.getByTestId('market-my-position');
  const own = outcome === 'YES' ? 'yes' : 'no';
  const block = card.getByTestId(`market-settled-${own}`);
  const field = (name: string) => block.getByTestId(`market-settled-${name}`);
  await expect(field('result')).toHaveText(resultLabelOf(record.result));
  await expect(field('qty')).toHaveText(`${String(record.qty)}${copy.unitContracts}`);
  await expect(field('cost')).toHaveText(formatCoin(BigInt(record.costBasisCoin)));
  await expect(field('each')).toHaveText(formatCoin(BigInt(record.payoutPerContractCoin)));
  await expect(field('payout')).toHaveText(formatCoin(BigInt(record.payoutCoin)));
  await expect(field('settlement-pnl')).toHaveText(formatCoin(BigInt(record.settlementPnlCoin)));
  await expect(field('realized')).toHaveText(formatCoin(BigInt(position?.realizedPnlCoin ?? '')));
  await expect(field('resolved-at')).toHaveText(formatKst(record.resolvedAt ?? ''));
  await expect(field('settled-at')).toHaveText(formatKst(record.settledAt));
  await expect(card.getByTestId(`market-settled-${own === 'yes' ? 'no' : 'yes'}`)).toHaveCount(0);
  await expect(card).not.toContainText('환불');
  // 내 거래: the one fill, and the way to this market's fills (behind '거래 내역' below md).
  if (narrow) {
    await holderPage
      .getByTestId('market-activity-switch')
      .getByText(copy.marketTradeHistory, { exact: true })
      .click();
  }
  const trades = holderPage.getByTestId('market-my-trades');
  await expect(trades.getByTestId('market-my-trade-detail')).toHaveCount(1);
  await expect(trades.getByTestId('market-history-fills')).toHaveAttribute(
    'href',
    `/my/history?kind=fills&market=${market.id}`,
  );
  if (narrow) await expectNoSideScroll(holderPage);
  // The round trip: this market's records on MY, and from the record's line back to the result.
  await card.getByTestId('market-history-settlements').click();
  const line = holderPage
    .getByTestId('my-settlement-history')
    .getByTestId(`history-settlement-${market.id}-${outcome}`);
  await expect(line).toBeVisible();
  await line.getByRole('link', { name: market.title }).click();
  await expect(holderPage.getByTestId('market-detail-result')).toHaveText(
    resultLabelOf(record.result),
  );
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
      await expect(form.getByTestId('market-judgement-submit')).toBeDisabled();
      await form.getByTestId('market-judgement-confirm-conflict').click();
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
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-approve-confirm-conflict').click();
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

  for (const result of ['YES', 'NO', 'VOID'] as const) {
    test(`${result}: 실제 체결 계약을 정산하고 잔액·손익·지급 원장을 보존한다`, async ({
      admin,
      browser,
      baseURL,
      page,
    }) => {
      test.slow();
      await skipUnlessResolvable(admin);
      // Fresh accounts keep payouts from other tests out of the exact wallet delta below.
      // The holders' pages at this project's width (#124): their history is laid out below.
      const viewport = page.viewportSize();
      const noContext = await browser.newContext({ baseURL, viewport });
      const yesContext = await browser.newContext({ baseURL, viewport });
      // The YES case's watcher, who holds nothing at the payout (#188, 52-1).
      const watcherContext =
        result === 'YES' ? await browser.newContext({ baseURL, viewport }) : null;
      try {
        const noPage = await noContext.newPage();
        const yesPage = await yesContext.newPage();
        expect(yesPage.viewportSize()?.width).toBe(viewport?.width);
        expect(noPage.viewportSize()?.width).toBe(viewport?.width);
        await signUp(noPage, freshEmail());
        await signUp(yesPage, freshEmail());
        const watcherPage = watcherContext === null ? null : await watcherContext.newPage();
        if (watcherPage !== null) await signUp(watcherPage, freshEmail());
        const noHolder = noPage.request;
        const yesHolder = yesPage.request;
        const market = await createOpenMarket(admin);
        if (watcherPage !== null) await watchThroughApi(watcherPage, market.id);
        const order = async (
          context: APIRequestContext,
          outcome: 'YES' | 'NO',
          price: number,
          timeInForce: 'gtc' | 'ioc',
        ) =>
          dataOf<PlaceOrderResult>(
            await context.post(`/api/v1/markets/${market.id}/orders`, {
              headers: { 'Idempotency-Key': crypto.randomUUID() },
              data: {
                expectedAccountId: await accountIdOf(context),
                side: 'buy',
                outcome,
                qty: 2,
                limitPriceCoin: price,
                timeInForce,
              },
            }),
          );
        const rested = await order(noHolder, 'NO', 70, 'gtc');
        expect(rested.order.status).toBe('open');
        const filled = await order(yesHolder, 'YES', 99, 'ioc');
        expect(filled.order.status).toBe('filled');
        const beforeYes = await meOf(yesHolder);
        const beforeNo = await meOf(noHolder);
        await pauseMarket(admin, market.id);
        await requestPauseDecision(admin, market.id, 'early_close', { reviewResult: 'judgeable' });
        expect((await approvePauseDecisionAsReviewer(admin, market.id)).status).toBe('closed');
        const judged = await judgeMarket(admin, market.id, result);
        const settled = await waitForSettled(admin, market.id);
        expect(settled.resolvedResult).toBe(result);
        expect(settled.settlementSteps).toEqual([
          expect.objectContaining({ step: 'coin', status: 'done', lastError: null }),
        ]);

        // 판정·정산 알림 (#188, ADR-0160): each holder heard of the 잠정 결과 once and, at the
        // payout, of the 최종 정산 once — the confirmed result and the member's own payout, 0
        // included, exactly (52-12, 52-15, AC 7, AC 11) — in the owner's sentence (188-1), never a
        // refund (AC 8), and its row opens the settled market (AC 12). The NO holder's fill (#134)
        // and the pause and close (#54) are in the inbox too: notices are found by type.
        const label = resultLabelOf(result);
        const provisionalParams = {
          marketTitle: market.title,
          result,
          disputeDeadline: judged.disputeDeadline,
          judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
        };
        for (const [holderPage, outcome] of [
          [yesPage, 'YES'],
          [noPage, 'NO'],
        ] as const) {
          const payout = result === 'VOID' ? 100n : result === outcome ? 200n : 0n;
          const inbox = await inboxOf(holderPage.request);
          expect(onlyNoticeOf(inbox, 'market_provisional_result').params).toEqual(
            provisionalParams,
          );
          const notice = onlyNoticeOf(inbox, 'market_settled');
          expect(notice).toMatchObject({
            category: 'market',
            target: { kind: 'market', slug: market.slug },
            eventCount: 1,
          });
          expect(notice.params).toEqual({
            marketTitle: market.title,
            result,
            payoutCoin: payout.toString(),
          });
          await openCounted(holderPage, '/my/notifications');
          const row = notificationRow(holderPage, notice.id);
          await expect(row.getByTestId('notification-row-title')).toHaveText(
            `${market.title} 결과 확정: ${label} · 지급 완료 · 내 지급액 ${formatCoin(payout)}`,
          );
          await expect(row).not.toContainText('환불');
          await expect(row).not.toContainText('원금');
          await row.click();
          await expect(holderPage).toHaveURL(`/markets/${market.slug}`);
          await expect(holderPage.getByTestId('market-status-badge')).toHaveText(
            copy.marketStatusSettled,
          );
          await expect(holderPage.getByTestId('market-detail-result')).toHaveText(label);
        }
        if (watcherPage !== null) {
          // The watcher: the same two, the 최종 정산 with no payout (`payoutCoin` null).
          const inbox = await inboxOf(watcherPage.request);
          expect(onlyNoticeOf(inbox, 'market_provisional_result').params).toEqual(
            provisionalParams,
          );
          const notice = onlyNoticeOf(inbox, 'market_settled');
          expect(notice.params).toEqual({
            marketTitle: market.title,
            result: 'YES',
            payoutCoin: null,
          });
          await openCounted(watcherPage, '/my/notifications');
          await expect(
            notificationRow(watcherPage, notice.id).getByTestId('notification-row-title'),
          ).toHaveText(`${market.title} 결과 확정: YES · 지급 완료`);
        }

        for (const [context, outcome, before, cost] of [
          [yesHolder, 'YES', beforeYes, 60n],
          [noHolder, 'NO', beforeNo, 140n],
        ] as const) {
          const payout = result === 'VOID' ? 100n : result === outcome ? 200n : 0n;
          const after = await meOf(context);
          expect(after.balance.availableCoin).toBe(
            (BigInt(before.balance.availableCoin) + payout).toString(),
          );
          expect(after.balance.lockedCoin).toBe('0');
          const positions = await dataOf<Position[]>(
            await context.get('/api/v1/me/positions?status=settled'),
          );
          const position = positions.find(
            (row) => row.marketId === market.id && row.outcome === outcome,
          );
          expect(position).toMatchObject({
            qty: 0,
            costBasisCoin: '0',
            settled: true,
            realizedPnlCoin: (payout - cost).toString(),
          });
          const ledger = await dataOf<LedgerEntry[]>(
            await context.get('/api/v1/me/ledger?limit=100'),
          );
          const payouts = ledger.filter(
            (entry) => entry.kind === 'SETTLEMENT_PAYOUT' && entry.refId === market.id,
          );
          expect(payouts).toHaveLength(payout > 0n ? 1 : 0);
          if (payout > 0n)
            expect(payouts[0]).toMatchObject({ amountCoin: payout.toString(), refType: 'market' });
        }
        // 거래·정산 이력's 정산 (#124, ADR-0143 결정 6): each holder's settlement record as its own
        // history draws it — the winning contract at 100, the losing one kept with a payout of 0,
        // 무효 at 50 each — every figure the record's (`GET /me/settlements`), both times, the way
        // to the judging record, and never called a refund. A fresh account holds one record.
        const resultLabel =
          result === 'VOID' ? copy.marketResultVoid : result === 'YES' ? copy.yes : copy.no;
        for (const [holderPage, outcome, cost] of [
          [yesPage, 'YES', 60n],
          [noPage, 'NO', 140n],
        ] as const) {
          const each = result === 'VOID' ? 50n : result === outcome ? 100n : 0n;
          const payout = each * 2n;
          const records = await dataOf<MySettlement[]>(
            await holderPage.request.get('/api/v1/me/settlements'),
          );
          expect(records).toHaveLength(1);
          const record = records[0];
          expect(record).toMatchObject({
            marketId: market.id,
            outcome,
            result,
            qty: 2,
            costBasisCoin: cost.toString(),
            payoutPerContractCoin: Number(each),
            payoutCoin: payout.toString(),
            settlementPnlCoin: (payout - cost).toString(),
          });
          expect(record?.resolvedAt).not.toBeNull();
          await holderPage.goto('/my/history?kind=settlements');
          const list = holderPage.getByTestId('my-settlement-history');
          const row = list.getByTestId(`history-settlement-${market.id}-${outcome}`);
          await expect(row).toContainText(market.title);
          await expect(row.getByTestId('history-settlement-result')).toHaveText(resultLabel);
          await expect(row.getByTestId('history-settlement-qty')).toHaveText('2계약');
          await expect(row.getByTestId('history-settlement-cost')).toHaveText(formatCoin(cost));
          await expect(row.getByTestId('history-settlement-each')).toHaveText(formatCoin(each));
          await expect(row.getByTestId('history-settlement-payout')).toHaveText(formatCoin(payout));
          await expect(row.getByTestId('history-settlement-pnl')).toHaveText(
            formatCoin(payout - cost),
          );
          await expect(row.getByTestId('history-settlement-resolved-at')).toHaveText(
            formatKst(record?.resolvedAt ?? ''),
          );
          await expect(row.getByTestId('history-settlement-settled-at')).toHaveText(
            formatKst(record?.settledAt ?? ''),
          );
          await expect(row.getByTestId('history-settlement-judging')).toHaveAttribute(
            'href',
            `/markets/${market.slug}#judging-record`,
          );
          await expect(list).not.toContainText('환불');
          await expect(list).not.toContainText('원금');
          if ((viewport?.width ?? 0) < 768) await expectNoSideScroll(holderPage);
          if (result === 'VOID') {
            // 지갑 (#69, ADR-0144): the void market's payout is '정산 지급' — the newest row, linked
            // to that market's settlement records — and nothing on the wallet calls it a refund.
            await holderPage.goto('/my/wallet');
            const ledger = holderPage.getByTestId('ledger-list');
            await expect(ledger.getByTestId('ledger-type').first()).toHaveText(
              copy.ledgerTypeSettlement,
            );
            await expect(ledger.getByTestId('ledger-amount').first()).toHaveText(
              `+${formatCoin(payout)}`,
            );
            // The market is linked although it has ended (acceptance criterion 4: 종료 시장 포함).
            await expect(ledger.getByTestId('ledger-market').first().locator('a')).toHaveAttribute(
              'href',
              `/markets/${market.slug}`,
            );
            await expect(ledger.getByTestId('ledger-settlement-link')).toHaveAttribute(
              'href',
              `/my/history?kind=settlements&market=${market.id}`,
            );
            await expect(holderPage.locator('main')).not.toContainText('환불');
          }
          if (record !== undefined) await expectDetailRecap(holderPage, market, outcome, record);
        }
        await page.goto(`/markets/${market.slug}`);
        await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusSettled);
        await expect(page.getByTestId('market-detail-result')).toHaveText(resultLabel);
        // A visitor (수용 기준 5): the one sign-in prompt, and nothing of anyone's recap.
        await expect(page.getByTestId('market-personal-signed-out')).toHaveCount(1);
        await expect(page.locator('[data-testid^="market-settled-"]')).toHaveCount(0);
        await expect(page.getByTestId('market-my-trades')).toHaveCount(0);
        await expect(page.locator('[data-testid^="market-history-"]')).toHaveCount(0);
        if (result === 'YES') {
          // 보유 계약 (#67, ADR-0142; F4): a paid-out market's holding has left MY's list — once.
          await yesPage.goto('/my/positions');
          await expect(yesPage.getByTestId('portfolio-positions')).toContainText(
            copy.portfolioPositionsEmpty,
          );
          await expect(yesPage.getByTestId(`portfolio-market-${market.id}`)).toHaveCount(0);
        }
      } finally {
        await noContext.close();
        await yesContext.close();
        await watcherContext?.close();
      }
    });
  }
});
