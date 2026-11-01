import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import type { AdminMarket, AdminMarketSupplementItem, Market } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  adminAccount,
  approveSupplementAsReviewer,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  kstLocalOf,
  leaveNoSupplement,
  markDocument,
  meOf,
  requestSupplement,
  secondAdminAccount,
  sendSupplement,
  sendSupplementDecision,
  signIn,
  subscribed,
  test,
} from './helpers';

/**
 * 규칙 버전과 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·14·15, decision 3 '#80 보충의
 * 형태', ADR-0098 A2): the open records the content the review locked as rule v1, and a signed-out
 * visitor reads it on the detail's 규칙 버전 card — 현재 v1, 개장 때 고정. After the open the market's
 * rule version items — the question, the rule items and the times — change by a supplement alone:
 * an admin writes the new text of the items to change, the reason and the 정산 영향 검토 on the
 * admin detail's 규칙 보충 form, which says a change of meaning is no supplement (AC 8); the request
 * changes nothing and waits in 규칙 보충 대기 for another admin. Its requester may not decide it —
 * 승인·반려 are off under a note, and the API refuses them — and alone may retract it. Another
 * admin approves it on the same detail: the market takes the new text as its next version, and a
 * visitor's open detail follows without a reload — 현재 v2, and in the history the reason and each
 * changed item's text before and after, every earlier version's full text in a disclosure — with
 * no admin's name and no 정산 영향 검토. A reviewer who reads a change of meaning rejects it as 의미
 * 변경 and the rules stay as they were (the pause procedure is #114's). Once the market is closed
 * nothing is supplemented or approved; a request still waiting ends only by its 반려 or 철회, and
 * the history stays public.
 *
 * Admin 1 (`admin`) makes, opens and asks for every supplement here, so admin 2 — `secondAdmin`,
 * or the reviewer `admin` is paired with (helpers.ts `approveSupplementAsReviewer`) — is the one
 * who decides it, as on any database with the two seed admins. No market here has an announcement
 * time, so the lead close never depends on the release setting (docs/SETTINGS.md).
 *
 * Every refusal's details and order, the records (the version rows, the one `rules_supplemented`
 * event, the admin actions), the database's guard of a versioned market, the lock order, two
 * approvals at once and a PAUSED market (unreachable on screen until #114) are the API's and the
 * database's integration tests (admin-markets-supplement.controller.test.ts,
 * markets.controller.test.ts, private-data.test.ts, packages/db market-rules-content.test.ts and
 * schema.test.ts); the card, the panel, the form's rules and what a refusal says are unit-tested
 * (rule-versions-section.test.tsx, market-supplement-panel.test.tsx, lib/market-supplement.test.ts,
 * lib/rule-versions.test.ts). The 규칙 보충 대기 list is oldest first, so a database every earlier
 * run has added to may hold a spec's request past its first page: the list is paged through until
 * it shows (`showInSupplements`), and every test retracts what it left waiting.
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** A rule version's name as the screens compose it: 'v' and its number (lib/rule-versions.ts). */
function versionName(version: number): string {
  return `${copy.ruleVersionName}${String(version)}`;
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

/** Every request id the 규칙 보충 대기 list holds, read through to its last page. */
async function waitingSupplementIds(context: APIRequestContext): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await context.get(`/api/v1/admin/market-supplements?limit=100${after}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketSupplementItem[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((item) => item.requestId));
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return ids;
}

/**
 * Presses 더 보기 on the 규칙 보충 대기 list until `row` shows (market-review.spec.ts's
 * `showInQueue`): the list is oldest first, and earlier runs may have left requests waiting.
 */
async function showInSupplements(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-supplements-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-supplements',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-supplements-more"][data-loading]'),
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

/** The `POST /admin/markets/:id/supplements…` this page sends next to `suffix`. */
function nextSupplementWrite(page: Page, marketId: string, suffix: string) {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}/supplements${suffix}`,
  );
}

/** The ids of the change entries a version of the public card lists, in its order. */
function changeEntries(page: Page, versionTestId: string): Promise<(string | null)[]> {
  return page
    .getByTestId(`${versionTestId}-changes`)
    .locator(':scope > [data-testid]')
    .evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-testid')));
}

test.describe('규칙 버전', () => {
  test('로그인하지 않은 방문자는 연 시장의 규칙 v1을 읽고, 관리자가 화면에서 배경과 거래 마감을 보충으로 요청하면 바뀌는 것 없이 다른 관리자를 기다리며 요청한 관리자는 승인하지 못하고, 다른 관리자가 보충 대기에서 찾아 승인하면 열어 둔 상세가 리프레시 없이 v2와 이력(사유, 바뀐 항목의 이전·새 문구, 지난 버전의 전문)을 관리자와 정산 영향 검토 없이 보인다', async ({
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
    const background = market.ruleItems.description ?? '';
    const rewritten = `보충한 배경입니다. 발표 일정이 한 시간 늦춰졌습니다. 확인 코드 ${market.tag}.`;
    // Later by an hour, to the minute, well before the scheduled judgement (A2).
    const closeAt = minuteIso(Date.parse(market.closeAt) + HOUR_MS);
    const reason = `발표 일정이 한 시간 늦춰져 배경과 거래 마감을 고칩니다 ${market.tag}`;
    const impact = `판정 기준과 출처가 그대로라 판정과 지급에 영향이 없습니다 ${market.tag}`;
    const decision = `의미가 바뀌지 않는 보충입니다 ${market.tag}`;

    // --- the visitor, signed out: 규칙 버전 after 규칙 says 현재 v1, fixed at the open, with no
    // reason, no change and no full text of its own — the rules area above is its text.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const card = detailCopyTestId(page, 'market-rule-versions');
    await expect(page.getByTestId(card).getByRole('heading', { level: 2 })).toHaveText(
      copy.ruleVersionsTitle,
    );
    await expect(page.getByTestId(`${card}-current`)).toHaveText(
      `${copy.ruleVersionsCurrent} ${versionName(1)}`,
    );
    const v1 = `${card}-version-1`;
    await expect(page.getByTestId(v1)).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId(`${v1}-fixed`)).toHaveText(copy.ruleVersionsFixedAtOpen);
    for (const part of ['reason', 'changes', 'full']) {
      await expect(page.getByTestId(`${v1}-${part}`)).toHaveCount(0);
    }
    // When it began: the open — the review's approval, past the scheduled open (#21).
    const atOpen = await publicMarketOf(request, market.id);
    expect(atOpen.ruleVersion).toBe(1);
    expect(atOpen.ruleVersions.map((version) => version.version)).toEqual([1]);
    expect(Date.parse(atOpen.ruleVersions[0]?.createdAt ?? '')).toBe(
      Date.parse(atOpen.openAt ?? ''),
    );
    await expect(page.getByTestId(`${v1}-at-viewer-zone`)).toHaveText(
      formatKst(atOpen.ruleVersions[0]?.createdAt ?? ''),
    );
    await markDocument(page);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1's detail: the 규칙 보충 panel, its current version and v1 opened by admin 2
      // (the review's approver), and nothing asked for yet.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-supplement')).toHaveAttribute(
        'data-status',
        'open',
      );
      await expect(firstPage.getByTestId('market-supplement-version')).toHaveText(
        `${copy.adminMarketSupplementVersion} ${versionName(1)}`,
      );
      await expect(firstPage.getByTestId('market-supplement-version-1-rows')).toContainText(
        `${copy.adminRuleVersionOpenedBy} ${secondName}`,
      );
      await expect(firstPage.getByTestId('market-supplement-log-empty')).toHaveText(
        copy.adminMarketSupplementLogEmpty,
      );

      // --- 보충 요청: the form holds the market as it is, against v1, and says a change of meaning
      // is no supplement (AC 8); the scheduled open and judgement are locked (#172 item 14). Focus
      // goes into the form as it opens and back to 보충 요청 as it closes (the button and the form
      // take each other's place).
      await letToastsGo(firstPage);
      const requestButton = firstPage.getByTestId('market-supplement-request');
      await requestButton.click();
      const form = firstPage.getByTestId('market-supplement-form');
      await expect(form.getByTestId('market-supplement-form-title')).toBeFocused();
      await form.getByTestId('market-supplement-cancel').click();
      await expect(form).toHaveCount(0);
      await expect(requestButton).toBeFocused();
      await requestButton.click();
      await expect(form.getByTestId('market-supplement-form-title')).toBeFocused();
      await expect(form.getByTestId('market-supplement-form-base')).toHaveText(
        `${copy.adminMarketSupplementBase} ${versionName(1)}`,
      );
      await expect(form.getByTestId('market-supplement-boundary')).toHaveText(
        copy.adminMarketSupplementBoundary,
      );
      await expect(form.getByTestId('market-title')).toHaveValue(market.title);
      await expect(form.getByTestId('market-description')).toHaveValue(background);
      await expect(form.getByTestId('market-scheduled-open-at')).toBeDisabled();
      await expect(form.getByTestId('market-scheduled-judgement-at')).toBeDisabled();

      // The new 배경 and close with no reason and no 정산 영향 검토: refused under both, nothing sent.
      const sent: string[] = [];
      firstPage.on('request', (write) => {
        if (write.method() === 'POST' && new URL(write.url()).pathname.endsWith('/supplements')) {
          sent.push(write.url());
        }
      });
      await form.getByTestId('market-description').fill(rewritten);
      await form.getByTestId('market-close-at').fill(kstLocalOf(closeAt));
      await form.getByTestId('market-supplement-submit').click();
      await expect(form.getByTestId('market-supplement-reason-error')).toHaveText(
        copy.errMarketReviewReason,
      );
      await expect(form.getByTestId('market-supplement-impact-error')).toHaveText(
        copy.errMarketSupplementImpact,
      );
      expect(sent).toEqual([]);

      // --- with both: sent as the two changed items alone, against v1, naming admin 1.
      await form.getByTestId('market-supplement-reason').fill(reason);
      await form.getByTestId('market-supplement-impact').fill(impact);
      const requested = nextSupplementWrite(firstPage, market.id, '');
      await form.getByTestId('market-supplement-submit').click();
      expect((await requested).postDataJSON()).toEqual({
        baseVersion: 1,
        changes: { description: rewritten, closeAt },
        reason,
        settlementImpact: impact,
        expectedAccountId: first.id,
      });
      await expect(firstPage.getByText(copy.adminMarketSupplementRequested)).toBeVisible();
      await expect(form).toHaveCount(0);
      // 보충 요청 is not drawn while a request waits: focus lands on the waiting request's heading.
      await expect(firstPage.getByTestId('market-supplement-pending-title')).toBeFocused();

      // --- waiting: each item's text now and after, the reason and the review; its requester may
      // not decide it (the note says why) and alone may retract it, and one waits at a time.
      const pending = firstPage.getByTestId('market-supplement-pending');
      await expect(pending).toBeVisible();
      await expect(firstPage.getByTestId('market-supplement-pending-by')).toHaveText(firstName);
      await expect(firstPage.getByTestId('market-supplement-pending-base')).toHaveText(
        versionName(1),
      );
      for (const [item, before, after] of [
        ['description', background, rewritten],
        ['closeAt', formatKst(market.closeAt), formatKst(closeAt)],
      ] as const) {
        const row = `market-supplement-pending-change-${item}`;
        await expect(firstPage.getByTestId(`${row}-before`)).toHaveText(before);
        await expect(firstPage.getByTestId(`${row}-after`)).toHaveText(after);
      }
      await expect(firstPage.getByTestId('market-supplement-pending-reason')).toHaveText(reason);
      await expect(firstPage.getByTestId('market-supplement-pending-impact')).toHaveText(impact);
      await expect(firstPage.getByTestId('market-supplement-requester-note')).toHaveText(
        copy.adminMarketSupplementExcludedRequester,
      );
      await expect(firstPage.getByTestId('market-supplement-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-supplement-reject')).toBeDisabled();
      await expect(firstPage.getByTestId('market-supplement-retract')).toBeEnabled();
      await expect(firstPage.getByTestId('market-supplement-request')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-supplement-log-0')).toHaveAttribute(
        'data-status',
        'pending',
      );
      const waiting = await adminMarketOf(admin, market.id);
      const requestId = waiting.supplement.pending?.requestId;
      if (requestId === undefined) throw new Error('no supplement waits');
      expect(waiting).toMatchObject({ ruleVersion: 1, description: background });
      expect(
        await refusalOf(
          await sendSupplementDecision(admin, market.id, requestId, 'approve', { reason }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'requester' }]);
      expect(
        await refusalOf(
          await sendSupplement(admin, market.id, { title: `${market.title} 둘째` }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['supplement'], message: 'pending' }]);
      // Asked for, nothing public moved: the visitor still reads v1 and the old 배경.
      await expect(page.getByTestId(`${card}-current`)).toHaveText(
        `${copy.ruleVersionsCurrent} ${versionName(1)}`,
      );

      // --- admin 2 finds it in 규칙 보충 대기, under 검수 대기: the question to its detail, who
      // asked, and the items it changes.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      expect(await waitingSupplementIds(secondAdmin)).toContain(requestId);
      await secondPage.goto('/admin/markets/reviews');
      const row = secondPage.getByTestId(`admin-market-supplement-${requestId}`);
      await showInSupplements(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(
        secondPage.getByTestId(`admin-market-supplement-requested-by-${requestId}`),
      ).toHaveText(firstName);
      await expect(secondPage.getByTestId(`admin-market-supplement-items-${requestId}`)).toHaveText(
        `${copy.openItemDescription} · ${copy.openItemCloseAt}`,
      );
      await secondPage.getByTestId(`admin-market-supplement-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- 승인 with a reason: the market takes the new text as v2 at once.
      await expect(secondPage.getByTestId('market-supplement-requester-note')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-retract')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-reject')).toBeEnabled();
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-supplement-approve').click();
      const dialog = secondPage.getByTestId('market-supplement-approve-dialog');
      const confirm = dialog.getByTestId('market-supplement-approve-dialog-confirm');
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-supplement-approve-reason').fill(decision);
      await expect(confirm).toBeEnabled();
      const approved = nextSupplementWrite(secondPage, market.id, `/${requestId}/approve`);
      await confirm.click();
      expect((await approved).postDataJSON()).toEqual({
        reason: decision,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketSupplementApproved)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-version')).toHaveText(
        `${copy.adminMarketSupplementVersion} ${versionName(2)}`,
      );
      await expect(secondPage.getByTestId('market-supplement-pending')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-log-0')).toHaveAttribute(
        'data-status',
        'approved',
      );
      // The admin's list of versions names who asked and who approved, and the review.
      const v2Rows = secondPage.getByTestId('market-supplement-version-2-rows');
      await expect(v2Rows).toContainText(`${copy.adminMarketSupplementRequestedBy} ${firstName}`);
      await expect(v2Rows).toContainText(`${copy.adminRuleVersionApprovedBy} ${secondName}`);
      await expect(v2Rows).toContainText(`${copy.adminMarketSupplementImpact} ${impact}`);
      expect(await waitingSupplementIds(secondAdmin)).not.toContain(requestId);
    } finally {
      await leaveNoSupplement(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }

    // --- the visitor's detail, never reloaded: 현재 v2, its reason and each changed item's text
    // before and after, in the items' order; the 배경 and the rules above read the new text.
    await expect(page.getByTestId(`${card}-current`)).toHaveText(
      `${copy.ruleVersionsCurrent} ${versionName(2)}`,
    );
    const v2 = `${card}-version-2`;
    await expect(page.getByTestId(v2)).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId(v1)).not.toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId(`${v2}-reason`)).toHaveText(reason);
    expect(await changeEntries(page, v2)).toEqual([
      `${v2}-change-description`,
      `${v2}-change-closeAt`,
    ]);
    await expect(page.getByTestId(`${v2}-change-description-before`)).toHaveText(background);
    await expect(page.getByTestId(`${v2}-change-description-after`)).toHaveText(rewritten);
    await expect(page.getByTestId(`${v2}-change-closeAt-before-viewer-zone`)).toHaveText(
      formatKst(market.closeAt),
    );
    await expect(page.getByTestId(`${v2}-change-closeAt-after-viewer-zone`)).toHaveText(
      formatKst(closeAt),
    );
    const backgroundId = detailCopyTestId(page, 'market-background');
    await expect(page.getByTestId(`${backgroundId}-text`)).toHaveText(rewritten);
    const rules = detailCopyTestId(page, 'market-rules');
    await expect(page.getByTestId(`${rules}-close-at-viewer-zone`)).toHaveText(formatKst(closeAt));
    // The current version's text is the rules area; v1's is a disclosure that opens it whole.
    await expect(page.getByTestId(`${v2}-full`)).toHaveCount(0);
    const full = page.getByTestId(`${v1}-full`);
    await full.locator('summary').click();
    await expect(full).toHaveAttribute('open', '');
    await expect(page.getByTestId(`${v1}-full-description`)).toHaveText(background);
    await expect(page.getByTestId(`${v1}-full-closeAt-viewer-zone`)).toHaveText(
      formatKst(market.closeAt),
    );
    expect(await documentSurvived(page)).toBe(true);
    // No admin and no 정산 영향 검토 on it (#172 item 15, #173 item 13's analogue).
    for (const hidden of [firstName, secondName, impact, decision]) {
      await expect(page.getByTestId(card)).not.toContainText(hidden);
    }

    // --- what the API says: v2 then v1, each its number, time, changed items, reason and full
    // text — nothing else; and the server's HTML holds the history, the review nowhere.
    const supplemented = await publicMarketOf(request, market.id);
    expect(supplemented).toMatchObject({ ruleVersion: 2, description: rewritten });
    expect(supplemented.ruleVersions.map((version) => version.version)).toEqual([2, 1]);
    expect(supplemented.ruleVersions[0]).toMatchObject({
      changedItems: ['description', 'closeAt'],
      reason,
      content: { description: rewritten },
    });
    for (const version of supplemented.ruleVersions) {
      expect(Object.keys(version).sort()).toEqual([
        'changedItems',
        'content',
        'createdAt',
        'reason',
        'version',
      ]);
    }
    const publicBody = await (await request.get(`/api/v1/markets/${market.id}`)).text();
    for (const hidden of [impact, decision, first.id, second.id]) {
      expect(publicBody).not.toContain(hidden);
    }
    const html = await (await request.get(`/markets/${market.slug}`)).text();
    for (const text of [copy.ruleVersionsFixedAtOpen, reason, background, rewritten]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain(impact);
  });

  test('다른 관리자가 의미가 바뀌는 보충을 의미 변경으로 반려하면 규칙은 그대로이고, 기다리는 보충은 요청한 관리자만 철회한다', async ({
    admin,
    secondAdmin,
    browser,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createOpenMarket(admin);
    const reworded = `사건 기한까지 확인 코드가 두 번 발표되면 YES입니다. 확인 코드 ${market.tag}.`;
    const reason = `YES 조건을 더 분명하게 고칩니다 ${market.tag}`;
    const rejection = `두 번 발표를 요구하면 질문의 뜻이 바뀝니다 ${market.tag}`;

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1 asks for a YES 조건 that changes what YES means.
      const asked = await requestSupplement(
        admin,
        market.id,
        { yesCondition: reworded },
        { reason },
      );
      const rejectedId = asked.supplement.pending?.requestId ?? '';

      // --- admin 2 reads it and rejects it as 의미 변경: the dialog says a 반려 keeps the rules and
      // does not pause the market — stopping trading to review is done apart (#114; AC 8 is the
      // request form's boundary note); its confirm waits for a reason from the list and a 설명.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      const row = 'market-supplement-pending-change-yesCondition';
      await expect(secondPage.getByTestId(`${row}-before`)).toHaveText(market.yesCondition);
      await expect(secondPage.getByTestId(`${row}-after`)).toHaveText(reworded);
      await expect(secondPage.getByTestId('market-supplement-approve')).toBeEnabled();
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-supplement-reject').click();
      const dialog = secondPage.getByTestId('market-supplement-reject-dialog');
      await expect(dialog).toContainText(copy.adminMarketSupplementRejectBody);
      const confirm = dialog.getByTestId('market-supplement-reject-dialog-confirm');
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId('market-supplement-reject-reason').selectOption('meaning_change');
      await dialog.getByTestId('market-supplement-reject-description').fill(rejection);
      await expect(confirm).toBeEnabled();
      const rejected = nextSupplementWrite(secondPage, market.id, `/${rejectedId}/reject`);
      await confirm.click();
      expect((await rejected).postDataJSON()).toEqual({
        rejectReason: 'meaning_change',
        reason: rejection,
        expectedAccountId: second.id,
      });
      await expect(secondPage.getByText(copy.adminMarketSupplementRejected)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-pending')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-supplement-log-0')).toHaveAttribute(
        'data-status',
        'rejected',
      );
      await expect(secondPage.getByTestId('market-supplement-log-0-status')).toHaveText(
        copy.supplementStatusRejected,
      );
      const logRows = secondPage.getByTestId('market-supplement-log-0-rows');
      await expect(logRows).toContainText(
        `${copy.supplementLogRejectReason} ${copy.supplementRejectMeaningChange}`,
      );
      await expect(logRows).toContainText(`${copy.supplementLogDecisionReason} ${rejection}`);
      await expect(secondPage.getByTestId('market-supplement-version')).toHaveText(
        `${copy.adminMarketSupplementVersion} ${versionName(1)}`,
      );

      // The rules stay as they were: still v1, the YES 조건 as it was, no supplement event.
      expect(await publicMarketOf(request, market.id)).toMatchObject({
        ruleVersion: 1,
        yesCondition: market.yesCondition,
      });
      expect(
        (await adminMarketOf(admin, market.id)).events.map((event) => event.type),
      ).not.toContain('rules_supplemented');

      // --- another request, for the title; admin 2 may not retract it, admin 1 does on screen.
      const retitled = await requestSupplement(admin, market.id, {
        title: `${market.title} (고친 제목)`,
      });
      const retractedId = retitled.supplement.pending?.requestId ?? '';
      expect(
        await refusalOf(
          await sendSupplementDecision(secondAdmin, market.id, retractedId, 'retract'),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'not_requester' }]);
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      await expect(firstPage.getByTestId('market-supplement-approve')).toBeDisabled();
      await expect(firstPage.getByTestId('market-supplement-reject')).toBeDisabled();
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-supplement-retract').click();
      const retracted = nextSupplementWrite(firstPage, market.id, `/${retractedId}/retract`);
      await firstPage.getByTestId('market-supplement-retract-dialog-confirm').click();
      expect((await retracted).postDataJSON()).toEqual({ expectedAccountId: first.id });
      await expect(firstPage.getByText(copy.adminMarketSupplementRetracted)).toBeVisible();
      await expect(firstPage.getByTestId('market-supplement-pending')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-supplement-log-0-status')).toHaveText(
        copy.supplementStatusRetracted,
      );
      await expect(firstPage.getByTestId('market-supplement-log-1-status')).toHaveText(
        copy.supplementStatusRejected,
      );
      await expect(firstPage.getByTestId('market-supplement-request')).toBeEnabled();
      // Retracted, it is decided by no one.
      expect(
        await refusalOf(
          await sendSupplementDecision(secondAdmin, market.id, retractedId, 'approve', {
            reason: rejection,
          }),
          409,
          'APPROVAL_NOT_ALLOWED',
        ),
      ).toEqual([{ path: ['request'], message: 'retracted' }]);
      expect((await publicMarketOf(request, market.id)).title).toBe(market.title);
    } finally {
      await leaveNoSupplement(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }
  });

  test('거래를 마감한 시장은 보충을 받지도 승인하지도 않고, 기다리던 보충은 철회나 반려로만 끝나며, 규칙 버전 이력은 그대로 공개된다', async ({
    admin,
    secondAdmin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const title = `${market.title} (보충한 제목)`;
    const reason = `질문을 더 분명하게 다듬습니다 ${market.tag}`;
    const adminContext = await browser.newContext();
    try {
      await requestSupplement(admin, market.id, { title }, { reason });
      expect((await approveSupplementAsReviewer(admin, market.id)).ruleVersion).toBe(2);
      const waiting = await requestSupplement(admin, market.id, {
        description: `마감 전에 고치려던 배경입니다. 확인 코드 ${market.tag}.`,
      });
      const requestId = waiting.supplement.pending?.requestId ?? '';

      // --- closed (#172 item 15: no supplement after the close): neither a new request nor the
      // waiting one's approval is taken.
      expect((await closeMarket(admin, market.id)).status).toBe('closed');
      const notOpen = [{ path: ['status'], message: 'not open or paused' }];
      expect(
        await refusalOf(
          await sendSupplementDecision(secondAdmin, market.id, requestId, 'approve', { reason }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual(notOpen);
      expect(
        await refusalOf(
          await sendSupplement(admin, market.id, { title: `${title} 다시` }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual(notOpen);

      // --- the visitor, signed out: the closed market's history as it was — 현재 v2 with the
      // question before and after, and v1's full text.
      await page.goto(`/markets/${market.slug}`);
      await expect(page.getByTestId('watch-button')).toBeVisible();
      const card = detailCopyTestId(page, 'market-rule-versions');
      await expect(page.getByTestId(`${card}-current`)).toHaveText(
        `${copy.ruleVersionsCurrent} ${versionName(2)}`,
      );
      await expect(page.getByTestId(`${card}-version-2-reason`)).toHaveText(reason);
      await expect(page.getByTestId(`${card}-version-2-change-title-before`)).toHaveText(
        market.title,
      );
      await expect(page.getByTestId(`${card}-version-2-change-title-after`)).toHaveText(title);
      await expect(page.getByTestId(`${card}-version-1-full-title`)).toHaveText(market.title);

      // --- admin 1's detail: no 보충 요청 for a closed market, and the waiting request offers its
      // 철회 alone — no 승인, the note says why — which still ends it.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${market.id}`);
      await expect(adminPage.getByTestId('market-supplement')).toHaveAttribute(
        'data-status',
        'closed',
      );
      const unavailable = adminPage.getByTestId('market-supplement-unavailable');
      await expect(unavailable).toHaveAttribute('data-reason', 'status');
      await expect(unavailable).toHaveText(copy.adminMarketSupplementUnavailableStatus);
      await expect(adminPage.getByTestId('market-supplement-request')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-supplement-pending-closed')).toHaveText(
        copy.adminMarketSupplementPendingClosed,
      );
      await expect(adminPage.getByTestId('market-supplement-approve')).toBeDisabled();
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-supplement-retract').click();
      const retracted = nextSupplementWrite(adminPage, market.id, `/${requestId}/retract`);
      await adminPage.getByTestId('market-supplement-retract-dialog-confirm').click();
      await retracted;
      await expect(adminPage.getByText(copy.adminMarketSupplementRetracted)).toBeVisible();
      await expect(adminPage.getByTestId('market-supplement-pending')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-supplement-version')).toHaveText(
        `${copy.adminMarketSupplementVersion} ${versionName(2)}`,
      );
      const closed = await adminMarketOf(admin, market.id);
      expect(closed).toMatchObject({ status: 'closed', ruleVersion: 2, title });
      expect(closed.supplement.log.map((entry) => entry.status)).toEqual(['retracted', 'approved']);
    } finally {
      await leaveNoSupplement(admin, market.id);
      await adminContext.close();
    }
  });
});

/**
 * The card at a phone's width (PLAN 13 M4 AC 5's 375px, pinned here so both projects measure it):
 * a version's changed texts and an earlier version's full text, opened, stay inside the screen.
 */
test.describe('규칙 버전 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('375px에서 규칙 버전 카드는 바뀐 항목의 이전·새 문구와 펼친 지난 버전의 전문까지 가로로 넘치지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    // A long 배경 with a word of 70-odd letters in it, which has no place to break but its letters.
    const rewritten =
      `보충한 배경입니다. 발표 문서 E2E-${'announcement'.repeat(6)}에서 확인합니다. ` +
      `${'발표 일정이 바뀌어도 판정 기준은 그대로입니다. '.repeat(4)}확인 코드 ${market.tag}.`;
    try {
      await requestSupplement(admin, market.id, {
        title: `${market.title} — 발표 일정이 바뀐 시장의 질문을 다듬었습니다`,
        description: rewritten,
      });
      await approveSupplementAsReviewer(admin, market.id);
    } finally {
      await leaveNoSupplement(admin, market.id);
    }

    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const card = detailCopyTestId(page, 'market-rule-versions');
    expect(card).toBe('market-rule-versions-base');
    await expect(page.getByTestId(`${card}-version-2-change-description-after`)).toHaveText(
      rewritten,
    );
    const full = page.getByTestId(`${card}-version-1-full`);
    await full.locator('summary').click();
    await expect(full).toHaveAttribute('open', '');
    await expect(page.getByTestId(`${card}-version-1-full-description`)).toBeVisible();
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
    const box = await page.getByTestId(card).boundingBox();
    if (box === null) throw new Error('the card has no bounding box');
    expect(box.x + box.width).toBeLessThanOrEqual(width.client);
  });
});
