import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  AdminMarketJudgementQueueItem,
  Market,
  MarketSource,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  HELPER_JUDGEMENT_VOID_REASON,
  accountIdOf,
  adminAccount,
  approvePauseDecisionAsReviewer,
  closeMarket,
  createOpenMarket,
  disputeWindowMinutes,
  documentSurvived,
  expect,
  freshTag,
  judgementEvidenceLink,
  kstLocalOf,
  leaveNoJudgement,
  leaveNoPauseDecision,
  markDocument,
  meOf,
  pauseMarket,
  registerJudgement,
  requestPauseDecision,
  retractJudgement,
  secondAdminAccount,
  sendJudgementDecision,
  sendJudgementRegistration,
  signIn,
  subscribed,
  test,
} from './helpers';

/**
 * 판정 등록과 별도 검토자의 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·13,
 * decision 3 the #152 rows): on a CLOSED market's admin detail one admin registers the judgement —
 * the result, the source picked from the rule's (a 대체 출처 with the reason the 1차 출처 could not
 * be used; none for 무효 alone, with its 무효 사유), one to five evidence links, when they were
 * collected (KST, not after now) and what was confirmed — and nothing changes: the market stays
 * 거래 마감 and nothing is published. Its registrant may not decide it — 승인·반려 are off under a
 * note, and the API refuses them — and alone may retract it. It waits in 판정 승인 대기, under 검수
 * 대기, where another admin finds it; before the scheduled judgement both screens warn, and the
 * approver confirms the NO condition's event deadline, shown in the dialog. The approval publishes
 * the 잠정 결과: a visitor's open detail reads it without a reload, with its result and nothing of
 * the judgement's record (#24 shows it, without the admins). A 반려 leaves the market CLOSED for
 * the next registration — by any admin, the one who rejected included, and the first registrant
 * may approve that one. A market closed early as 판정 불가 (#114) is judged 무효 alone. The one-admin
 * 판정 is gone: no button, and its route answers 404. Once PROVISIONAL the panel offers 판정 정정
 * instead, the same registration for the next judgement version (#176), which correction.spec.ts
 * walks.
 *
 * Admin 1 (`admin`) registers the judgements here and admin 2 — `secondAdmin`, or the reviewer
 * `admin` is paired with — decides them, the other way round where a test says so, as on any
 * database with the two seed admins. The dispute window is the 1분 the suite's global setup enters
 * (global-setup.ts); the worker's confirmation after it and the payout are settlement.spec.ts's,
 * and a 잠정 결과 left here is confirmed by the worker meanwhile. A 무효 is registered here and never
 * approved: a confirmed 무효 stays 지급 중 until #126 pays it (ADR-0103), on a database kept between
 * runs.
 *
 * Every refusal's details and order, the records (the `market_judgements` row, the `provisional`
 * and `resolved` events, the admin actions), the database's guard of a judgement, two approvals at
 * once, the undecided window and the public answers' private fields are the API's, the database's
 * and the worker's integration tests (admin-market-judgements.controller.test.ts,
 * private-data.test.ts, packages/db market-judgement.test.ts and schema.test.ts, worker
 * market-resolve.test.ts); the panel, its form and dialogs, the queue and what a refusal says are
 * unit-tested (market-judgement-panel.test.tsx, admin-market-judgements.test.tsx,
 * lib/market-judgement.test.ts). The 판정 승인 대기 list is oldest first, so a database every
 * earlier run has added to may hold a spec's registration past its first page: the list is paged
 * through until it shows (`showInJudgements`), and every test retracts what it left waiting.
 */

const MINUTE_MS = 60 * 1_000;

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

/** The id of the registration waiting on a market. Throws when none waits. */
function pendingOf(market: AdminMarket): string {
  const requestId = market.judgement.pending?.requestId;
  if (requestId === undefined) throw new Error(`no judgement waits on market ${market.id}`);
  return requestId;
}

/** Every request id the 판정 승인 대기 list holds, read through to its last page. */
async function waitingJudgementIds(context: APIRequestContext): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await context.get(`/api/v1/admin/market-judgements?limit=100${after}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketJudgementQueueItem[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((item) => item.requestId));
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return ids;
}

/**
 * Presses 더 보기 on the 판정 승인 대기 list until `row` shows (pause.spec.ts's
 * `showInPauseDecisions`): the list is oldest first, and earlier runs may have left registrations
 * waiting.
 */
async function showInJudgements(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-judgements-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-judgements',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-judgements-more"][data-loading]'),
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

/** The `POST /admin/markets/:id<suffix>` this page sends next: `/judgements`, `/judgements/…`. */
function nextWrite(page: Page, marketId: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}${suffix}`,
  );
}

/** Records the judgement writes about `marketId` the page sends from now on: their paths. */
function judgementWrites(page: Page, marketId: string): string[] {
  const writes: string[] = [];
  const prefix = `/api/v1/admin/markets/${marketId}/judgements`;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST' && pathname.startsWith(prefix)) writes.push(pathname);
  });
  return writes;
}

/**
 * No price, volume, count or holding of the market is drawn in `element`, nor its label (#152 AC
 * 8: the judgement follows the rule's source, never the market's majority) — the labels the admin
 * detail's 거래 현황 and the public detail use.
 */
async function expectNoMarketSignal(element: Locator): Promise<void> {
  for (const label of [
    copy.tradeStatsLastPrice,
    copy.tradeStatsOpenInterestYes,
    copy.tradeStatsOpenInterestNo,
    copy.marketVolume,
    copy.marketTradeCount,
    copy.marketTraderCount,
  ]) {
    await expect(element).not.toContainText(label);
  }
}

test.describe('판정', () => {
  test('한 관리자가 거래 마감 시장의 판정을 화면에서 등록하면 시장은 거래 마감 그대로이고 그 관리자는 승인·반려하지 못하며, 다른 관리자가 판정 승인 대기에서 찾아 NO 조건의 사건 기한을 확인하고 승인하면 방문자의 상세가 리프레시 없이 잠정 결과가 된다', async ({
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
    await closeMarket(admin, market.id);
    const primary = market.ruleItems.primarySource;
    const { eventDeadline, noCondition } = market.ruleItems;
    const { scheduledJudgementAt } = market.times;
    if (primary === null || eventDeadline === null || scheduledJudgementAt === null) {
      throw new Error('unreachable: every spec market has its 1차 출처 and its times');
    }
    const link = judgementEvidenceLink(market.id);
    const secondLink = judgementEvidenceLink(market.id, 2);
    // Collected five minutes ago, to the minute: what the KST `datetime-local` holds.
    const collectedAt = minuteIso(Date.now() - 5 * MINUTE_MS);
    const description = `사건 기한까지 확인 코드가 발표되지 않았음을 1차 출처에서 확인했습니다 ${market.tag}`;
    const approval = `출처와 증거, NO 조건의 사건 기한을 확인했습니다 ${market.tag}`;

    // --- the visitor, signed out, in the market's room first: 거래 마감, no result.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    const badge = page.getByTestId('market-status-badge');
    await expect(badge).toHaveText(copy.marketStatusClosed);
    await expect(page.getByTestId('market-detail-result')).toHaveCount(0);
    await markDocument(page);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1's detail: the 판정 panel of a closed market, no record yet, and no one-admin
      // 판정 (#152: a judgement is registered and another admin approves it).
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-judgement')).toHaveAttribute(
        'data-status',
        'closed',
      );
      await expect(firstPage.getByTestId('market-judgement-log-empty')).toHaveText(
        copy.adminMarketJudgementLogEmpty,
      );
      // The dispute window has a value (global-setup.ts), so nothing says it is undecided.
      await expect(firstPage.getByTestId('market-judgement-window-undecided')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-resolve')).toHaveCount(0);

      // --- 판정 등록: before the scheduled judgement (days out) the form says so, with the time;
      // the rule's one source with its name and address, and 규칙의 출처 없음 for 무효 alone; no
      // market price, volume or count (AC 8).
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-judgement-register').click();
      const form = firstPage.getByTestId('market-judgement-form');
      await expect(form.getByTestId('market-judgement-form-early-at')).toHaveText(
        formatKst(scheduledJudgementAt),
      );
      const primaryChoice = form.getByTestId('market-judgement-source-0');
      await expect(primaryChoice).toContainText(copy.adminMarketJudgementSourcePrimary);
      await expect(primaryChoice).toContainText(primary.name);
      await expect(primaryChoice).toContainText(primary.url);
      await expect(form.getByTestId('market-judgement-source-1')).toHaveCount(0);
      await expect(form.getByTestId('market-judgement-source-none')).toHaveCount(0);
      await expectNoMarketSignal(form);

      // Sent empty, nothing goes: each field says what it lacks.
      const writes = judgementWrites(firstPage, market.id);
      const submit = form.getByTestId('market-judgement-submit');
      await submit.click();
      await expect(form.getByTestId('market-judgement-result-error')).toHaveText(
        copy.errMarketJudgementResult,
      );
      await expect(form.getByTestId('market-judgement-source-error')).toHaveText(
        copy.errMarketJudgementSource,
      );
      await expect(form.getByTestId('market-judgement-link-0-error')).toHaveText(
        copy.errMarketJudgementLink,
      );
      await expect(form.getByTestId('market-judgement-collected-at-error')).toHaveText(
        copy.errMarketJudgementCollectedAtRequired,
      );
      await expect(form.getByTestId('market-judgement-description-error')).toHaveText(
        copy.errMarketJudgementDescription,
      );
      expect(writes).toEqual([]);

      // NO on the 1차 출처, two links — the same one twice is refused under the second — an
      // instant after now refused at once, then five minutes ago, and what was confirmed.
      await form.getByTestId('market-judgement-result-no').click();
      await primaryChoice.click();
      await form.getByTestId('market-judgement-link-0').fill(link);
      await form.getByTestId('market-judgement-link-add').click();
      await form.getByTestId('market-judgement-link-1').fill(link);
      await expect(form.getByTestId('market-judgement-link-1-error')).toHaveText(
        copy.errMarketJudgementLinkDuplicate,
      );
      await form.getByTestId('market-judgement-link-1').fill(secondLink);
      const collected = form.getByTestId('market-judgement-collected-at');
      await collected.fill(kstLocalOf(new Date(Date.now() + 60 * MINUTE_MS).toISOString()));
      await expect(form.getByTestId('market-judgement-collected-at-error')).toHaveText(
        copy.errMarketJudgementCollectedAtAfter,
      );
      await collected.fill(kstLocalOf(collectedAt));
      await form.getByTestId('market-judgement-description').fill(description);
      expect(writes).toEqual([]);
      const registered = nextWrite(firstPage, market.id, '/judgements');
      await submit.click();
      expect((await registered).postDataJSON()).toEqual({
        result: 'NO',
        source: { priority: 0 },
        fallbackReason: null,
        voidReason: null,
        evidence: { links: [link, secondLink], collectedAt },
        description,
        // A first judgement (#176: a 판정 정정 names the version it replaces, correction.spec.ts).
        correction: null,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketJudgementRegistered)).toBeVisible();
      await expect(form).toHaveCount(0);

      // --- waiting: what it says, who registered it and when; its registrant may not decide it
      // (the note says why) and alone may retract it; one waits at a time, and nothing changed.
      await expect(firstPage.getByTestId('market-judgement-pending-by')).toHaveText(firstName);
      await expect(firstPage.getByTestId('market-judgement-pending-result')).toHaveText(copy.no);
      await expect(firstPage.getByTestId('market-judgement-pending-source')).toHaveText(
        `${copy.adminMarketJudgementSourcePrimary} · ${primary.name} (${primary.url})`,
      );
      const links = firstPage.getByTestId('market-judgement-pending-links').getByRole('link');
      await expect(links).toHaveText([link, secondLink]);
      await expect(links.first()).toHaveAttribute('target', '_blank');
      await expect(firstPage.getByTestId('market-judgement-pending-collected-at')).toHaveText(
        formatKst(collectedAt),
      );
      await expect(firstPage.getByTestId('market-judgement-pending-description')).toHaveText(
        description,
      );
      // The rule version it follows: v1, the open's (#80) — no supplement after the close.
      await expect(firstPage.getByTestId('market-judgement-pending-rule-version')).toHaveText(
        `${copy.ruleVersionName}1`,
      );
      await expect(firstPage.getByTestId('market-judgement-pending-early-at')).toHaveText(
        formatKst(scheduledJudgementAt),
      );
      await expect(firstPage.getByTestId('market-judgement-requester-note')).toHaveText(
        copy.adminMarketJudgementExcludedRequester,
      );
      await expect(firstPage.getByTestId('market-judgement-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-judgement-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-judgement-retract')).toBeEnabled();
      await expect(firstPage.getByTestId('market-judgement-register')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-log-0')).toHaveAttribute(
        'data-status',
        'pending',
      );
      await expect(firstPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusClosed,
      );
      const waiting = await adminMarketOf(admin, market.id);
      const requestId = pendingOf(waiting);
      expect(waiting.status).toBe('closed');
      expect(waiting.resolvedResult).toBeNull();
      for (const decision of ['approve', 'reject'] as const) {
        expect(
          await refusalOf(
            await sendJudgementDecision(admin, market.id, requestId, decision, {
              reason: approval,
              ...(decision === 'approve' ? { eventDeadlineConfirmed: true } : {}),
            }),
            409,
            'APPROVAL_NOT_ALLOWED',
          ),
          decision,
        ).toEqual([{ path: ['request'], message: 'requester' }]);
      }
      expect(
        await refusalOf(await sendJudgementRegistration(admin, market.id), 400, 'VALIDATION_ERROR'),
      ).toEqual([{ path: ['judgement'], message: 'pending' }]);
      // Nothing was published: the visitor's detail is as it was.
      await expect(badge).toHaveText(copy.marketStatusClosed);

      // --- admin 2 finds it in 판정 승인 대기, under 검수 대기: the question to its detail, the
      // result, who registered it, and that its scheduled judgement is still ahead.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      expect(await waitingJudgementIds(secondAdmin)).toContain(requestId);
      await secondPage.goto('/admin/markets/reviews');
      await expect(secondPage.getByTestId('admin-market-judgements')).toContainText(
        copy.adminMarketJudgements,
      );
      const row = secondPage.getByTestId(`admin-market-judgement-${requestId}`);
      await showInJudgements(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(secondPage.getByTestId(`admin-market-judgement-result-${requestId}`)).toHaveText(
        copy.no,
      );
      await expect(
        secondPage.getByTestId(`admin-market-judgement-requested-by-${requestId}`),
      ).toHaveText(firstName);
      await expect(secondPage.getByTestId(`admin-market-judgement-early-${requestId}`)).toHaveText(
        copy.adminMarketJudgementsEarly,
      );
      await secondPage.getByTestId(`admin-market-judgement-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- 승인: the NO condition and its event deadline to confirm (before the scheduled
      // judgement), then a reason; the confirm waits for both. No market price, volume or count.
      await expect(secondPage.getByTestId('market-judgement-requester-note')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-retract')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-reject')).toBeEnabled();
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-judgement-approve').click();
      const dialog = secondPage.getByTestId('market-judgement-approve-dialog');
      const confirm = dialog.getByTestId('market-judgement-approve-dialog-confirm');
      await expect(dialog.getByTestId('market-judgement-approve-request')).toContainText(
        `${copy.adminMarketJudgementResult} ${copy.no}`,
      );
      await expect(dialog.getByTestId('market-judgement-approve-no-condition')).toHaveText(
        noCondition,
      );
      await expect(dialog.getByTestId('market-judgement-approve-event-deadline')).toHaveText(
        formatKst(eventDeadline),
      );
      await expectNoMarketSignal(dialog);
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-approve-reason').fill(approval);
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-approve-confirm-deadline').click();
      await expect(confirm).toBeEnabled();
      const approved = nextWrite(secondPage, market.id, `/judgements/${requestId}/approve`);
      await confirm.click();
      expect((await approved).postDataJSON()).toEqual({
        reason: approval,
        eventDeadlineConfirmed: true,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketJudgementApproved)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- 잠정 결과 at once: judgement v1 with the window read at the approval and the deadline it
      // fixed, who registered and who approved it, the confirmation — and its record approved.
      const judged = await adminMarketOf(admin, market.id);
      const current = judged.judgement.current;
      expect(judged.status).toBe('provisional');
      expect(judged.resolvedResult).toBe('NO');
      expect(judged.resolvedAt).toBeNull();
      expect(judged.judgementVersion).toBe(1);
      expect(judged.judgement.pending).toBeNull();
      expect(current).toMatchObject({
        version: 1,
        result: 'NO',
        source: { priority: 0, name: primary.name, url: primary.url },
        evidence: { links: [link, secondLink], collectedAt },
        description,
        ruleVersion: 1,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: await disputeWindowMinutes(admin),
        registeredBy: { id: first.id },
        approvedBy: { id: second.id },
      });
      if (current === null) throw new Error('unreachable');
      expect(judged.disputeDeadline).toBe(current.disputeDeadline);
      expect(Date.parse(current.disputeDeadline) - Date.parse(current.publishedAt)).toBe(
        current.disputeWindowMinutes * MINUTE_MS,
      );
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusProvisional,
      );
      await expect(secondPage.getByTestId('market-judgement')).toHaveAttribute(
        'data-status',
        'provisional',
      );
      await expect(secondPage.getByTestId('market-judgement-pending')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-register')).toHaveCount(0);
      // 판정 정정 in its place, while nothing waits (#176 — correction.spec.ts walks it).
      await expect(secondPage.getByTestId('market-judgement-correct')).toHaveText(
        copy.adminMarketJudgementCorrect,
      );
      await expect(secondPage.getByTestId('market-judgement-current-badge')).toHaveText(copy.no);
      await expect(secondPage.getByTestId('market-judgement-current-deadline')).toHaveText(
        formatKst(current.disputeDeadline),
      );
      const currentRows = secondPage.getByTestId('market-judgement-current-rows');
      await expect(currentRows).toContainText(
        `${copy.adminMarketJudgementRegisteredBy} ${firstName}`,
      );
      await expect(currentRows).toContainText(
        `${copy.adminMarketJudgementApprovedBy} ${secondName}`,
      );
      await expect(currentRows).toContainText(
        `${copy.adminMarketJudgementDeadlineConfirmed} ${copy.adminMarketJudgementDeadlineConfirmedDone}`,
      );
      await expect(secondPage.getByTestId('market-judgement-log-0')).toHaveAttribute(
        'data-status',
        'approved',
      );
      await expect(secondPage.getByTestId('market-detail-judgement-version')).toContainText(
        `${copy.ruleVersionName}1`,
      );
      await expect(secondPage.getByTestId('market-detail-dispute-deadline')).toContainText(
        formatKst(current.disputeDeadline),
      );

      // --- the visitor's detail, never reloaded: 잠정 결과 and its result, and no order area.
      await expect(badge).toHaveText(copy.marketStatusProvisional);
      const notice = page.getByTestId('market-status-notice');
      await expect(notice).toContainText(copy.marketProvisionalNotice);
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.no);
      await expect(page.getByTestId('order-area')).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);
      // The public market says 잠정 결과 and its result, and — since #175 (ADR-0104; #173 item 6:
      // 기한과 접수 링크는 비로그인에게도 보인다) — the judgement version and the 이의 기한 the
      // approval fixed, the link's (dispute.spec.ts walks it), and nothing else of the judgement
      // (#24 shows the record later, without the admins): no evidence, no description, no reason,
      // no request, no admin — in the answer, and in the server's HTML.
      const publicMarket = await publicMarketOf(request, market.id);
      expect(publicMarket.status).toBe('provisional');
      expect(publicMarket.resolvedResult).toBe('NO');
      expect(publicMarket.judgementVersion).toBe(1);
      expect(publicMarket.disputeDeadline).toBe(current.disputeDeadline);
      expect(Object.keys(publicMarket)).not.toContain('judgement');
      const publicBody = await (await request.get(`/api/v1/markets/${market.id}`)).text();
      const html = await (await request.get(`/markets/${market.slug}`)).text();
      for (const hidden of [
        link,
        secondLink,
        description,
        approval,
        requestId,
        first.id,
        second.id,
      ]) {
        expect(publicBody).not.toContain(hidden);
        expect(html).not.toContain(hidden);
      }
    } finally {
      await leaveNoJudgement(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }
  });

  test('다른 관리자가 사유와 함께 반려하면 시장은 거래 마감에 남고, 반려한 관리자가 다시 등록하며, 처음 등록한 관리자가 예정 판정 시각 전이라 사건 기한을 확인하고서야 그 판정을 승인한다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    const rejection = `증거 링크가 1차 출처의 발표가 아닙니다 ${market.tag}`;
    const approval = `다시 등록한 판정의 출처와 증거를 확인했습니다 ${market.tag}`;
    try {
      const registered = await registerJudgement(admin, market.id, {
        description: `처음 등록한 판정입니다 ${market.tag}`,
      });
      const firstRequest = pendingOf(registered);

      // --- 반려 on admin 2's screen: the registration's result in the dialog, then a reason.
      await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      await letToastsGo(page);
      await page.getByTestId('market-judgement-reject').click();
      const dialog = page.getByTestId('market-judgement-reject-dialog');
      const confirm = dialog.getByTestId('market-judgement-reject-dialog-confirm');
      await expect(dialog.getByTestId('market-judgement-reject-request')).toContainText(
        `${copy.adminMarketJudgementResult} ${copy.yes}`,
      );
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-reject-reason').fill(rejection);
      await expect(confirm).toBeEnabled();
      const rejected = nextWrite(page, market.id, `/judgements/${firstRequest}/reject`);
      await confirm.click();
      expect((await rejected).postDataJSON()).toEqual({
        reason: rejection,
        expectedAccountId: second.id,
      });
      await expect(page.getByText(copy.adminMarketJudgementRejected)).toBeVisible();

      // --- still 거래 마감 (#173 item 1): nothing waits, the record says who registered it and why
      // it was rejected, and 판정 등록 is offered again.
      await expect(page.getByTestId('market-detail-status')).toHaveText(copy.marketStatusClosed);
      await expect(page.getByTestId('market-judgement-pending')).toHaveCount(0);
      await expect(page.getByTestId('market-judgement-log-0')).toHaveAttribute(
        'data-status',
        'rejected',
      );
      await expect(page.getByTestId('market-judgement-log-0-status')).toHaveText(
        copy.judgementStatusRejected,
      );
      await expect(page.getByTestId('market-judgement-log-0-by')).toHaveText(
        first.profile.nickname,
      );
      await expect(page.getByTestId('market-judgement-log-0-rows')).toContainText(rejection);
      await expect(page.getByTestId('market-judgement-register')).toBeEnabled();
      // Decided: it is approved by nobody now, and retracted by nobody.
      expect(
        await refusalOf(
          await sendJudgementDecision(secondAdmin, market.id, firstRequest, 'approve', {
            reason: approval,
            eventDeadlineConfirmed: true,
          }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'decided' }]);
      expect(
        await refusalOf(
          await sendJudgementDecision(admin, market.id, firstRequest, 'retract'),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'decided' }]);

      // --- the admin who rejected registers the next one (no exclusion follows a 반려), which its
      // registrant may not approve, and the first registrant may.
      const again = await registerJudgement(secondAdmin, market.id, {
        description: `반려한 관리자가 다시 등록한 판정입니다 ${market.tag}`,
      });
      const secondRequest = pendingOf(again);
      expect(again.judgement.pending?.requestedBy.id).toBe(second.id);
      expect(
        await refusalOf(
          await sendJudgementDecision(secondAdmin, market.id, secondRequest, 'approve', {
            reason: approval,
            eventDeadlineConfirmed: true,
          }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'requester' }]);
      // Before the scheduled judgement an approval without the event deadline confirmed is
      // refused, and nothing moves (decision 3 '등록 시점').
      expect(
        await refusalOf(
          await sendJudgementDecision(admin, market.id, secondRequest, 'approve', {
            reason: approval,
            eventDeadlineConfirmed: false,
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['eventDeadlineConfirmed'], message: 'required' }]);
      const unmoved = await adminMarketOf(admin, market.id);
      expect(unmoved.status).toBe('closed');
      expect(pendingOf(unmoved)).toBe(secondRequest);
      const judged = await dataOf<AdminMarket>(
        await sendJudgementDecision(admin, market.id, secondRequest, 'approve', {
          reason: approval,
          eventDeadlineConfirmed: true,
        }),
      );
      expect(judged.status).toBe('provisional');
      expect(judged.judgement.current).toMatchObject({
        version: 1,
        result: 'YES',
        registeredBy: { id: second.id },
        approvedBy: { id: first.id },
        eventDeadlineConfirmed: true,
      });
      expect(judged.judgement.log.map((entry) => [entry.requestId, entry.status])).toEqual([
        [secondRequest, 'approved'],
        [firstRequest, 'rejected'],
      ]);

      // --- admin 2's detail, read again: the record, newest first.
      await page.reload();
      await expect(page.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusProvisional,
      );
      await expect(page.getByTestId('market-judgement-log-0')).toHaveAttribute(
        'data-status',
        'approved',
      );
      await expect(page.getByTestId('market-judgement-log-0-by')).toHaveText(
        second.profile.nickname,
      );
      await expect(page.getByTestId('market-judgement-log-1')).toHaveAttribute(
        'data-status',
        'rejected',
      );
      await expect(page.getByTestId('market-judgement-current-rows')).toContainText(
        `${copy.adminMarketJudgementApprovedBy} ${first.profile.nickname}`,
      );
    } finally {
      await leaveNoJudgement(admin, market.id);
      await leaveNoJudgement(secondAdmin, market.id);
    }
  });

  test('대체 출처를 고르면 1차 출처를 쓰지 못한 사유를 적어야 하고, 무효는 규칙의 출처 없이 무효 사유와 함께 등록하며, 등록한 관리자는 그 판정을 철회할 수 있다', async ({
    admin,
    page,
  }) => {
    const own = `j${freshTag()}`;
    const fallback: MarketSource = {
      name: `테스트 대체 출처 ${own}`,
      url: `https://example.org/e2e/${own}/fallback`,
    };
    const market = await createOpenMarket(admin, {
      ruleItems: {
        fallbackSources: [fallback],
        fallbackCondition: `1차 출처에 발표가 없으면 대체 출처를 확인합니다. ${own}`,
      },
    });
    await closeMarket(admin, market.id);
    const me = await meOf(admin);
    const link = judgementEvidenceLink(market.id);
    const collectedAt = minuteIso(Date.now() - 5 * MINUTE_MS);
    const description = `두 출처의 공지를 확인했습니다 ${market.tag}`;
    const voidReason = `두 출처가 모두 발표를 멈춰 규칙의 출처로 판정할 수 없습니다 ${market.tag}`;
    try {
      // --- the body's own refusals: a 대체 출처 without its reason, a YES with no source, a 무효
      // without its reason.
      for (const [options, path] of [
        [{ source: { priority: 1 } }, 'fallbackReason'],
        [{ source: null }, 'source'],
        [{ result: 'VOID', voidReason: null }, 'voidReason'],
      ] as const) {
        expect(
          await refusalOf(
            await sendJudgementRegistration(admin, market.id, options),
            400,
            'VALIDATION_ERROR',
          ),
          path,
        ).toEqual([{ path: [path], message: 'required' }]);
      }

      // --- the form: the 대체 출처 with its name and address; picked, it asks for the reason the
      // 1차 출처 could not be used, and nothing goes without one.
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      await letToastsGo(page);
      await page.getByTestId('market-judgement-register').click();
      const form = page.getByTestId('market-judgement-form');
      const fallbackChoice = form.getByTestId('market-judgement-source-1');
      await expect(fallbackChoice).toContainText(`${copy.adminMarketJudgementSourceFallback} 1`);
      await expect(fallbackChoice).toContainText(fallback.name);
      await expect(fallbackChoice).toContainText(fallback.url);
      await form.getByTestId('market-judgement-result-yes').click();
      const fallbackReason = form.getByTestId('market-judgement-fallback-reason');
      await expect(fallbackReason).toHaveCount(0);
      await fallbackChoice.click();
      await expect(fallbackReason).toBeVisible();
      await form.getByTestId('market-judgement-link-0').fill(link);
      await form.getByTestId('market-judgement-collected-at').fill(kstLocalOf(collectedAt));
      await form.getByTestId('market-judgement-description').fill(description);
      const writes = judgementWrites(page, market.id);
      await form.getByTestId('market-judgement-submit').click();
      await expect(form.getByTestId('market-judgement-fallback-reason-error')).toHaveText(
        copy.errMarketJudgementFallbackReason,
      );
      expect(writes).toEqual([]);

      // --- 무효: 규칙의 출처 없음 comes with it; picked, the fallback reason goes and the 무효 사유
      // is asked for.
      await expect(form.getByTestId('market-judgement-source-none')).toHaveCount(0);
      await form.getByTestId('market-judgement-result-void').click();
      const none = form.getByTestId('market-judgement-source-none');
      await expect(none).toContainText(copy.adminMarketJudgementSourceNone);
      await none.click();
      await expect(fallbackReason).toHaveCount(0);
      await form.getByTestId('market-judgement-void-reason').fill(voidReason);
      const registered = nextWrite(page, market.id, '/judgements');
      await form.getByTestId('market-judgement-submit').click();
      expect((await registered).postDataJSON()).toEqual({
        result: 'VOID',
        source: null,
        fallbackReason: null,
        voidReason,
        evidence: { links: [link], collectedAt },
        description,
        correction: null,
        expectedAccountId: me.id,
      });
      await expect(page.getByText(copy.adminMarketJudgementRegistered)).toBeVisible();
      await expect(page.getByTestId('market-judgement-pending-result')).toHaveText(
        copy.marketResultVoid,
      );
      await expect(page.getByTestId('market-judgement-pending-source')).toHaveText(
        copy.adminMarketJudgementSourceNone,
      );
      await expect(page.getByTestId('market-judgement-pending-void-reason')).toHaveText(voidReason);
      await expect(page.getByTestId('market-judgement-pending-fallback-reason')).toHaveCount(0);

      // --- 철회 by its registrant: the market stays 거래 마감 with nothing waiting, the record says
      // so, and 판정 등록 is offered again. (Never approved here: a confirmed 무효 stays 지급 중
      // until #126.)
      const requestId = pendingOf(await adminMarketOf(admin, market.id));
      await letToastsGo(page);
      await page.getByTestId('market-judgement-retract').click();
      const dialog = page.getByTestId('market-judgement-retract-dialog');
      await expect(dialog.getByTestId('market-judgement-retract-request')).toContainText(
        copy.marketResultVoid,
      );
      const retracted = nextWrite(page, market.id, `/judgements/${requestId}/retract`);
      await dialog.getByTestId('market-judgement-retract-dialog-confirm').click();
      expect((await retracted).postDataJSON()).toEqual({ expectedAccountId: me.id });
      await expect(page.getByText(copy.adminMarketJudgementRetracted)).toBeVisible();
      await expect(page.getByTestId('market-judgement-pending')).toHaveCount(0);
      await expect(page.getByTestId('market-judgement-log-0')).toHaveAttribute(
        'data-status',
        'retracted',
      );
      await expect(page.getByTestId('market-judgement-register')).toBeEnabled();
      await expect(page.getByTestId('market-detail-status')).toHaveText(copy.marketStatusClosed);
    } finally {
      await leaveNoJudgement(admin, market.id);
    }
  });

  test('판정 불가로 조기 마감한 시장은 무효로만 등록하고 — 양식이 무효를 미리 고르고 YES·NO를 끄며 까닭을 보이고, 서버도 YES·NO를 거절한다 — 관리자 한 명의 판정 경로는 없다', async ({
    admin,
    page,
  }) => {
    // 실질 기준 변경, reviewed 판정 불가: the 조기 마감 another admin approves (#114, ADR-0102) —
    // no VOID before the close (#173 item 4); the judgement after it applies the VOID rule.
    const market = await createOpenMarket(admin);
    try {
      await pauseMarket(admin, market.id, 'basis_change');
      await requestPauseDecision(admin, market.id, 'early_close', {
        reviewResult: 'not_judgeable',
      });
      expect((await approvePauseDecisionAsReviewer(admin, market.id)).status).toBe('closed');
    } finally {
      await leaveNoPauseDecision(admin, market.id);
    }
    try {
      for (const result of ['YES', 'NO'] as const) {
        expect(
          await refusalOf(
            await sendJudgementRegistration(admin, market.id, { result }),
            400,
            'VALIDATION_ERROR',
          ),
          result,
        ).toEqual([{ path: ['result'], message: 'void only' }]);
      }
      // The one-admin 판정 is gone (#152): its route answers 404, and nothing moved.
      const resolved = await admin.post(`/api/v1/admin/markets/${market.id}/resolve`, {
        data: { result: 'VOID', expectedAccountId: await accountIdOf(admin) },
      });
      expect(resolved.status()).toBe(404);
      expect(((await resolved.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      expect((await adminMarketOf(admin, market.id)).status).toBe('closed');

      // --- the form: 무효 picked from the first draw, YES and NO off, why — with the pause's
      // review — and 규칙의 출처 없음 and the 무효 사유 there at once.
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      await expect(page.getByTestId('market-resolve')).toHaveCount(0);
      await letToastsGo(page);
      await page.getByTestId('market-judgement-register').click();
      const form = page.getByTestId('market-judgement-form');
      const note = form.getByTestId('market-judgement-form-void-only');
      await expect(note).toContainText(copy.adminMarketJudgementVoidOnly);
      await expect(note).toContainText(copy.pauseReviewNotJudgeable);
      await expect(form.getByTestId('market-judgement-result-void')).toHaveAttribute(
        'data-state',
        'checked',
      );
      for (const result of ['yes', 'no']) {
        const item = form.getByTestId(`market-judgement-result-${result}`);
        await expect(item).toHaveAttribute('data-disabled');
        await expect(item).toHaveAttribute('data-state', 'unchecked');
      }
      await expect(form.getByTestId('market-judgement-source-none')).toBeVisible();
      await expect(form.getByTestId('market-judgement-void-reason')).toBeVisible();
      // Closed unsent: nothing waits, and 판정 등록 is there again.
      await form.getByTestId('market-judgement-cancel').click();
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId('market-judgement-register')).toBeEnabled();

      // --- the 무효 the server takes — then retracted, never approved (a confirmed 무효 stays 지급
      // 중 until #126).
      const registered = await registerJudgement(admin, market.id, { result: 'VOID' });
      expect(registered.judgement.pending).toMatchObject({
        result: 'VOID',
        source: null,
        voidReason: HELPER_JUDGEMENT_VOID_REASON,
      });
      expect((await retractJudgement(admin, market.id)).judgement.pending).toBeNull();
    } finally {
      await leaveNoJudgement(admin, market.id);
    }
  });
});

/**
 * The panel, its form and the approval at a phone's width (PLAN 13 M4 AC 5's 375px, pinned here so
 * both projects measure them): a 무효 form with an evidence link of one unbroken word, the waiting
 * registration that holds it, and the approve dialog with its event-deadline confirmation stay
 * inside the screen.
 */
test.describe('판정 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  /** Whether `element` stays inside the screen's width and scrolls nothing sideways itself. */
  async function expectInsideWidth(page: Page, element: Locator): Promise<void> {
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const box = await element.boundingBox();
    if (box === null) throw new Error('the element has no bounding box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const overflow = await element.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test('375px에서 판정 등록 양식, 승인을 기다리는 판정과 승인 창은 가로로 넘치지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    // An evidence link with no place to break but its letters.
    const longLink = `https://example.com/e2e/evidence/${market.id}/${'announcement'.repeat(12)}`;
    try {
      // Admin 2, who may open the form and, once admin 1 has registered, the approval.
      await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
      await page.goto(`/admin/markets/${market.id}`);
      await letToastsGo(page);
      await page.getByTestId('market-judgement-register').click();
      const form = page.getByTestId('market-judgement-form');
      await form.getByTestId('market-judgement-result-void').click();
      await form.getByTestId('market-judgement-source-none').click();
      await form.getByTestId('market-judgement-link-0').fill(longLink);
      await form.getByTestId('market-judgement-link-add').click();
      await expect(form.getByTestId('market-judgement-void-reason')).toBeVisible();
      await expect(form.getByTestId('market-judgement-form-early')).toBeVisible();
      await expectInsideWidth(page, form);
      await form.getByTestId('market-judgement-cancel').click();
      await expect(form).toHaveCount(0);

      await registerJudgement(admin, market.id, { links: [longLink] });
      await page.reload();
      await expect(page.getByTestId('market-judgement-pending-links')).toContainText(longLink);
      await expectInsideWidth(page, page.getByTestId('market-judgement'));
      await letToastsGo(page);
      await page.getByTestId('market-judgement-approve').click();
      const dialog = page.getByTestId('market-judgement-approve-dialog');
      await expect(dialog.getByTestId('market-judgement-approve-deadline')).toBeVisible();
      await expectInsideWidth(page, dialog);
      await dialog.getByTestId('market-judgement-approve-dialog-cancel').click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await leaveNoJudgement(admin, market.id);
    }
  });
});
