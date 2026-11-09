import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  Market,
  MarketJudgementCorrectedPayload,
  MarketResolvedByDeadlinePayload,
  MyMarketDispute,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  HELPER_CORRECTION_REASON,
  HELPER_JUDGEMENT_DESCRIPTION,
  accountIdOf,
  adminAccount,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  expect,
  freshEmail,
  judgeMarket,
  judgementEvidenceLink,
  kstLocalOf,
  leaveNoCorrection,
  leaveNoJudgement,
  markDocument,
  meOf,
  recordJudgementDelay,
  registerCorrection,
  secondAdminAccount,
  sendJudgementDecision,
  sendJudgementRegistration,
  signIn,
  signUp,
  skipUnlessResolvable,
  subscribed,
  test,
  waitForResolved,
  waitPast,
} from './helpers';

/**
 * 판정 정정 (#176, ADR-0105; ADR-0093 decision 1 #173 items 1·2·5·7·8·13, decision 3 '#176 정정
 * 대기'): while a market is 잠정 결과, its 판정 panel offers 판정 정정 — the registration form
 * prefilled with the current judgement, a 정정 사유 beside it, refused on screen and by the API
 * while it changes neither the result nor its grounds. One admin registers it and nothing changes:
 * the version, its result and its 이의 기한 stand, and its registrant may not decide it. Another
 * admin finds it in 판정 승인 대기, marked as a correction, and approves it: the judgement version
 * goes up by one, the new result is the 잠정 결과 at once and a new 이의 기한 of the first one's
 * length runs from the approval (#173 item 5) — a visitor's open detail follows without a reload,
 * the replaced version stays in the 판정 버전 이력, a member's dispute must name the new version, and
 * the worker confirms the new result at the new deadline. A correction left waiting holds the
 * market past its deadline — 판정 지연 on the public detail, the admin detail saying why — so any
 * admin may leave it a 판정 지연 기록 (#142, ADR-0106), whose reason the public detail then shows
 * under the result, and its 반려 carries on with the version as it was: the worker confirms it
 * within seconds, and the record stays as v1's history (delay.spec.ts walks the record on a
 * 거래 마감 market, its 갱신 대기 and a second record). A confirmed market takes no correction
 * (#173 item 8). No correction is made to 무효 here, nor a 무효 approved: a confirmed 무효 stays
 * 지급 중 until #126 pays it (ADR-0103), on a database kept between runs.
 *
 * Admin 1 (`admin`) judges the market and registers the correction, admin 2 — `secondAdmin`, the
 * reviewer `admin` is paired with — approves the judgement (`judgeMarket`) and decides the
 * correction, on any database with the two seed admins. The dispute window is the 1분 the suite's
 * global setup enters (global-setup.ts): every screen is opened once before the judgement, and the
 * correction is registered within that minute — at its deadline the worker confirms a market
 * nothing holds, and a confirmed one takes no correction. Both tests wait for the worker, so they
 * skip on a database with a longer window or with no worker probe (`skipUnlessResolvable`).
 *
 * No member submits a 판정 이의 (only the helper's own members trade on a market a spec judges, and
 * they never dispute — dispute.spec.ts): a correction from an accepted dispute, the pending
 * disputes it closes as 정정으로 종결, the accepted ones a rejected or retracted correction sends back
 * to 검토 중, a second dispute on the corrected version, the
 * refusals' order and the records (the `market_judgements` row with its reason, the
 * `judgement_corrected` event, the admin actions, the hold and the old deadline's job) are the
 * API's, the database's and the worker's integration tests (admin-market-judgements.controller
 * .test.ts, private-data.test.ts, packages/db market-judgement.test.ts and
 * market-dispute.test.ts, worker market-resolve.test.ts); the panel, its form and dialogs, the
 * queue's marker and the MY notes are unit-tested (market-judgement-panel.test.tsx,
 * market-dispute-panel.test.tsx, admin-market-judgements.test.tsx, my-disputes.test.tsx). Every
 * market is created per run, every correction left waiting is retracted in a `finally`
 * (`leaveNoCorrection`) and every browser context a test opens is closed there.
 */

const MINUTE_MS = 60 * 1_000;

/**
 * How long past the 이의 기한 a spec lets the worker's delayed `market.resolve` run before it asks
 * whether the market is still held: the job at the deadline answers within a second or two.
 */
const HELD_SLACK_MS = 10_000;

/**
 * How long a 반려 past the deadline gives the worker to confirm. The e2e shows only that the
 * confirmation follows the 반려 promptly: the per-minute scan lands inside this window about half the
 * time, so it cannot tell the API's immediate `market.resolve` (ADR-0105, as the last 기각 queues
 * one, ADR-0104) from the scan. That job is pinned by the API's integration test
 * (admin-market-judgements.controller.test.ts).
 */
const CONFIRM_AFTER_REJECTION_MS = 30_000;

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

/** DISPUTE_NOT_ALLOWED's `details.reason`, once the answer is that 409. */
async function disputeRefusalOf(response: APIResponse): Promise<string> {
  const body = await response.text();
  expect(response.status(), body).toBe(409);
  const { error } = JSON.parse(body) as { error: { code: string; details: { reason: string } } };
  expect(error.code, body).toBe('DISPUTE_NOT_ALLOWED');
  return error.details.reason;
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

/** The current judgement of a judged market. Throws before one. */
function currentOf(market: AdminMarket): NonNullable<AdminMarket['judgement']['current']> {
  const current = market.judgement.current;
  if (current === null) throw new Error(`market ${market.id} has no judgement`);
  return current;
}

/** The market's newest event of `type` (`AdminMarket.events` is newest first). */
function eventOf(market: AdminMarket, type: AdminMarket['events'][number]['type']) {
  const event = market.events.find((entry) => entry.type === type);
  if (event === undefined) throw new Error(`market ${market.id} has no ${type} event`);
  return event;
}

/** A correction's move between judgement versions as the screens write it: 'v1 → v2'. */
function versionMove(from: number): string {
  return `${copy.ruleVersionName}${String(from)} → ${copy.ruleVersionName}${String(from + 1)}`;
}

/**
 * `POST /markets/:id/disputes` as the member `context` is signed in as: one link and a reason,
 * the version given and the account it names (ADR-0092), the answer as it came.
 */
async function sendDispute(
  context: APIRequestContext,
  marketId: string,
  judgementVersion: number,
): Promise<APIResponse> {
  return context.post(`/api/v1/markets/${marketId}/disputes`, {
    data: {
      judgementVersion,
      links: [`https://example.com/e2e/dispute/${marketId}/1`],
      reason: '잠정 결과가 1차 출처의 발표와 다릅니다.',
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/** The member's standing on the market (`GET /me/disputes/markets/:marketId`). */
async function standingOf(context: APIRequestContext, marketId: string): Promise<MyMarketDispute> {
  return dataOf<MyMarketDispute>(await context.get(`/api/v1/me/disputes/markets/${marketId}`));
}

/**
 * Presses 더 보기 on the 판정 승인 대기 list until `row` shows (judgement.spec.ts'
 * `showInJudgements`): the list is oldest first, and earlier runs may have left registrations
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

test.describe('판정 정정', () => {
  test('잠정 결과인 시장에서 한 관리자가 지금 판정으로 채운 판정 정정 양식에 결과와 근거, 정정 사유를 적어 등록하면 아무것도 바뀌지 않고 그 관리자는 승인하지 못하며, 다른 관리자가 판정 승인 대기에서 찾아 승인하면 판정 v2와 새 결과가 공개되고 첫 이의 기한과 같은 길이의 새 이의 기한이 승인한 때부터 흐르며, 방문자의 상세가 리프레시 없이 따르고 회원의 이의는 v2를 대야 하며, 새 기한이 지나면 워커가 v2로 확정하고 확정한 시장은 정정하지 못한다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    // A dispute window waited out after the correction's approval, then the worker's confirmation.
    test.slow();
    await skipUnlessResolvable(admin);
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const firstName = first.profile.nickname;
    const secondName = second.profile.nickname;
    const memberContext = await browser.newContext();
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    let marketId: string | null = null;
    try {
      // --- before the judgement, everything that takes time: a member signed up (no fill on
      // this market), both admins' browsers signed in, the market closed, and every
      // screen the minute needs opened once.
      const memberPage = await memberContext.newPage();
      await signUp(memberPage, freshEmail());
      // Read once now, so no submission in the minute below waits for `GET /me`.
      await accountIdOf(memberPage.request);
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      const market = await createOpenMarket(admin);
      marketId = market.id;
      await closeMarket(admin, market.id);
      const { scheduledJudgementAt } = market.times;
      if (scheduledJudgementAt === null) {
        throw new Error('unreachable: every spec market has its scheduled judgement');
      }
      const link = judgementEvidenceLink(market.id);
      const secondLink = judgementEvidenceLink(market.id, 2);
      const reason = `1차 출처가 확인 코드의 발표를 정정했습니다 ${market.tag}`;
      const description = `1차 출처의 정정 공지에서 확인 코드가 없었음을 확인했습니다 ${market.tag}`;
      const approval = `정정 공지와 새 증거, NO 조건의 사건 기한을 확인했습니다 ${market.tag}`;
      const screenPath = `/markets/${market.slug}/dispute`;

      // A CLOSED market takes no correction — it has no 잠정 결과 to correct (#173 item 8) — and
      // its panel offers none.
      expect(
        await refusalOf(
          await sendJudgementRegistration(admin, market.id, {
            correction: { baseVersion: 1, reason },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['status'], message: 'not provisional' }]);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-judgement-register')).toBeVisible();
      await expect(firstPage.getByTestId('market-judgement-correct')).toHaveCount(0);
      await secondPage.goto('/admin/markets/reviews');
      await expect(secondPage.getByTestId('admin-market-judgements')).toBeVisible();
      await memberPage.goto(screenPath);
      await expect(memberPage.getByTestId('dispute-closed')).toHaveAttribute(
        'data-reason',
        'not_provisional',
      );
      // The visitor, signed out, in the market's room.
      const joined = subscribed(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      await joined;
      const badge = page.getByTestId('market-status-badge');
      await expect(badge).toHaveText(copy.marketStatusClosed);
      await markDocument(page);

      // --- judgement v1, YES: the minute starts, and the correction is registered within it.
      const judged = await judgeMarket(admin, market.id);
      const v1 = currentOf(judged);
      const deadline = v1.disputeDeadline;
      const notice = page.getByTestId('market-status-notice');
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);

      // The API's own refusals of a correction (#173 items 7·8): a version that is not the current
      // one, a first judgement on a 잠정 결과, and one that changes nothing of v1 — the same result,
      // source, links, collection instant and description (dismiss the dispute instead).
      expect(
        await refusalOf(
          await sendJudgementRegistration(admin, market.id, {
            result: 'NO',
            correction: { baseVersion: 2, reason },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['correction', 'baseVersion'], message: 'stale' }]);
      expect(
        await refusalOf(await sendJudgementRegistration(admin, market.id), 400, 'VALIDATION_ERROR'),
      ).toEqual([{ path: ['status'], message: 'not closed' }]);
      expect(
        await refusalOf(
          await sendJudgementRegistration(admin, market.id, {
            result: v1.result,
            links: v1.evidence.links,
            collectedAt: v1.evidence.collectedAt,
            description: v1.description,
            correction: { baseVersion: 1, reason },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['correction'], message: 'unchanged' }]);

      // --- admin 1's detail, read again: 잠정 결과, 판정 정정 in 판정 등록's place, no history yet.
      await firstPage.reload();
      await expect(firstPage.getByTestId('market-judgement')).toHaveAttribute(
        'data-status',
        'provisional',
      );
      await expect(firstPage.getByTestId('market-judgement-register')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-history')).toHaveCount(0);
      const correct = firstPage.getByTestId('market-judgement-correct');
      await expect(correct).toHaveText(copy.adminMarketJudgementCorrect);

      // --- 판정 정정: the form says the move and is filled with v1 — its result, source, link,
      // collection minute and description — the 정정 사유 empty; before the scheduled judgement it
      // warns as a first judgement's does (decision 3 '등록 시점').
      await letToastsGo(firstPage);
      await correct.click();
      const form = firstPage.getByTestId('market-judgement-form');
      await expect(form).toHaveAttribute('data-correction', 'true');
      await expect(form.getByTestId('market-judgement-form-title')).toHaveText(
        copy.adminMarketJudgementCorrectionFormTitle,
      );
      await expect(form.getByTestId('market-judgement-form-correction')).toHaveText(versionMove(1));
      await expect(form.getByTestId('market-judgement-form-disputes')).toHaveCount(0);
      await expect(form.getByTestId('market-judgement-form-early-at')).toHaveText(
        formatKst(scheduledJudgementAt),
      );
      await expect(form.getByTestId('market-judgement-result-yes')).toHaveAttribute(
        'data-state',
        'checked',
      );
      await expect(form.getByTestId('market-judgement-source-0')).toHaveAttribute(
        'data-state',
        'checked',
      );
      await expect(form.getByTestId('market-judgement-link-0')).toHaveValue(link);
      await expect(form.getByTestId('market-judgement-link-1')).toHaveCount(0);
      await expect(form.getByTestId('market-judgement-collected-at')).toHaveValue(
        kstLocalOf(v1.evidence.collectedAt),
      );
      await expect(form.getByTestId('market-judgement-description')).toHaveValue(
        HELPER_JUDGEMENT_DESCRIPTION,
      );
      const reasonField = form.getByTestId('market-judgement-correction-reason');
      await expect(reasonField).toHaveValue('');

      // Sent as it opened, nothing goes: the reason is missing, and nothing was changed (#173 item
      // 7) — which still holds once the reason is there.
      const writes = judgementWrites(firstPage, market.id);
      const submit = form.getByTestId('market-judgement-submit');
      await expect(submit).toHaveText(copy.adminMarketJudgementCorrectionRegister);
      await submit.click();
      await expect(form.getByTestId('market-judgement-correction-reason-error')).toHaveText(
        copy.errMarketJudgementCorrectionReason,
      );
      const unchanged = form.getByTestId('market-judgement-unchanged');
      await expect(unchanged).toHaveText(copy.errMarketJudgementCorrectionUnchanged);
      await reasonField.fill(reason);
      await expect(form.getByTestId('market-judgement-correction-reason-error')).toHaveCount(0);
      await expect(unchanged).toHaveText(copy.errMarketJudgementCorrectionUnchanged);
      expect(writes).toEqual([]);

      // NO, a second link and what the correction confirmed; the collection instant left as it
      // was filled goes as v1's own, to the millisecond.
      await form.getByTestId('market-judgement-result-no').click();
      await form.getByTestId('market-judgement-link-add').click();
      await form.getByTestId('market-judgement-link-1').fill(secondLink);
      await form.getByTestId('market-judgement-description').fill(description);
      await expect(unchanged).toHaveCount(0);
      const registered = nextWrite(firstPage, market.id, '/judgements');
      await submit.click();
      expect((await registered).postDataJSON()).toEqual({
        result: 'NO',
        source: { priority: 0 },
        fallbackReason: null,
        voidReason: null,
        evidence: { links: [link, secondLink], collectedAt: v1.evidence.collectedAt },
        description,
        correction: { baseVersion: 1, reason },
        expectedAccountId: first.id,
      });
      await expect(
        firstPage.getByText(copy.adminMarketJudgementCorrectionRegistered),
      ).toBeVisible();
      await expect(form).toHaveCount(0);

      // --- waiting: a correction, its move and reason, what it says, who registered it; its
      // registrant may not decide it and alone may retract it; nothing else is offered meanwhile.
      const pending = firstPage.getByTestId('market-judgement-pending');
      await expect(pending).toHaveAttribute('data-correction', 'true');
      await expect(firstPage.getByTestId('market-judgement-pending-title')).toHaveText(
        copy.adminMarketJudgementPendingCorrection,
      );
      await expect(firstPage.getByTestId('market-judgement-pending-correction')).toHaveText(
        versionMove(1),
      );
      await expect(firstPage.getByTestId('market-judgement-pending-correction-reason')).toHaveText(
        reason,
      );
      await expect(firstPage.getByTestId('market-judgement-pending-disputes')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-pending-by')).toHaveText(firstName);
      await expect(firstPage.getByTestId('market-judgement-pending-result')).toHaveText(copy.no);
      await expect(
        firstPage.getByTestId('market-judgement-pending-links').getByRole('link'),
      ).toHaveText([link, secondLink]);
      await expect(firstPage.getByTestId('market-judgement-pending-early-at')).toHaveText(
        formatKst(scheduledJudgementAt),
      );
      await expect(firstPage.getByTestId('market-judgement-requester-note')).toHaveText(
        copy.adminMarketJudgementExcludedRequester,
      );
      await expect(firstPage.getByTestId('market-judgement-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-judgement-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-judgement-retract')).toBeEnabled();
      await expect(firstPage.getByTestId('market-judgement-correct')).toHaveCount(0);
      // v1 stands: its result, its deadline, and the market 잠정 결과.
      await expect(firstPage.getByTestId('market-judgement-current-badge')).toHaveText(copy.yes);
      await expect(firstPage.getByTestId('market-judgement-current-deadline')).toHaveText(
        formatKst(deadline),
      );
      const waiting = await adminMarketOf(admin, market.id);
      const requestId = pendingOf(waiting);
      expect(waiting).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: deadline,
      });
      // The server registered the base version's accepted disputes with it: none here.
      expect(waiting.judgement.pending?.correction).toEqual({
        baseVersion: 1,
        reason,
        disputeIds: [],
      });
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
      // One waits at a time, a first judgement and a correction alike.
      expect(
        await refusalOf(
          await sendJudgementRegistration(admin, market.id, {
            result: 'NO',
            correction: { baseVersion: 1, reason },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['judgement'], message: 'pending' }]);
      // Nothing was published but the labels: the visitor's detail reads YES as before.
      await expect(badge).toHaveText(copy.marketStatusProvisional);
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);

      // --- admin 2 finds it in 판정 승인 대기, marked as a correction 'v1 → v2', with its result
      // and registrant.
      await secondPage.reload();
      const row = secondPage.getByTestId(`admin-market-judgement-${requestId}`);
      await showInJudgements(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(
        secondPage.getByTestId(`admin-market-judgement-correction-${requestId}`),
      ).toHaveText(`${copy.adminMarketJudgementsCorrection} ${versionMove(1)}`);
      await expect(secondPage.getByTestId(`admin-market-judgement-result-${requestId}`)).toHaveText(
        copy.no,
      );
      await expect(
        secondPage.getByTestId(`admin-market-judgement-requested-by-${requestId}`),
      ).toHaveText(firstName);
      await secondPage.getByTestId(`admin-market-judgement-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- 승인: the dialog says the move, the result and the new window's length — v1's, from
      // the approval (#173 item 5) — and asks the event deadline's confirmation, then a reason.
      await expect(secondPage.getByTestId('market-judgement-requester-note')).toHaveCount(0);
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-judgement-approve').click();
      const dialog = secondPage.getByTestId('market-judgement-approve-dialog');
      const confirm = dialog.getByTestId('market-judgement-approve-dialog-confirm');
      await expect(dialog).toContainText(copy.adminMarketJudgementCorrectionApproveTitle);
      await expect(dialog).toContainText(copy.adminMarketJudgementCorrectionApproveBody);
      await expect(dialog.getByTestId('market-judgement-approve-request-correction')).toHaveText(
        versionMove(1),
      );
      await expect(dialog.getByTestId('market-judgement-approve-request')).toContainText(
        `${copy.adminMarketJudgementResult} ${copy.no}`,
      );
      const minutes = v1.disputeWindowMinutes.toLocaleString('ko-KR');
      const unit = copy.adminMarketJudgementWindowMinutes;
      await expect(dialog.getByTestId('market-judgement-approve-window')).toHaveText(
        `${copy.adminMarketJudgementCorrectionWindow} ${minutes}${unit}`,
      );
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
      await expect(secondPage.getByText(copy.adminMarketJudgementCorrectionApproved)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- judgement v2 at once (AC 1·3): NO, its grounds and reason, v1's window from the
      // approval, a deadline later than v1's, v1 kept unchanged in the history, and the record.
      const corrected = await adminMarketOf(admin, market.id);
      const v2 = currentOf(corrected);
      const newDeadline = v2.disputeDeadline;
      expect(corrected).toMatchObject({
        status: 'provisional',
        resolvedResult: 'NO',
        resolvedAt: null,
        judgementVersion: 2,
        disputeDeadline: newDeadline,
      });
      expect(corrected.judgement.pending).toBeNull();
      expect(v2).toMatchObject({
        version: 2,
        result: 'NO',
        source: { priority: 0 },
        evidence: { links: [link, secondLink], collectedAt: v1.evidence.collectedAt },
        description,
        correctionReason: reason,
        ruleVersion: 1,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: v1.disputeWindowMinutes,
        approvalId: requestId,
        registeredBy: { id: first.id },
        approvedBy: { id: second.id },
      });
      expect(Date.parse(newDeadline) - Date.parse(v2.publishedAt)).toBe(
        v1.disputeWindowMinutes * MINUTE_MS,
      );
      expect(Date.parse(newDeadline)).toBeGreaterThan(Date.parse(deadline));
      expect(corrected.judgement.history).toEqual([v1]);
      expect(
        corrected.judgement.log.map((entry) => [entry.requestId, entry.status, entry.version]),
      ).toEqual([
        [requestId, 'approved', 2],
        [v1.approvalId, 'approved', 1],
      ]);
      const correctedEvent = eventOf(corrected, 'judgement_corrected');
      const correctedPayload: MarketJudgementCorrectedPayload = {
        version: 2,
        previousVersion: 1,
        result: 'NO',
        previousResult: 'YES',
        approvalId: requestId,
        requestedBy: first.id,
        disputeDeadline: newDeadline,
        closedDisputes: 0,
      };
      expect(correctedEvent).toMatchObject({
        actorId: second.id,
        fromStatus: null,
        toStatus: null,
        payload: correctedPayload,
      });

      // --- the visitor's detail, never reloaded: NO, the new 이의 기한 and the link again — the
      // correction's `market:status` under a newer event, and the read it brings (ADR-0105).
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.no);
      await expect(badge).toHaveText(copy.marketStatusProvisional);
      await expect(notice.getByTestId('market-detail-dispute-deadline-viewer-zone')).toHaveText(
        formatKst(newDeadline),
      );
      await expect(notice.getByTestId('market-dispute-link')).toHaveText(copy.marketDisputeSubmit);
      expect(await documentSurvived(page)).toBe(true);
      // The public market: v2, its result and deadline, disputes taken, none under review — and
      // nothing of the correction (#24 publishes the versions and reasons later, without the
      // admins): no reason, no evidence, no description, no request, no admin, in the answer and
      // in the server's HTML.
      const publicMarket = await publicMarketOf(request, market.id);
      expect(publicMarket).toMatchObject({
        status: 'provisional',
        resolvedResult: 'NO',
        judgementVersion: 2,
        disputeDeadline: newDeadline,
        disputeOpen: true,
        disputeUnderReview: false,
        judgementDelayed: false,
      });
      expect(Object.keys(publicMarket)).not.toContain('judgement');
      const publicBody = await (await request.get(`/api/v1/markets/${market.id}`)).text();
      const html = await (await request.get(`/markets/${market.slug}`)).text();
      for (const hidden of [
        reason,
        link,
        secondLink,
        HELPER_JUDGEMENT_DESCRIPTION,
        description,
        approval,
        requestId,
        first.id,
        second.id,
      ]) {
        expect(publicBody).not.toContain(hidden);
        expect(html).not.toContain(hidden);
      }

      // --- the member, no fill: a dispute naming v1 is refused as a version the screen no
      // longer shows, then v2 for the fill (#173 item 6) — real refusals; the standing is v2's.
      const memberRequest = memberPage.request;
      expect(await disputeRefusalOf(await sendDispute(memberRequest, market.id, 1))).toBe(
        'stale_version',
      );
      expect(await disputeRefusalOf(await sendDispute(memberRequest, market.id, 2))).toBe(
        'no_fill',
      );
      expect(await standingOf(memberRequest, market.id)).toEqual({
        eligibility: 'no_fill',
        judgementVersion: 2,
        dispute: null,
      });

      // --- admin 2's detail: v2 with its reason and deadline, v1 in the 판정 버전 이력 with who
      // registered and approved it, the event log's 판정 정정, and 판정 정정 offered again.
      await expect(secondPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusProvisional,
      );
      await expect(secondPage.getByTestId('market-detail-judgement-version')).toContainText(
        `${copy.ruleVersionName}2`,
      );
      await expect(secondPage.getByTestId('market-judgement-current-badge')).toHaveText(copy.no);
      await expect(secondPage.getByTestId('market-judgement-current-deadline')).toHaveText(
        formatKst(newDeadline),
      );
      await expect(secondPage.getByTestId('market-judgement-current-rows')).toContainText(
        `${copy.adminMarketJudgementCorrectionReason} ${reason}`,
      );
      const history = secondPage.getByTestId('market-judgement-history');
      await expect(history.getByTestId('market-judgement-history-title')).toHaveText(
        copy.adminMarketJudgementHistory,
      );
      const replaced = history.getByTestId('market-judgement-history-0');
      await expect(replaced).toHaveAttribute('data-version', '1');
      await expect(history.getByTestId('market-judgement-history-1')).toHaveCount(0);
      await expect(replaced.getByTestId('market-judgement-history-0-badge')).toHaveText(copy.yes);
      await expect(
        replaced.getByTestId('market-judgement-history-0-links').getByRole('link'),
      ).toHaveText([link]);
      const replacedRows = replaced.getByTestId('market-judgement-history-0-rows');
      await expect(replacedRows).toContainText(
        `${copy.adminMarketJudgementRegisteredBy} ${firstName}`,
      );
      await expect(replacedRows).toContainText(
        `${copy.adminMarketJudgementApprovedBy} ${secondName}`,
      );
      await expect(replacedRows).toContainText(
        `${copy.adminMarketJudgementDeadline} ${formatKst(deadline)}`,
      );
      await expect(replacedRows).not.toContainText(copy.adminMarketJudgementCorrectionReason);
      const eventRow = secondPage.getByTestId(`market-event-${correctedEvent.id}`);
      await expect(eventRow).toContainText(copy.eventJudgementCorrected);
      await expect(eventRow).toContainText(`${copy.eventJudgementVersion} ${versionMove(1)}`);
      await expect(eventRow).toContainText(`${copy.marketResolvedResult} ${copy.yes} → ${copy.no}`);
      await expect(eventRow).toContainText(
        `${copy.eventDisputeDeadline} ${formatKst(newDeadline)}`,
      );
      await expect(eventRow).toContainText(
        `${copy.eventClosedDisputes} 0${copy.adminMarketDisputesHoldingUnit}`,
      );
      await expect(secondPage.getByTestId('market-judgement-correct')).toHaveText(
        copy.adminMarketJudgementCorrect,
      );

      // --- the member's submission screen reads v2: the new result and deadline, and why not.
      await memberPage.goto(screenPath);
      await expect(memberPage.getByTestId('dispute-closed')).toHaveAttribute(
        'data-reason',
        'no_fill',
      );
      await expect(memberPage.getByTestId('dispute-market-result')).toHaveText(copy.no);
      await expect(memberPage.getByTestId('dispute-market-deadline-viewer-zone')).toHaveText(
        formatKst(newDeadline),
      );

      // --- the new deadline, never v1's (AC 4): the worker confirms v2 and its result.
      const resolved = await waitForResolved(admin, market.id);
      expect(resolved.resolvedResult).toBe('NO');
      expect(resolved.judgementVersion).toBe(2);
      expect(Date.parse(resolved.resolvedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(newDeadline));
      const confirmed: MarketResolvedByDeadlinePayload = {
        version: 2,
        result: 'NO',
        source: 'deadline',
      };
      expect(eventOf(resolved, 'resolved').payload).toEqual(confirmed);
      // Confirmed, it takes no correction (#173 item 8: errors after it are #144's), and its panel
      // offers none — the history stays.
      expect(
        await refusalOf(
          await sendJudgementRegistration(admin, market.id, {
            correction: { baseVersion: 2, reason },
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['status'], message: 'not provisional' }]);
      await secondPage.reload();
      await expect(secondPage.getByTestId('market-judgement-current-badge')).toHaveText(copy.no);
      await expect(secondPage.getByTestId('market-judgement-history-0')).toHaveAttribute(
        'data-version',
        '1',
      );
      await expect(secondPage.getByTestId('market-judgement-correct')).toHaveCount(0);
    } finally {
      if (marketId !== null) {
        await leaveNoCorrection(admin, marketId);
        await leaveNoJudgement(admin, marketId);
      }
      await memberContext.close();
      await firstContext.close();
      await secondContext.close();
    }
  });

  test('판정 정정이 승인을 기다리는 동안 이의 기한이 지나면 워커가 확정하지 않고, 공개 상세는 판정 지연과 판정을 다시 검토한다는 줄을, 관리자 상세는 기다리는 정정을 말하며, 그때 한 관리자가 남긴 판정 지연 기록은 공개 상세에 그 사유로 보이고, 다른 관리자가 그 정정을 반려하면 원래 판정 v1과 그 결과대로 워커가 몇 초 안에 확정하며 그 기록은 이력으로 남는다', async ({
    admin,
    secondAdmin,
    browser,
    page,
    request,
  }) => {
    // v1's dispute window waited out with the correction waiting, then the confirmation.
    test.slow();
    await skipUnlessResolvable(admin);
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const secondContext = await browser.newContext();
    let marketId: string | null = null;
    try {
      // --- before the judgement: admin 2's browser on the closed market's detail.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      const market = await createOpenMarket(admin);
      marketId = market.id;
      await closeMarket(admin, market.id);
      await secondPage.goto(`/admin/markets/${market.id}`);
      await expect(secondPage.getByTestId('market-judgement')).toHaveAttribute(
        'data-status',
        'closed',
      );
      const rejection = `정정 공지가 1차 출처의 것이 아닙니다 ${market.tag}`;

      // --- judgement v1, YES, and at once admin 1's correction to NO (`registerCorrection`).
      const judged = await judgeMarket(admin, market.id);
      const v1 = currentOf(judged);
      const deadline = v1.disputeDeadline;
      const registered = await registerCorrection(admin, market.id);
      const requestId = pendingOf(registered);
      expect(registered.judgement.pending).toMatchObject({
        result: 'NO',
        correction: { baseVersion: 1, reason: HELPER_CORRECTION_REASON, disputeIds: [] },
      });
      // Before the deadline a waiting correction is no dispute: 잠정 결과, not 이의 검토 중.
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        disputeOpen: true,
        disputeUnderReview: false,
        judgementDelayed: false,
      });
      await secondPage.reload();
      await expect(secondPage.getByTestId('market-judgement-pending')).toHaveAttribute(
        'data-correction',
        'true',
      );
      await expect(secondPage.getByTestId('market-judgement-approve')).toBeEnabled();
      await expect(secondPage.getByTestId('market-detail-judgement-delayed')).toHaveCount(0);

      // --- v1's deadline passes with the correction waiting (decision 3 '#176 정정 대기'): the
      // worker's job at the deadline finds the market held and leaves it 잠정 결과.
      await waitPast(secondPage, deadline, HELD_SLACK_MS);
      const held = await adminMarketOf(admin, market.id);
      expect(held).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: deadline,
        judgementDelayed: true,
      });
      expect(pendingOf(held)).toBe(requestId);
      // The public market reads 판정 지연 — no dispute under review, none taken any more.
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: deadline,
        disputeOpen: false,
        disputeUnderReview: false,
        judgementDelayed: true,
      });
      // A visitor's detail, read now in the market's room: 판정 지연 and the line that the
      // judgement is reviewed again — never that the result will change (the correction may be
      // rejected) — its result, no link, and no 판정 지연 기록 yet.
      const joined = subscribed(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      await joined;
      await expect(page.getByTestId('market-status-badge')).toHaveText(
        copy.marketStatusJudgementDelayed,
      );
      const notice = page.getByTestId('market-status-notice');
      await expect(notice.getByTestId('market-status-notice-detail')).toHaveText(
        copy.marketProvisionalDelayedCorrection,
      );
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
      await expect(notice.getByTestId('market-dispute-link')).toHaveCount(0);
      await expect(notice.getByTestId('market-detail-delay-reason')).toHaveCount(0);
      await markDocument(page);
      // Admin 2's detail, read again: 판정 지연 because a correction waits for its approval, and the
      // 판정 지연 기록 open to any admin (#173 items 7·11 — a held 잠정 결과 past its deadline).
      await secondPage.reload();
      await expect(secondPage.getByTestId('market-detail-judgement-delayed')).toContainText(
        copy.adminMarketCorrectionDelayedNote,
      );
      await expect(secondPage.getByTestId('market-judgement-delays')).toHaveAttribute(
        'data-delayed',
        'true',
      );
      await expect(secondPage.getByTestId('market-judgement-delay-record')).toBeEnabled();

      // --- a 판정 지연 기록 on the held 잠정 결과 (#142, ADR-0106; #173 items 2·7·11): admin 1 — the
      // correction's registrant, who may — records why it is late, alone and at once. Its reason
      // says no 정정: a waiting correction is not public (ADR-0105). Nothing of the market changes
      // — its version, result, deadline and the waiting correction stand — and the visitor's
      // detail, never reloaded, adds the reason and the next review time under the result.
      const delayReason = `1차 출처의 발표를 다시 확인하고 있습니다 ${market.tag}`;
      const delayed = await recordJudgementDelay(admin, market.id, { reason: delayReason });
      expect(delayed).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: deadline,
        judgementDelayed: true,
        judgementDelay: { reason: delayReason, nextReviewPassed: false },
      });
      expect(pendingOf(delayed)).toBe(requestId);
      // The record is v1's: the 잠정 결과 and its version it was made on.
      expect(delayed.judgementDelays).toMatchObject([
        {
          reason: delayReason,
          marketStatus: 'provisional',
          judgementVersion: 1,
          recordedBy: { id: first.id },
          current: true,
        },
      ]);
      await expect(notice.getByTestId('market-detail-delay-reason')).toHaveText(delayReason);
      await expect(notice.getByTestId('market-detail-next-review')).toHaveAttribute(
        'data-passed',
        'false',
      );
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
      expect(await documentSurvived(page)).toBe(true);
      // Admin 2's 판정 panel: the record, current, as made on 잠정 결과 v1.
      await secondPage.reload();
      const delayEntry = secondPage.getByTestId('market-judgement-delay-history-0');
      await expect(delayEntry).toHaveAttribute('data-current', 'true');
      await expect(delayEntry.getByTestId('market-judgement-delay-history-0-episode')).toHaveText(
        `${copy.marketStatusProvisional} ${copy.ruleVersionName}1`,
      );
      await expect(secondPage.getByTestId('market-judgement-delay-current-reason')).toHaveText(
        delayReason,
      );

      // --- 반려 by admin 2: the dialog says the move and what a 반려 leaves — read past the
      // deadline, that v1 is then confirmed within seconds; no dispute rode on it, so none goes
      // back to 검토 중 — then a reason.
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-judgement-reject').click();
      const dialog = secondPage.getByTestId('market-judgement-reject-dialog');
      const confirm = dialog.getByTestId('market-judgement-reject-dialog-confirm');
      await expect(dialog).toContainText(copy.adminMarketJudgementCorrectionRejectTitle);
      await expect(dialog).toContainText(copy.adminMarketJudgementCorrectionRejectBody);
      await expect(dialog).toContainText(copy.adminMarketJudgementCorrectionEndConfirms);
      await expect(dialog).not.toContainText(copy.adminMarketJudgementCorrectionReopen);
      await expect(dialog.getByTestId('market-judgement-reject-request-correction')).toHaveText(
        versionMove(1),
      );
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-judgement-reject-reason').fill(rejection);
      await expect(confirm).toBeEnabled();
      const rejected = nextWrite(secondPage, market.id, `/judgements/${requestId}/reject`);
      await confirm.click();
      expect((await rejected).postDataJSON()).toEqual({
        reason: rejection,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketJudgementCorrectionRejected)).toBeVisible();

      // --- v1 carries on, its deadline long past and nothing holding it: the API queues the
      // confirmation at once (its integration test pins the job) and the worker confirms v1's YES
      // promptly after the 반려 (CONFIRM_AFTER_REJECTION_MS) — at no new deadline.
      let confirmed = await adminMarketOf(admin, market.id);
      await expect
        .poll(
          async () => {
            confirmed = await adminMarketOf(admin, market.id);
            return confirmed.status;
          },
          {
            message: `market ${market.id} is not confirmed after its correction's 반려`,
            timeout: CONFIRM_AFTER_REJECTION_MS,
            intervals: [1_000],
          },
        )
        .not.toBe('provisional');
      expect(['resolved', 'settling', 'settled']).toContain(confirmed.status);
      expect(confirmed).toMatchObject({
        resolvedResult: 'YES',
        judgementVersion: 1,
        disputeDeadline: deadline,
      });
      expect(confirmed.judgement.current).toEqual(v1);
      expect(confirmed.judgement.history).toEqual([]);
      const [last] = confirmed.judgement.log;
      expect(last).toMatchObject({
        requestId,
        status: 'rejected',
        decidedBy: { id: second.id },
        decisionReason: rejection,
        version: null,
        correction: { baseVersion: 1 },
      });
      expect(Date.parse(confirmed.resolvedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(last?.decidedAt ?? ''),
      );
      const resolvedPayload: MarketResolvedByDeadlinePayload = {
        version: 1,
        result: 'YES',
        source: 'deadline',
      };
      expect(eventOf(confirmed, 'resolved').payload).toEqual(resolvedPayload);
      expect(confirmed.events.some((event) => event.type === 'judgement_corrected')).toBe(false);
      // The 판정 지연 기록 is v1's 잠정 결과's, history once confirmed (ADR-0106): kept, no longer
      // current, and on no public answer.
      expect(confirmed.judgementDelay).toBeNull();
      expect(confirmed.judgementDelays).toMatchObject([{ reason: delayReason, current: false }]);
      expect((await publicMarketOf(request, market.id)).judgementDelay).toBeNull();
      // Admin 2's detail, left open, reads again past the deadline now nothing waits.
      await expect(secondPage.getByTestId('market-detail-status')).not.toHaveText(
        copy.marketStatusProvisional,
        { timeout: CONFIRM_AFTER_REJECTION_MS },
      );
    } finally {
      if (marketId !== null) await leaveNoCorrection(admin, marketId);
      await secondContext.close();
    }
  });
});
