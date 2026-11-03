import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminDisputeQueueItem,
  AdminMarket,
  Market,
  MyDispute,
  MyMarketDispute,
  SubmitDisputeBody,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  E2E_PASSWORD,
  accountIdOf,
  adminAccount,
  closeMarket,
  createOpenMarket,
  documentSurvived,
  expect,
  freshEmail,
  judgeMarket,
  logOut,
  markDocument,
  meOf,
  openSetPassword,
  setFirstPassword,
  signIn,
  signUp,
  skipUnlessResolvable,
  subscribed,
  test,
  waitForResolved,
} from './helpers';

/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·11–13·15, decision 3 '#175
 * 토론의 이의 안내'): once a 잠정 결과 is published, its 이의 기한 — the one the approval fixed — and
 * the link to the submission screen are on the public detail for every visitor, in the server's
 * HTML too, and one line above the 토론 list and on the write screen says a post is no 판정 이의;
 * at the deadline the link and the line go without a reload (a one-shot timer: a market a dispute
 * holds publishes nothing then). The submission screen (`/markets/[slug]/dispute`) sends a visitor
 * to the login and back, and tells a member why they may not dispute, one sentence each: no
 * provisional result, the deadline passed, an operator's account, no fill on the market. MY '판정
 * 이의' (`/my/disputes`, no tab — linked from MY 설정) lists the member's own, and an account with
 * an onboarding step left may open it, as 내 제안; the submission screen meets the gate. The
 * operators' 이의 접수 (`/admin/disputes`, after 테마 in the menu) has 검토 대기 and 처리됨, and the
 * admin detail's 판정 panel a '판정 이의' block for the current judgement version.
 *
 * No spec can make a fill: there is no way to trade until the CLOB lands (#119; D13), and only a
 * member with a fill on the market may dispute it (#173 item 6) — on the deployed environment too,
 * where nobody is eligible until then. So a dispute is never submitted for real here: a 판정 이의
 * that holds a market, its 기각 and 수용, the hold past the deadline ('판정 지연'), '이의 검토 중' and
 * the confirmation right after the last 기각 are the database's, the API's and the worker's
 * integration tests (packages/db market-dispute.test.ts, market-disputes.controller.test.ts,
 * private-data.test.ts, worker market-resolve.test.ts), which make fills with `createFill` — and
 * so, since the 판정 정정 (#176, ADR-0105), are a correction from an accepted dispute, the pending
 * disputes it closes as 정정으로 종결, the accepted ones a rejected or retracted correction sends
 * back to 검토 중 and a second dispute on the corrected version
 * (admin-market-judgements.controller.test.ts, packages/db market-dispute.test.ts); the
 * correction itself, with no dispute, is correction.spec.ts's. The screens' states are
 * unit-tested (dispute-screen.test.tsx, my-disputes.test.tsx, market-dispute-panel.test.tsx,
 * admin-disputes.test.tsx). What stays here is real: the refusals a
 * member without a fill and an operator meet, the deadline the API keeps on its own clock, the
 * public data, the gates, the empty lists — and the market with no dispute confirmed at its
 * deadline as before. The form's 내기 and 철회 are walked once with the member's own reads and writes
 * answered in the browser (`page.route`, market.spec.ts' precedent): client-only, labelled so, and
 * nothing reaches the API. There the form and the dispute are held inside the screen's width,
 * which the mobile-375 project measures at a phone's (PLAN 13 M4 AC 5's 375px).
 *
 * The dispute window is the 1분 the suite's global setup enters (global-setup.ts), so every
 * in-window assertion comes first and quickly after the approval; a test that waits the deadline
 * out skips on a database with a longer window or no worker probe (`skipUnlessResolvable`). Every
 * market is created per run, and every browser context a test opens is closed in its `finally`.
 */

/** How long past the 이의 기한 a screen's one-shot timer is given to take the link away. */
const DEADLINE_SLACK_MS = 15_000;

/** How far before the deadline a timer anchored on the server's instant may fire on this box. */
const CLOCK_SLACK_MS = 2_000;

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** DISPUTE_NOT_ALLOWED's `details.reason`, once the answer is that 409. */
async function disputeRefusalOf(response: APIResponse): Promise<string> {
  const body = await response.text();
  expect(response.status(), body).toBe(409);
  const { error } = JSON.parse(body) as { error: { code: string; details: { reason: string } } };
  expect(error.code, body).toBe('DISPUTE_NOT_ALLOWED');
  return error.details.reason;
}

/** The public market as a signed-out visitor reads it (`request` carries no cookie). */
async function publicMarketOf(request: APIRequestContext, id: string): Promise<Market> {
  return dataOf<Market>(await request.get(`/api/v1/markets/${id}`));
}

/** The admin market as `context` reads it. */
async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  return dataOf<AdminMarket>(await context.get(`/api/v1/admin/markets/${id}`));
}

/** An evidence link of a spec's dispute: https, under the market's own path, `n` apart. */
function disputeLink(marketId: string, n = 1): string {
  return `https://example.com/e2e/dispute/${marketId}/${String(n)}`;
}

/**
 * `POST /markets/:id/disputes` as the account `context` is signed in as, the answer as it came:
 * one link and a reason unless `body` says otherwise, the account it names (`expectedAccountId`,
 * ADR-0092).
 */
async function sendDispute(
  context: APIRequestContext,
  marketId: string,
  body: Partial<Omit<SubmitDisputeBody, 'expectedAccountId'>> & { judgementVersion: number },
): Promise<APIResponse> {
  return context.post(`/api/v1/markets/${marketId}/disputes`, {
    data: {
      links: [disputeLink(marketId)],
      reason: '잠정 결과가 1차 출처의 발표와 다릅니다.',
      ...body,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/** The account's standing on the market (`GET /me/disputes/markets/:marketId`), as the API says. */
async function standingOf(context: APIRequestContext, marketId: string): Promise<MyMarketDispute> {
  return dataOf<MyMarketDispute>(await context.get(`/api/v1/me/disputes/markets/${marketId}`));
}

/**
 * No price, volume, count or holding of the market is drawn in `element`, nor its label (N03 §5, as
 * judgement.spec.ts' for #152 AC 8): a dispute argues the rule's source, never the market's
 * majority — the labels the admin detail's 거래 현황 and the public detail use.
 */
async function expectNoMarketSignal(element: Locator): Promise<void> {
  for (const label of [
    copy.tradeStatsLastPrice,
    copy.tradeStatsNetCollected,
    copy.tradeStatsOpenInterestYes,
    copy.tradeStatsOpenInterestNo,
    copy.marketVolume,
    copy.marketTradeCount,
    copy.marketTraderCount,
  ]) {
    await expect(element).not.toContainText(label);
  }
}

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

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the screen's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The `POST <path>` this page sends next. */
function nextPost(page: Page, path: string): Promise<Request> {
  return page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === path,
  );
}

/** How long, from now, a screen is given to take the link away at `deadline`. */
function untilDeadline(deadline: string): number {
  return Math.max(0, Date.parse(deadline) - Date.now()) + DEADLINE_SLACK_MS;
}

test.describe('판정 이의', () => {
  test('잠정 결과가 공개되면 방문자의 상세에 이의 기한과 판정 이의 제출 링크가 리프레시 없이(서버 HTML에도), 토론 위와 글쓰기 화면에 안내가 보이고, 체결 이력이 없는 회원과 운영자는 제출 화면에서 그 까닭을 보며 API도 거절하고, 기한이 지나면 링크와 안내가 리프레시 없이 사라지고 이의가 없는 시장은 그대로 확정된다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    // The dispute window, a minute, is waited out, then the worker's confirmation.
    test.slow();
    await skipUnlessResolvable(admin);
    const memberContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      // --- before the judgement, everything that takes time: the member signed up (no fill —
      // nobody can trade, #119), an operator's browser signed in, the market closed, and every
      // screen the window needs opened once, on the CLOSED market.
      const memberPage = await memberContext.newPage();
      const email = freshEmail();
      await signUp(memberPage, email);
      // Read once now, so no submission in the minute below waits for `GET /me`.
      await accountIdOf(memberPage.request);
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      const market = await createOpenMarket(admin);
      await closeMarket(admin, market.id);
      const screenPath = `/markets/${market.slug}/dispute`;
      const writePath = `/community/write?market=${market.id}`;

      // MY '판정 이의', a sub-page with no tab: MY 설정's card leads there, and a member who never
      // disputed has none.
      await memberPage.goto('/my/settings');
      const settingsCard = memberPage.getByTestId('settings-disputes');
      await expect(settingsCard).toContainText(copy.myDisputes);
      await settingsCard.getByRole('link', { name: copy.myDisputesOpen }).click();
      await expect(memberPage).toHaveURL('/my/disputes');
      await expect(memberPage.getByTestId('my-disputes-intro')).toHaveText(copy.myDisputesIntro);
      await expect(memberPage.getByTestId('my-disputes-empty')).toHaveText(copy.myDisputesEmpty);

      // The submission screen is the members': a visitor goes to the login and comes back to it.
      await logOut(memberPage);
      await memberPage.goto(screenPath);
      await memberPage.waitForURL(/\/login\?/);
      expect(new URL(memberPage.url()).searchParams.get('next')).toBe(screenPath);
      await memberPage.getByLabel(copy.email).fill(email);
      await memberPage.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
      await memberPage.getByRole('button', { name: copy.loginWithEmail }).click();
      await expect(memberPage).toHaveURL(screenPath);
      // A CLOSED market shows no provisional result: one sentence, no form — and the two notes,
      // the market back to its detail and the way to MY.
      const memberClosed = memberPage.getByTestId('dispute-closed');
      await expect(memberClosed).toHaveAttribute('data-reason', 'not_provisional');
      await expect(memberClosed).toHaveText(copy.disputeRefusalNotProvisional);
      await expect(memberPage.getByTestId('dispute-form')).toHaveCount(0);
      const notes = memberPage.getByTestId('dispute-notice');
      await expect(notes).toContainText(copy.disputePrivacyNote);
      await expect(notes).toContainText(copy.disputeNotAppealNote);
      await expect(memberPage.getByTestId('dispute-market-link')).toHaveAttribute(
        'href',
        `/markets/${market.slug}`,
      );
      await expect(memberPage.getByTestId('dispute-market-deadline')).toHaveCount(0);
      await expect(memberPage.getByTestId('dispute-my-link')).toHaveAttribute(
        'href',
        '/my/disputes',
      );
      // The write screen of a CLOSED market has no line about 판정 이의.
      await memberPage.goto(writePath);
      await expect(memberPage.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect(memberPage.getByTestId('post-write-dispute-note')).toHaveCount(0);
      // The operator's submission screen, the same sentence for now.
      await adminPage.goto(screenPath);
      await expect(adminPage.getByTestId('dispute-closed')).toHaveAttribute(
        'data-reason',
        'not_provisional',
      );

      // --- the visitor, signed out, in the market's room: 거래 마감, no deadline, no link, no line.
      const joined = subscribed(page, market.id);
      await page.goto(`/markets/${market.slug}`);
      await joined;
      const badge = page.getByTestId('market-status-badge');
      await expect(badge).toHaveText(copy.marketStatusClosed);
      const notice = page.getByTestId('market-status-notice');
      const deadlineRow = notice.getByTestId('market-detail-dispute-deadline');
      const link = notice.getByTestId('market-dispute-link');
      const discussionNote = page.getByTestId('market-discussion-dispute-note');
      await expect(deadlineRow).toHaveCount(0);
      await expect(link).toHaveCount(0);
      await expect(discussionNote).toHaveCount(0);
      await markDocument(page);

      // --- 잠정 결과, and the minute starts: every in-window assertion below comes quickly.
      const judged = await judgeMarket(admin, market.id);
      const deadline = judged.disputeDeadline;
      if (deadline === null) throw new Error('unreachable: a 잠정 결과 has its 이의 기한');

      // The visitor's detail, never reloaded: 잠정 결과 — no dispute holds it — its 이의 기한 in the
      // viewer's zone, the link to the submission screen, and the line above the 토론 list.
      await expect(badge).toHaveText(copy.marketStatusProvisional);
      await expect(notice).toContainText(copy.marketProvisionalNotice);
      await expect(deadlineRow).toContainText(copy.marketDisputeDeadline);
      await expect(notice.getByTestId('market-detail-dispute-deadline-viewer-zone')).toHaveText(
        formatKst(deadline),
      );
      await expect(link).toHaveText(copy.marketDisputeSubmit);
      await expect(link).toHaveAttribute('href', screenPath);
      await expect(discussionNote).toContainText(copy.discussionDisputeNote);
      await expect(
        discussionNote.getByTestId('market-discussion-dispute-note-link'),
      ).toHaveAttribute('href', screenPath);
      expect(await documentSurvived(page)).toBe(true);

      // Public data (#173 item 6): the deadline the approval fixed, the version a submission
      // names, disputes taken, none under review, not delayed — in the answer and the page's HTML.
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        status: 'provisional',
        judgementVersion: 1,
        disputeDeadline: deadline,
        disputeOpen: true,
        disputeUnderReview: false,
        judgementDelayed: false,
      });
      const html = await (await request.get(`/markets/${market.slug}`)).text();
      expect(html).toContain(`href="${screenPath}"`);
      expect(html).toContain(copy.marketDisputeSubmit);
      expect(html).toContain(formatKst(deadline));
      expect(html).toContain('data-testid="market-discussion-dispute-note"');

      // The member, no fill: the API refuses a version the screen never showed first, then the
      // fill (#173 item 6) — real refusals; the standing says the same.
      expect(
        await disputeRefusalOf(
          await sendDispute(memberPage.request, market.id, { judgementVersion: 2 }),
        ),
      ).toBe('stale_version');
      expect(
        await disputeRefusalOf(
          await sendDispute(memberPage.request, market.id, { judgementVersion: 1 }),
        ),
      ).toBe('no_fill');
      expect(await standingOf(memberPage.request, market.id)).toEqual({
        eligibility: 'no_fill',
        judgementVersion: 1,
        dispute: null,
      });
      // From the detail's link, the screen: the market (its status, 잠정 결과 and 이의 기한) and why
      // not, in one sentence — no form, and no price, volume or count anywhere.
      await memberPage.goto(`/markets/${market.slug}`);
      await memberPage.getByTestId('market-dispute-link').click();
      await expect(memberPage).toHaveURL(screenPath);
      await expect(memberClosed).toHaveAttribute('data-reason', 'no_fill');
      await expect(memberClosed).toHaveText(copy.disputeRefusalNoFill);
      await expect(memberPage.getByTestId('dispute-form')).toHaveCount(0);
      await expect(memberPage.getByTestId('dispute-market-status')).toHaveText(
        copy.marketStatusProvisional,
      );
      await expect(memberPage.getByTestId('dispute-market-result')).toHaveText(copy.yes);
      await expect(memberPage.getByTestId('dispute-market-deadline-viewer-zone')).toHaveText(
        formatKst(deadline),
      );
      await expectNoMarketSignal(memberPage.getByTestId('dispute-screen'));

      // An operator never trades and decides disputes (#173 item 15): refused as one, before the
      // fill is asked — and the operator's screen says so.
      expect(
        await disputeRefusalOf(await sendDispute(admin, market.id, { judgementVersion: 1 })),
      ).toBe('admin');
      await adminPage.reload();
      const adminClosed = adminPage.getByTestId('dispute-closed');
      await expect(adminClosed).toHaveAttribute('data-reason', 'admin');
      await expect(adminClosed).toHaveText(copy.disputeRefusalAdmin);

      // The write screen with this market chosen: the line and the link, outside the sanction
      // banner (decision 3 '#175 토론의 이의 안내').
      await memberPage.goto(writePath);
      const writeNote = memberPage.getByTestId('post-write-dispute-note');
      await expect(writeNote).toContainText(copy.discussionDisputeNote);
      await expect(writeNote.getByTestId('post-write-dispute-note-link')).toHaveAttribute(
        'href',
        screenPath,
      );

      // --- the deadline: the link and the line go without a reload — never before it, on the
      // server's instant the detail counts from. The write screen joins no socket room, so its line
      // goes by the timer alone; the detail's might go by the worker's confirmation, which follows
      // within seconds.
      await expect(link).toHaveCount(0, { timeout: untilDeadline(deadline) });
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(deadline) - CLOCK_SLACK_MS);
      await expect(discussionNote).toHaveCount(0);
      expect(await documentSurvived(page)).toBe(true);
      await expect(writeNote).toHaveCount(0, { timeout: untilDeadline(deadline) });
      // The operator's screen, left open: no longer taken — the deadline, or the confirmation if
      // the worker came first.
      await expect(adminClosed).toHaveAttribute(
        'data-reason',
        /^(deadline_passed|not_provisional)$/,
      );
      // The API keeps the deadline on its own clock (submission needs now < deadline, ADR-0104),
      // asked a second past it on this box's — room for the database's: `deadline_passed` while
      // the worker has not confirmed it, `not_provisional` once it has. Which comes first is the
      // worker's timing; the millisecond is the API's integration test.
      const pastDeadlineMs = Date.parse(deadline) + CLOCK_SLACK_MS - Date.now();
      if (pastDeadlineMs > 0) await memberPage.waitForTimeout(pastDeadlineMs);
      expect(['deadline_passed', 'not_provisional']).toContain(
        await disputeRefusalOf(
          await sendDispute(memberPage.request, market.id, { judgementVersion: 1 }),
        ),
      );

      // --- no dispute, no hold (#173 item 1): the worker confirms it at the deadline as before.
      const resolved = await waitForResolved(admin, market.id);
      expect(resolved.resolvedResult).toBe('YES');
      expect(Date.parse(resolved.resolvedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(deadline));
      expect(resolved.disputes).toEqual({ holding: 0, items: [] });
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        disputeOpen: false,
        disputeUnderReview: false,
      });
      // The 판정 panel's '판정 이의' block of the current version: none, nothing holding, no price.
      await adminPage.goto(`/admin/markets/${market.id}`);
      const block = adminPage.getByTestId('market-judgement-disputes');
      await expect(block).toHaveAttribute('data-holding', '0');
      await expect(block.getByTestId('market-judgement-disputes-title')).toHaveText(
        copy.adminMarketDisputes,
      );
      await expect(block.getByTestId('market-judgement-disputes-empty')).toHaveText(
        copy.adminMarketDisputesEmpty,
      );
      await expect(block.getByTestId('market-judgement-disputes-holding')).toHaveCount(0);
      await expectNoMarketSignal(block);
    } finally {
      await memberContext.close();
      await adminContext.close();
    }
  });

  test('제출 양식(화면만 — 체결 이력을 만들 길이 없어 회원의 판정 이의 읽기와 쓰기를 브라우저에서 답한다): 링크와 사유를 확인하고, 낸 판정 이의를 검토 중으로 보이며, 기한 안에 철회하면 철회로 바뀌고 MY 판정 이의에도 그렇게 보인다', async ({
    admin,
    page,
  }) => {
    /*
     * Client-only. No spec can make a fill (#119), so the API refuses this member `no_fill`, and
     * the member's own reads and writes of 판정 이의 are answered in the browser: the standing is
     * the API's real answer with `eligible` put in for `no_fill` — then, once one was 'sent', the
     * duplicate with it, as the API answers — and the submission, the 철회 and MY's list are
     * answered here and never reach the API. The market is real: judged, its 잠정 결과 and 이의 기한
     * the API's; so is the session. At the end the API is asked that nothing was written.
     */
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    const screenPath = `/markets/${market.slug}/dispute`;
    const submitPath = `/api/v1/markets/${market.id}/disputes`;
    const fakeId = randomUUID();
    const retractPath = `/api/v1/me/disputes/${fakeId}/retract`;
    let sent: MyDispute | null = null;

    await page.route(
      (url) => url.pathname === `/api/v1/me/disputes/markets/${market.id}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: MyMarketDispute };
        const real = body.data;
        const data: MyMarketDispute =
          sent === null
            ? {
                ...real,
                eligibility: real.eligibility === 'no_fill' ? 'eligible' : real.eligibility,
              }
            : { ...real, eligibility: 'duplicate', dispute: sent };
        await route.fulfill({ response, json: { ...body, data } });
      },
    );
    await page.route(
      (url) => url.pathname === submitPath,
      async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const body = route.request().postDataJSON() as SubmitDisputeBody;
        sent = {
          id: fakeId,
          judgementVersion: body.judgementVersion,
          links: body.links,
          reason: body.reason,
          status: 'pending',
          submittedAt: new Date().toISOString(),
          decidedAt: null,
          decisionReason: null,
          retractedAt: null,
          closedAt: null,
          market: {
            id: market.id,
            slug: market.slug,
            title: market.title,
            status: 'provisional',
            judgementVersion: body.judgementVersion,
          },
          retractable: true,
        };
        await route.fulfill({ status: 201, json: { data: sent } });
      },
    );
    await page.route(
      (url) => url.pathname === retractPath,
      async (route) => {
        if (sent === null) return route.fallback();
        sent = {
          ...sent,
          status: 'retracted',
          retractedAt: new Date().toISOString(),
          retractable: false,
        };
        await route.fulfill({ json: { data: sent } });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/v1/me/disputes',
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: MyDispute[] };
        await route.fulfill({
          response,
          json: { ...body, data: sent === null ? body.data : [sent, ...body.data] },
        });
      },
    );

    try {
      // Both screens opened once before the minute starts (MY, empty).
      await page.goto('/my/disputes');
      await expect(page.getByTestId('my-disputes-empty')).toBeVisible();
      await page.goto(screenPath);
      await expect(page.getByTestId('dispute-closed')).toHaveAttribute(
        'data-reason',
        'not_provisional',
      );

      // --- 잠정 결과: the form, with what the one per version means.
      await judgeMarket(admin, market.id);
      await page.reload();
      const form = page.getByTestId('dispute-form');
      await expect(form).toBeVisible();
      await expect(form.getByTestId('dispute-once')).toHaveText(copy.disputeOnce);
      await expect(page.getByTestId('dispute-closed')).toHaveCount(0);
      await expectNoMarketSignal(page.getByTestId('dispute-screen'));

      // Sent empty, nothing goes: each field says what it lacks.
      const posts: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'POST' && pathname.includes('/disputes')) posts.push(pathname);
      });
      const submit = form.getByTestId('dispute-submit');
      await submit.click();
      await expect(form.getByTestId('dispute-link-0-error')).toHaveText(copy.errDisputeLink);
      await expect(form.getByTestId('dispute-reason-error')).toHaveText(copy.errDisputeReason);
      expect(posts).toEqual([]);

      // Links: the same one twice is refused under the second, one taken away again; a long one
      // with no place to break but its letters.
      const link = `https://example.com/e2e/dispute/${market.id}/1`;
      const longLink = `https://example.com/e2e/dispute/${market.id}/${'evidence'.repeat(12)}`;
      await form.getByTestId('dispute-link-0').fill(link);
      await form.getByTestId('dispute-link-add').click();
      await form.getByTestId('dispute-link-1').fill(link);
      await expect(form.getByTestId('dispute-link-1-error')).toHaveText(
        copy.errDisputeLinkDuplicate,
      );
      await expect(form.getByTestId('dispute-link-0-error')).toHaveCount(0);
      await form.getByTestId('dispute-link-1').fill(longLink);
      await expect(form.getByTestId('dispute-link-1-error')).toHaveCount(0);
      await form.getByTestId('dispute-link-add').click();
      await expect(form.getByTestId('dispute-link-2')).toBeVisible();
      await form.getByTestId('dispute-link-remove-2').click();
      await expect(form.getByTestId('dispute-link-2')).toHaveCount(0);
      // The reason, counted as typed, sent trimmed.
      const reason = `잠정 결과가 1차 출처의 발표와 다릅니다 ${market.tag}`;
      const typed = `  ${reason}  `;
      await form.getByTestId('dispute-reason').fill(typed);
      await expect(form.getByTestId('dispute-reason-count')).toHaveText(
        `${String(typed.length)} ${copy.disputeReasonCountMax}`,
      );
      await expect(form.getByTestId('dispute-reason-error')).toHaveCount(0);
      expect(posts).toEqual([]);
      await expectInsideWidth(page, form);

      // --- 판정 이의 내기: the version the standing was read for and the account on screen.
      const submitted = nextPost(page, submitPath);
      await submit.click();
      expect((await submitted).postDataJSON()).toEqual({
        judgementVersion: 1,
        links: [link, longLink],
        reason,
        expectedAccountId: me.id,
      });
      await expect(page.getByText(copy.disputeSubmitted)).toBeVisible();
      // The form gives way to the dispute, 검토 중, with 철회 — and no 'already submitted' sentence
      // above it: the dispute says so itself.
      const own = page.getByTestId(`my-dispute-${fakeId}`);
      await expect(own).toHaveAttribute('data-status', 'pending');
      await expect(own.getByTestId(`my-dispute-${fakeId}-status`)).toHaveText(
        copy.disputeStatusPending,
      );
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId('dispute-closed')).toHaveCount(0);
      const content = own.getByTestId(`my-dispute-${fakeId}-content`);
      await content.locator('summary').click();
      await expect(content).toContainText(longLink);
      await expect(content).toContainText(reason);
      await expectInsideWidth(page, page.getByTestId('dispute-screen'));

      // --- 철회 within the deadline: confirmed first, then 철회 and its time, and no button.
      const retract = own.getByTestId(`my-dispute-${fakeId}-retract`);
      await letToastsGo(page);
      await retract.click();
      const retracted = nextPost(page, retractPath);
      await page.getByTestId('my-dispute-retract-confirm').click();
      expect((await retracted).postDataJSON()).toEqual({ expectedAccountId: me.id });
      await expect(page.getByText(copy.disputeRetracted)).toBeVisible();
      await expect(own).toHaveAttribute('data-status', 'retracted');
      await expect(own.getByTestId(`my-dispute-${fakeId}-status`)).toHaveText(
        copy.disputeStatusRetracted,
      );
      await expect(own.getByTestId(`my-dispute-${fakeId}-times`)).toContainText(
        copy.disputeRetractedAt,
      );
      await expect(retract).toHaveCount(0);

      // --- MY '판정 이의', from the screen's link: the same dispute under its market.
      await letToastsGo(page);
      await page.getByTestId('dispute-my-link').click();
      await expect(page).toHaveURL('/my/disputes');
      const listed = page.getByTestId('my-disputes-list').getByTestId(`my-dispute-${fakeId}`);
      await expect(listed).toHaveAttribute('data-status', 'retracted');
      await expect(listed.getByTestId(`my-dispute-${fakeId}-market`)).toHaveText(market.title);
      await expect(listed.getByTestId(`my-dispute-${fakeId}-market`)).toHaveAttribute(
        'href',
        `/markets/${market.slug}`,
      );

      // --- nothing reached the API: no dispute on the market, none in the member's list, and the
      // member's real standing holds none either (`no_fill` — or, should the minute be over by
      // now, the deadline's or the confirmation's refusal; never `duplicate`).
      expect((await adminMarketOf(admin, market.id)).disputes).toEqual({ holding: 0, items: [] });
      expect(await dataOf<MyDispute[]>(await page.request.get('/api/v1/me/disputes'))).toEqual([]);
      const real = await standingOf(page.request, market.id);
      expect(real.dispute).toBeNull();
      expect(['no_fill', 'deadline_passed', 'not_provisional']).toContain(real.eligibility);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('관리자 메뉴의 이의 접수는 테마 다음에 있고, 검토 대기와 처리됨 모두 비어 있다고 말한다', async ({
    admin,
    page,
  }) => {
    // No account can trade (#119), so no database these specs run on holds a dispute: both halves
    // are empty, in the API and on screen.
    for (const status of ['pending', 'decided']) {
      const response = await admin.get(`/api/v1/admin/market-disputes?status=${status}`);
      const body = await response.text();
      expect(response.ok(), body).toBe(true);
      expect(
        JSON.parse(body) as { data: AdminDisputeQueueItem[]; meta: { nextCursor: string | null } },
        status,
      ).toEqual({ data: [], meta: { nextCursor: null } });
    }

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    const nav = page.getByTestId('admin-nav');
    expect((await nav.getByRole('link').allTextContents()).slice(0, 4)).toEqual([
      copy.adminMarkets,
      copy.adminMarketReviews,
      copy.adminThemes,
      copy.adminDisputes,
    ]);
    await nav.getByRole('link', { name: copy.adminDisputes, exact: true }).click();
    await expect(page).toHaveURL('/admin/disputes');
    const screen = page.getByTestId('admin-disputes');
    await expect(screen).toHaveAttribute('data-status', 'pending');
    await expect(screen.getByRole('heading', { level: 3 })).toHaveText(copy.adminDisputes);
    await expect(screen).toContainText(copy.adminDisputesIntro);
    const pending = page.getByTestId('admin-disputes-queue-pending');
    const decided = page.getByTestId('admin-disputes-queue-decided');
    await expect(pending).toHaveText(copy.adminDisputesPending);
    await expect(pending).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('admin-disputes-empty')).toHaveText(
      copy.adminDisputesEmptyPending,
    );

    await decided.click();
    await expect(page).toHaveURL('/admin/disputes?status=decided');
    await expect(screen).toHaveAttribute('data-status', 'decided');
    await expect(decided).toHaveAttribute('aria-current', 'page');
    await expect(pending).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('admin-disputes-empty')).toHaveText(
      copy.adminDisputesEmptyDecided,
    );

    await pending.click();
    await expect(page).toHaveURL('/admin/disputes');
    await expect(screen).toHaveAttribute('data-status', 'pending');
  });

  test('방문자는 MY 판정 이의에서도 제출 화면에서도 로그인으로 가고, 가입 절차가 남은 계정은 MY 판정 이의를 열지만 제출 화면은 온보딩으로 가며 API도 그 제출을 거절한다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const screenPath = `/markets/${market.slug}/dispute`;
    for (const path of ['/my/disputes', screenPath]) {
      await page.goto(path);
      await page.waitForURL(/\/login\?/);
      expect(new URL(page.url()).searchParams.get('next'), path).toBe(path);
    }

    // A new account with every step left (ADR-0089's precedent): MY '판정 이의' opens — a 철회
    // needs a session alone — and is empty; a new dispute is kept for after the onboarding (#57-8).
    await openSetPassword(page, freshEmail());
    await setFirstPassword(page);
    await expect(page).toHaveURL('/onboarding');
    await page.goto('/my/disputes');
    await expect(page.getByTestId('my-disputes-empty')).toHaveText(copy.myDisputesEmpty);
    await expect(page).toHaveURL('/my/disputes');
    await page.goto(screenPath);
    await page.waitForURL(/\/onboarding\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(screenPath);
    const refused = await sendDispute(page.request, market.id, { judgementVersion: 1 });
    const body = await refused.text();
    expect(refused.status(), body).toBe(409);
    expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe(
      'ONBOARDING_REQUIRED',
    );
  });
});
