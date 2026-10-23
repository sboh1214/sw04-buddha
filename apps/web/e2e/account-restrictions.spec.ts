import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import { fillBusinessInfo } from '../src/legal/business-info';
import { deadlineOnCard, expectDeadlineLine } from './appeal';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  secondAdminAccount,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 계정 제한 (#139, ADR-0085; owner decisions in ADR-0069 decision 1 #57-12…#57-15, decision 3 #37-8
 * and #37-9, decision 4 #139 and #140 rows; ADR-0056 decision 1-7 — another admin's approval),
 * walked on the screens with three browsers — the member, the operator who asks (the first seed
 * admin) and the one who approves (the second), the brief's «admin A requests, admin B approves,
 * user sees notice in MY»:
 *
 * - the first operator asks, from the member's page, for a 7-day account restriction — one of the
 *   owner's eight reasons and a required explanation, a term picked (none by default), and the
 *   operators' memo (optional, owner decision 2026-10-23); nothing is in force while it waits (no
 *   banner for the member), and the operator who asked is offered no decision on it, only its
 *   retraction; the second operator finds it in 계정 제한 요청 — with the memo — and approves it
 *   with a reason — the term counts from the approval — and the member's page then lists it
 *   '진행 중' with who approved and why; the member sees the banner on MY 요약 and MY 설정 (the end
 *   and the way to 조치·신고 내역, no reason, no operator, no memo), a new 소개 is refused with the
 *   account restriction's sentence, the end and that way, clearing it stays open, a post goes up
 *   under no banner (an account restriction blocks no writing, #57-12, and its banner is MY 요약's
 *   and MY 설정's only — owner decision 2026-10-23), and 조치·신고 내역 lists it with its reason,
 *   explanation, end and appeal deadline and no operator or memo; the first operator then asks for
 *   its 조기 해제, the second approves it, and the banner goes while 조치·신고 내역 says '조기 해제됨'
 *   and the end it was given;
 * - from a reported post's page the first operator asks for its author's account restriction about
 *   that post — the request names the post — and the report stays pending until a decision; the
 *   second operator rejects the request with a reason — nothing is done, the report still waits,
 *   the member has no banner — and the report is dismissed before the test ends;
 * - with two account restrictions standing (무기한 and 7일), the first operator asks, from the
 *   member's page, for the 무기한 one's 감경: the request's line names that one — when it was given,
 *   its end now and its reason, linked to its row — and the end asked for; nothing changes until
 *   the second operator approves it, and then the row and the member's 조치·신고 내역 say 감경; its
 *   취소 is asked and approved the same way;
 * - the first operator asks for a member's account restriction and retracts it before anyone
 *   decides it (owner decision 2026-10-23): it leaves the waiting list for 철회됨, with when, the
 *   second operator can no longer decide it, and nothing is in force;
 * - with a writing restriction (#185) and an account restriction standing together, MY 요약 and
 *   MY 설정 show one banner with both titles and ends and one link, and the write page the writing
 *   restriction's alone — the one SanctionBanner keeping both owners' rules (restacked on #185 and
 *   #186, ADR-0085 결과 5).
 *
 * On 조치·신고 내역 the guidance is the page's, once above the list, and an account restriction's
 * card gives its '이의 기한' from when its approval put it in force — unmoved by a 감경 or an early
 * lift, gone once it is cancelled (#186, ADR-0084 결과 5); no banner or refusal says anything of
 * the appeal.
 *
 * Every rule's branch (the two-person rule's refusals, the moot requests, the triggers, the trading
 * check, the privacy guard) is the API's test (account-restrictions.controller.test.ts); the
 * wording's is the web's unit tests (lib/restriction.test.ts, lib/moderation.test.ts). Every
 * restriction a test gives ends before it does, and every report it files is processed.
 */

/** A post straight at the API with the context's cookie. */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string,
  text: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/**
 * Opens `path` and waits until the member's own restrictions (`GET /me/moderation/restriction`,
 * read in the browser once the session is known) have answered and been drawn: the banner draws
 * nothing while they are read, so a check that it is absent proves nothing before it. The page
 * before is left for a blank one first, as restrictions.spec.ts does.
 */
async function gotoWithRestrictionRead(page: Page, path: string): Promise<void> {
  await page.goto('about:blank');
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/me/moderation/restriction',
  );
  await page.goto(path);
  const response = await read;
  expect(response.status(), await response.text()).toBe(200);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** An instant as the screens write it in Korean time (`formatKst`'s rule, restrictions.spec.ts). */
function kst(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  })
    .formatToParts(new Date(iso))
    .map((part) =>
      part.type === 'dayPeriod'
        ? ({ AM: '오전', PM: '오후' }[part.value] ?? part.value)
        : part.value,
    )
    .join('');
}

/**
 * The appeal's guidance as 조치·신고 내역 words it, once above the actions (`copy.appealGuidance`,
 * #186), up to its email: never on a banner or a refusal (ADR-0084 결과 5's #139 item).
 */
const APPEAL_START = copy.appealGuidance.slice(0, copy.appealGuidance.indexOf('{{'));

/** A refusal's way to 조치·신고 내역 (`RefusalText`): the link under the end, no appeal sentence. */
async function expectModerationLink(refusal: Locator): Promise<void> {
  await expect(refusal.getByTestId('restricted-moderation-link')).toHaveAttribute(
    'href',
    '/my/moderation',
  );
  await expect(refusal).not.toContainText(APPEAL_START);
  await expect(refusal).not.toContainText('이의');
}

/** The `datetime-local` value of an instant in Korean time, as the admin's input reads it. */
function kstLocal(ms: number): string {
  const shifted = new Date(ms + 9 * 60 * 60 * 1_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** A request as the API answers it. */
interface Request {
  id: string;
  status: string;
  apply: { subject: unknown } | null;
}

/** A restriction as the API answers it. */
interface Restriction {
  id: string;
  createdAt: string;
  endsAt: string | null;
}

/** Sends the open dialog and waits for the POST to `path` to answer 200 with `data`. */
async function sendDialog<T>(page: Page, path: string): Promise<T> {
  const answer = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === path,
  );
  await page.getByTestId('moderation-submit').click();
  const response = await answer;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

/**
 * Shows `entry` on 계정 제한 요청's pending half: requests left from earlier runs wait there too
 * (the oldest first), so 더 보기 is followed until it shows.
 */
async function showInRequests(page: Page, entry: Locator): Promise<void> {
  const more = page.getByTestId('admin-account-requests-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(entry).first()).toBeVisible();
    if (await entry.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname ===
          '/api/v1/admin/moderation/account-restriction-requests',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-account-requests-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(entry).toBeVisible();
}

test.describe('계정 제한', () => {
  test('운영자가 회원 화면에서 7일 계정 제한을 요청하면 승인 전에는 아무것도 바뀌지 않고, 다른 운영자가 계정 제한 요청에서 승인하면 회원의 MY 요약·MY 설정에 끝나는 때와 조치·신고 내역 링크의 띠가 보이고 새 소개는 거절되며 글은 올라가고, 조치·신고 내역에 사유·설명·끝나는 때·이의 기한이 운영자 없이 보이며, 조기 해제도 요청과 승인으로 끝난다', async ({
    admin,
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const bio = await page.request.put('/api/v1/me/bio', {
      data: { bio: `제한 전 소개 ${tag}`, expectedAccountId: member.id },
    });
    expect(bio.status(), await bio.text()).toBe(200);

    const askingContext = await browser.newContext();
    const approvingContext = await browser.newContext();
    try {
      // --- the first operator asks, from the member's page: a term, a reason and the
      // explanation are all needed (#57-12 «정한 목록에서 하나 … 와 필수 설명»).
      const asking = await askingContext.newPage();
      await signIn(asking, adminAccount.email, adminAccount.password);
      const askingMe = await meOf(asking.request);
      await asking.goto(`/admin/moderation/users/${member.id}`);
      await asking.getByTestId('moderation-account-restrict').click();
      const dialog = asking.getByTestId('moderation-account-restrict-dialog');
      await expect(dialog).toContainText(copy.adminModerationAccountRestrictBody);
      await expect(
        dialog.locator('[data-testid^="moderation-term-"] [data-part="item-text"]'),
      ).toHaveText(['1일', '3일', '7일', '30일', copy.restrictionIndefinite]);
      await expect(dialog.getByTestId('moderation-reason').locator('option')).toHaveText([
        copy.adminModerationReasonPlaceholder,
        copy.reportReasonSpam,
        copy.reportReasonHarassment,
        copy.reportReasonPersonalInfo,
        copy.reportReasonImpersonation,
        copy.reportReasonCollusionManipulation,
        copy.reportReasonAbnormalTrading,
        copy.reportReasonMultiAccount,
        copy.reportReasonOther,
      ]);
      await asking.getByTestId('moderation-submit').click();
      await expect(dialog.getByTestId('moderation-term-error')).toHaveText(
        copy.errModerationTermRequired,
      );
      await expect(dialog).toContainText(copy.errModerationReasonRequired);
      await expect(dialog.getByTestId('moderation-text-error')).toHaveText(
        copy.errModerationAccountNoteRequired,
      );
      await asking.getByTestId('moderation-term-7').click();
      await asking.getByTestId('moderation-reason').selectOption('multi_account');
      const note = `한 사람이 여러 계정으로 거래했습니다 ${tag}`;
      await asking.getByTestId('moderation-note').fill(note);
      // The operators' memo: optional, for the operators (the one asking too), never the member's.
      await expect(dialog).toContainText(copy.adminModerationAccountMemoHint);
      const memo = `같은 기기에서 다섯 계정 ${tag}`;
      await asking.getByTestId('moderation-memo').fill(memo);
      const request = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/users/${member.id}/account-restriction`,
      );
      expect(request.status).toBe('pending');
      await expect(asking.getByText(copy.adminModerationAccountRequested)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      // Waiting on the member's page — the one who asked is offered no decision on it.
      const waiting = asking
        .getByTestId('moderation-account-requests')
        .getByTestId(`account-request-${request.id}`);
      await expect(waiting.getByTestId('account-request-status')).toHaveText(
        copy.approvalStatusPending,
      );
      await expect(waiting.getByTestId('account-request-term')).toContainText('7일');
      await expect(waiting).toContainText(note);
      await expect(waiting.getByTestId('account-request-memo')).toContainText(memo);
      await expect(waiting.getByTestId('account-request-own')).toHaveText(
        copy.adminAccountRequestOwn,
      );
      await expect(waiting.getByTestId('account-request-approve')).toHaveCount(0);
      await expect(waiting.getByTestId('account-request-reject')).toHaveCount(0);
      // Its retraction is the one who asked's (owner decision 2026-10-23).
      await expect(waiting.getByTestId('account-request-retract')).toHaveText(
        copy.adminAccountRequestRetract,
      );

      // --- the member: nothing is in force while it waits.
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);

      // --- the second operator: 계정 제한 요청 from the area's row, the request, 승인 with a reason.
      const approving = await approvingContext.newPage();
      await signIn(approving, secondAdminAccount.email, secondAdminAccount.password);
      // The `secondAdmin` fixture has taken the second seed admin through its onboarding.
      const approvingMe = await meOf(secondAdmin);
      await approving.goto('/admin/reports');
      await approving
        .getByTestId('moderation-nav')
        .getByRole('link', { name: copy.adminAccountRequests, exact: true })
        .click();
      await expect(approving).toHaveURL('/admin/moderation/account-restriction-requests');
      const entry = approving.getByTestId(`account-request-${request.id}`);
      await showInRequests(approving, entry);
      await expect(entry.getByTestId('account-request-change')).toHaveText(
        copy.adminAccountRequestChangeApply,
      );
      await expect(entry).toContainText(member.profile.nickname);
      await expect(entry).toContainText(copy.reportReasonMultiAccount);
      await expect(entry).toContainText(askingMe.profile.nickname);
      await expect(entry.getByTestId('account-request-memo')).toContainText(memo);
      await expect(entry.getByTestId('account-request-retract')).toHaveCount(0);
      await entry.getByTestId('account-request-approve').click();
      const approve = approving.getByTestId('account-request-approve-dialog');
      await expect(approve).toContainText(copy.adminAccountRequestApproveApplyBody);
      await approving.getByTestId('moderation-submit').click();
      await expect(approve.getByTestId('moderation-text-error')).toHaveText(
        copy.errModerationRecordRequired,
      );
      const approvalReason = `증거를 확인했습니다 ${tag}`;
      await approving.getByTestId('moderation-record').fill(approvalReason);
      const decision = await sendDialog<{ request: Request; action: Restriction }>(
        approving,
        `/api/v1/admin/moderation/account-restriction-requests/${request.id}/approve`,
      );
      expect(decision.request.status).toBe('approved');
      const restriction = decision.action;
      // The term counts from the approval: seven days of 24 hours from the restriction's time.
      expect(Date.parse(restriction.endsAt!) - Date.parse(restriction.createdAt)).toBe(
        7 * 24 * 60 * 60 * 1_000,
      );
      const endsAt = restriction.endsAt!;
      await expect(approving.getByText(copy.adminAccountRequestApproved)).toBeVisible();
      await expect(entry).toHaveCount(0);
      // Decided: on the other half, approved, with who decided and why.
      await approving.getByTestId('admin-account-requests-queue-decided').click();
      await expect(approving).toHaveURL(
        '/admin/moderation/account-restriction-requests?status=decided',
      );
      const decided = approving.getByTestId(`account-request-${request.id}`);
      await expect(decided.getByTestId('account-request-status')).toHaveText(
        copy.approvalStatusApproved,
      );
      await expect(decided).toContainText(approvalReason);

      // The member's page: the restriction, 진행 중, who asked and who approved.
      await asking.reload();
      const row = asking
        .getByTestId('moderation-author-actions')
        .getByTestId(`moderation-action-${restriction.id}`);
      await expect(row.getByTestId('moderation-action-type')).toHaveText(
        copy.moderationActionAccountRestriction,
      );
      await expect(row.getByTestId('moderation-action-standing')).toHaveText(
        copy.restrictionStanding,
      );
      await expect(row.getByTestId('moderation-action-ends')).toContainText(kst(endsAt));
      await expect(row).toContainText(copy.adminModerationRequestedBy);
      await expect(row).toContainText(askingMe.profile.nickname);
      await expect(row.getByTestId('moderation-action-approval')).toContainText(
        approvingMe.profile.nickname,
      );
      await expect(row.getByTestId('moderation-action-approval')).toContainText(approvalReason);
      // Its changes are requests: no direct 조기 해제·감경·조치 취소 on it.
      await expect(row.getByTestId('moderation-action-lift')).toHaveCount(0);
      await expect(row.getByTestId('moderation-action-cancel')).toHaveCount(0);
      await expect(
        asking.getByTestId('moderation-account-requests').getByTestId('account-requests-empty'),
      ).toBeVisible();

      // --- the member: the banner on MY 요약 — its title, the end and the way to 내역, nothing
      // more: no reason, no explanation, no operator (#139 «건 운영자는 보이지 않는다»).
      await gotoWithRestrictionRead(page, '/my');
      const banner = page.getByTestId('my-sanction-banner');
      await expect(banner).toContainText(copy.restrictionAccountTitle);
      await expect(banner).not.toContainText(copy.restrictionWritingTitle);
      await expect(page.getByTestId('my-sanction-banner-account-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(endsAt)}`,
      );
      await expect(page.getByTestId('my-sanction-banner-link')).toHaveAttribute(
        'href',
        '/my/moderation',
      );
      for (const hidden of [
        note,
        memo,
        copy.reportReasonMultiAccount,
        approvalReason,
        askingMe.profile.nickname,
        approvingMe.profile.nickname,
        APPEAL_START,
      ]) {
        await expect(banner).not.toContainText(hidden);
      }
      await expect(banner).not.toContainText('이의');

      // MY 설정: the same banner above the public items — its title, end and the way to 내역, no
      // appeal words (ADR-0084 결과 5) — and a new 소개 is refused with the account restriction's
      // sentence, its end and the way to 내역 — clearing it stays open (#37-9, decision 7).
      await gotoWithRestrictionRead(page, '/my/settings');
      const settingsBanner = page.getByTestId('settings-sanction-banner');
      await expect(settingsBanner).toContainText(copy.restrictionAccountTitle);
      await expect(page.getByTestId('settings-sanction-banner-account-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(endsAt)}`,
      );
      await expect(page.getByTestId('settings-sanction-banner-link')).toHaveAttribute(
        'href',
        '/my/moderation',
      );
      await expect(settingsBanner).not.toContainText(APPEAL_START);
      await expect(settingsBanner).not.toContainText('이의');
      const bioInput = page.getByTestId('bio-input');
      await bioInput.fill(`제한 중 소개 ${tag}`);
      await page.getByTestId('bio-save').click();
      const bioNotice = page.getByTestId('bio-notice');
      await expect(bioNotice).toContainText(
        `${copy.errRestrictedAccountProfile}(${kst(endsAt)}${copy.restrictionUntil}).`,
      );
      await expect(bioNotice).toContainText(copy.errRestrictedClearAllowed);
      await expectModerationLink(bioNotice);
      await bioInput.fill('');
      await page.getByTestId('bio-save').click();
      await expect(page.getByText(copy.bioCleared)).toBeVisible();

      // An account restriction blocks no writing (#57-12): a post goes up, under no banner — the
      // account restriction's is MY 요약's and MY 설정's only (owner decision 2026-10-23).
      await gotoWithRestrictionRead(page, `/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-write-sanction-banner')).toHaveCount(0);
      await page.getByTestId('post-title-input').fill(`계정 제한 중 글 ${tag}`);
      await page.getByTestId('post-editor-content').click();
      await page.keyboard.type(`계정 제한 중 본문 ${tag}`);
      await page.getByTestId('post-submit').click();
      await expect(page).toHaveURL(/\/community\/posts\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('post-title')).toHaveText(`계정 제한 중 글 ${tag}`);

      // 조치·신고 내역: the fact, the reason and explanation, the end and the appeal's deadline —
      // never who asked or approved, nor the approval's reason (#139). How to appeal it is the
      // page's, once above the list (#186), and its card's line is its deadline alone: 14 days from
      // when it was taken — when the approval put it in force (ADR-0085 7-1), not the request.
      await page.goto('/my/moderation');
      await expect(page.getByTestId('my-moderation-appeal')).toHaveText(
        fillBusinessInfo(copy.appealGuidance),
      );
      const item = page.getByTestId(`my-action-${restriction.id}`);
      await expect(item.getByTestId('my-action-type')).toHaveText(
        copy.moderationActionAccountRestriction,
      );
      await expect(item.getByTestId('my-action-standing')).toHaveText(copy.restrictionStanding);
      await expect(item.getByTestId('my-action-ends')).toContainText(kst(endsAt));
      await expect(item.getByTestId('my-action-reason')).toContainText(
        copy.reportReasonMultiAccount,
      );
      await expect(item.getByTestId('my-action-note')).toContainText(note);
      await expect(item.getByTestId('my-action-taken-value')).toHaveText(
        kst(restriction.createdAt),
      );
      const deadline = await deadlineOnCard(item);
      await expectDeadlineLine(item, deadline, false);
      await expect(item.getByTestId('my-action-subject')).toHaveCount(0);
      for (const hidden of [
        approvalReason,
        memo,
        askingMe.profile.nickname,
        approvingMe.profile.nickname,
      ]) {
        await expect(page.getByTestId('my-moderation')).not.toContainText(hidden);
      }

      // --- 조기 해제 is a request too: the first operator asks, the second approves.
      await row.getByTestId('moderation-action-lift-request').click();
      const lift = asking.getByTestId('moderation-account-lift-dialog');
      await expect(lift).toContainText(copy.adminModerationAccountLiftBody);
      const liftReason = `소명을 받아들였습니다 ${tag}`;
      await asking.getByTestId('moderation-record').fill(liftReason);
      const liftRequest = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/actions/${restriction.id}/account-restriction/lift`,
      );
      await expect(asking.getByText(copy.adminModerationAccountLiftRequested)).toBeVisible();
      // Still standing until it is approved.
      await expect(row.getByTestId('moderation-action-standing')).toHaveText(
        copy.restrictionStanding,
      );
      await expect(
        asking.getByTestId(`account-request-${liftRequest.id}`).getByTestId('account-request-own'),
      ).toBeVisible();

      await approving.goto(`/admin/moderation/users/${member.id}`);
      const liftEntry = approving
        .getByTestId('moderation-account-requests')
        .getByTestId(`account-request-${liftRequest.id}`);
      await expect(liftEntry.getByTestId('account-request-change')).toHaveText(
        copy.adminAccountRequestChangeLift,
      );
      await expect(liftEntry).toContainText(liftReason);
      await liftEntry.getByTestId('account-request-approve').click();
      await approving.getByTestId('moderation-record').fill(`해제 승인 ${tag}`);
      const liftDecision = await sendDialog<{ request: Request; action: Restriction }>(
        approving,
        `/api/v1/admin/moderation/account-restriction-requests/${liftRequest.id}/approve`,
      );
      const liftedEnd = liftDecision.action.endsAt!;
      await expect(approving.getByText(copy.adminAccountRequestApproved)).toBeVisible();
      const liftedRow = approving
        .getByTestId('moderation-author-actions')
        .getByTestId(`moderation-action-${restriction.id}`);
      await expect(liftedRow.getByTestId('moderation-action-standing')).toHaveCount(0);
      await expect(liftedRow.getByTestId('moderation-end-change')).toContainText(
        `${copy.adminModerationEndChangeLift} · ${kst(endsAt)} →`,
      );
      await expect(liftedRow.getByTestId('moderation-end-change-approval')).toContainText(
        approvingMe.profile.nickname,
      );

      // --- the member: no banner; 조기 해제됨, the changed end and the end it was given.
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
      await page.goto('/my/moderation');
      await expect(item.getByTestId('my-action-standing')).toHaveCount(0);
      await expect(item.getByTestId('my-action-end-change')).toHaveText(copy.moderationEndLifted);
      await expect(item.getByTestId('my-action-ends')).toContainText(kst(liftedEnd));
      await expect(item.getByTestId('my-action-original-ends')).toContainText(kst(endsAt));
      await expect(page.getByTestId('my-moderation')).not.toContainText(liftReason);
      // Lifted early, it stands as an action: the same deadline line (ADR-0084 결과 5).
      await expectDeadlineLine(item, deadline, false);
    } finally {
      await askingContext.close();
      await approvingContext.close();
    }
  });

  test('신고된 글의 운영 화면에서 그 작성자의 계정 제한을 요청하면 결정 전까지 신고는 처리 대기이고, 다른 운영자가 거절하면 아무것도 바뀌지 않는다', async ({
    admin,
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const postId = await postThroughApi(page.request, market.id, `신고된 글 ${tag}`, tag);
    const reporter = await meOf(secondAdmin);
    const report = await secondAdmin.post(`/api/v1/posts/${postId}/reports`, {
      data: { reason: 'spam', description: null, expectedAccountId: reporter.id },
    });
    expect(report.status(), await report.text()).toBe(201);

    const askingContext = await browser.newContext();
    const decidingContext = await browser.newContext();
    try {
      const asking = await askingContext.newPage();
      await signIn(asking, adminAccount.email, adminAccount.password);
      await asking.goto(`/admin/moderation/posts/${postId}`);
      await asking.getByTestId('moderation-account-restrict').click();
      const dialog = asking.getByTestId('moderation-account-restrict-dialog');
      // About this post by default: its pending report is resolved once it is approved.
      await expect(
        dialog.getByRole('radio', { name: copy.adminModerationWarnSubjectThis }),
      ).toBeChecked();
      await asking.getByTestId('moderation-term-none').click();
      await asking.getByTestId('moderation-reason').selectOption('spam');
      await asking.getByTestId('moderation-note').fill(`같은 광고를 되풀이했습니다 ${tag}`);
      const request = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/users/${member.id}/account-restriction`,
      );
      // About the post: its approval would resolve the post's pending report.
      expect(request.apply?.subject).toEqual({ type: 'post', postId });
      await expect(asking.getByText(copy.adminModerationAccountRequested)).toBeVisible();
      // Asked, not done: the report still waits.
      const reportStatus = asking
        .getByTestId('moderation-reports-block')
        .getByTestId('moderation-report-status');
      await expect(reportStatus).toHaveText(copy.reportStatusPending);

      // --- the second operator rejects it from the member's page, with a reason.
      const deciding = await decidingContext.newPage();
      await signIn(deciding, secondAdminAccount.email, secondAdminAccount.password);
      await deciding.goto(`/admin/moderation/users/${member.id}`);
      const entry = deciding
        .getByTestId('moderation-account-requests')
        .getByTestId(`account-request-${request.id}`);
      await expect(entry.getByTestId('account-request-term')).toContainText(
        copy.restrictionIndefinite,
      );
      await entry.getByTestId('account-request-reject').click();
      const reject = deciding.getByTestId('account-request-reject-dialog');
      await expect(reject).toContainText(copy.adminAccountRequestRejectBody);
      await deciding.getByTestId('moderation-record').fill(`숨김으로 충분합니다 ${tag}`);
      const decision = await sendDialog<{ request: Request; action: Restriction | null }>(
        deciding,
        `/api/v1/admin/moderation/account-restriction-requests/${request.id}/reject`,
      );
      expect(decision.request.status).toBe('rejected');
      expect(decision.action).toBeNull();
      await expect(deciding.getByText(copy.adminAccountRequestRejected)).toBeVisible();
      await expect(entry).toHaveCount(0);
      await expect(
        deciding.getByTestId('moderation-author-actions').getByTestId('moderation-action-type'),
      ).toHaveCount(0);

      // Nothing done: the report still waits, the member has no banner.
      await asking.reload();
      await expect(reportStatus).toHaveText(copy.reportStatusPending);
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);

      // The report is processed before the test ends: dismissed by the first operator.
      await asking.getByTestId('moderation-dismiss').click();
      await asking.getByTestId('moderation-record').fill(`시험 정리 ${tag}`);
      await asking.getByTestId('moderation-submit').click();
      await expect(asking.getByText(copy.adminModerationDismissed)).toBeVisible();
      await expect(reportStatus).toHaveText(copy.reportStatusDismissed);
    } finally {
      await askingContext.close();
      await decidingContext.close();
    }
  });

  test('감경과 취소도 운영자가 요청하고 다른 운영자가 승인해야 적용되며, 요청의 줄은 회원의 여러 계정 제한 가운데 바꿀 것과 그 끝을 말한다', async ({
    admin,
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const askingMe = await meOf(admin);
    const approvingMe = await meOf(secondAdmin);
    /** The second operator's approval, through the API. */
    const approveThroughApi = async (requestId: string): Promise<Restriction> => {
      const res = await secondAdmin.post(
        `/api/v1/admin/moderation/account-restriction-requests/${requestId}/approve`,
        { data: { reason: `승인합니다 ${tag}`, expectedAccountId: approvingMe.id } },
      );
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { data: { action: Restriction } }).data.action;
    };
    /** A request of the first operator's through the API, answered with the request. */
    const askThroughApi = async (path: string, data: Record<string, unknown>): Promise<Request> => {
      const res = await admin.post(path, { data: { ...data, expectedAccountId: askingMe.id } });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { data: Request }).data;
    };
    // Two account restrictions stand: 무기한 and 7일, both approved.
    const restrict = async (days: number | null) =>
      approveThroughApi(
        (
          await askThroughApi(`/api/v1/admin/moderation/users/${member.id}/account-restriction`, {
            reason: 'abnormal_trading',
            note: `이상 거래가 있었습니다 ${tag}`,
            days,
            subject: null,
          })
        ).id,
      );
    const indefinite = await restrict(null);
    const week = await restrict(7);

    const askingContext = await browser.newContext();
    try {
      const asking = await askingContext.newPage();
      await signIn(asking, adminAccount.email, adminAccount.password);
      await asking.goto(`/admin/moderation/users/${member.id}`);
      const row = asking
        .getByTestId('moderation-author-actions')
        .getByTestId(`moderation-action-${indefinite.id}`);

      // --- 감경 요청 on the 무기한 one: to two days on, with a reason.
      await row.getByTestId('moderation-action-shorten-request').click();
      const shorten = asking.getByTestId('moderation-account-shorten-dialog');
      await expect(shorten).toContainText(copy.adminModerationAccountShortenBody);
      const local = kstLocal(Date.now() + 2 * 24 * 60 * 60 * 1_000);
      const newEnd = new Date(`${local}:00+09:00`).toISOString();
      await asking.getByTestId('moderation-end').fill(local);
      await asking.getByTestId('moderation-record').fill(`이의를 일부 받아들였습니다 ${tag}`);
      const shortenRequest = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/actions/${indefinite.id}/account-restriction/shorten`,
      );
      await expect(asking.getByText(copy.adminModerationAccountShortenRequested)).toBeVisible();
      // Its line names which of the two it changes — when it was given, its end now, its reason,
      // a link to its row — and the end asked for.
      const entry = asking
        .getByTestId('moderation-account-requests')
        .getByTestId(`account-request-${shortenRequest.id}`);
      await expect(entry.getByTestId('account-request-change')).toHaveText(
        copy.adminAccountRequestChangeShorten,
      );
      const target = entry.getByTestId('account-request-target');
      await expect(target).toContainText(
        `${kst(indefinite.createdAt)} · ${copy.moderationEndsAt} ${copy.restrictionIndefinite}`,
      );
      await expect(target.getByRole('link')).toHaveAttribute(
        'href',
        `/admin/moderation/users/${member.id}#moderation-action-${indefinite.id}`,
      );
      await expect(row).toHaveAttribute('id', `moderation-action-${indefinite.id}`);
      await expect(entry.getByTestId('account-request-target-reason')).toContainText(
        copy.reportReasonAbnormalTrading,
      );
      await expect(entry.getByTestId('account-request-ends')).toContainText(kst(newEnd));
      // Nothing changes until another operator approves it.
      await expect(row.getByTestId('moderation-end-change')).toHaveCount(0);
      await approveThroughApi(shortenRequest.id);
      await asking.reload();
      await expect(row.getByTestId('moderation-action-ends')).toContainText(kst(newEnd));
      await expect(row.getByTestId('moderation-end-change')).toContainText(
        `${copy.adminModerationEndChangeShorten} · ${copy.restrictionIndefinite} → ${kst(newEnd)}`,
      );
      // The member reads 감경됨, and the '이의 기한' its card had: a 감경 brings the end forward,
      // not when it was taken (ADR-0084 결과 5).
      await page.goto('/my/moderation');
      const card = page.getByTestId(`my-action-${indefinite.id}`);
      await expect(card.getByTestId('my-action-end-change')).toHaveText(
        copy.moderationEndShortened,
      );
      await expect(card.getByTestId('my-action-taken-value')).toHaveText(kst(indefinite.createdAt));
      await expectDeadlineLine(card, await deadlineOnCard(card), false);

      // --- 취소 요청 of the same restriction, approved: cancelled.
      await row.getByTestId('moderation-action-cancel-request').click();
      const cancel = asking.getByTestId('moderation-account-cancel-dialog');
      await expect(cancel).toContainText(copy.adminModerationAccountCancelBody);
      await asking.getByTestId('moderation-record').fill(`이의를 받아들였습니다 ${tag}`);
      const cancelRequest = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/actions/${indefinite.id}/account-restriction/cancel`,
      );
      await expect(asking.getByText(copy.adminModerationAccountCancelRequested)).toBeVisible();
      await expect(row.getByTestId('moderation-action-cancelled')).toHaveCount(0);
      await approveThroughApi(cancelRequest.id);
      // The week is cancelled too, so nothing stands once the test ends.
      await approveThroughApi(
        (
          await askThroughApi(
            `/api/v1/admin/moderation/actions/${week.id}/account-restriction/cancel`,
            { reason: `시험 정리 ${tag}` },
          )
        ).id,
      );
      await asking.reload();
      await expect(row.getByTestId('moderation-action-cancelled')).toHaveText(
        copy.moderationCancelled,
      );
      // Cancelled: nothing left to appeal, no deadline line (ADR-0081 7-17).
      await page.goto('/my/moderation');
      await expect(card.getByTestId('my-action-cancelled')).toBeVisible();
      await expect(card.getByTestId('my-action-appeal')).toHaveCount(0);
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
    } finally {
      await askingContext.close();
    }
  });
  test('요청한 운영자가 결정 전에 요청을 철회하면 철회됨으로 닫혀 다른 운영자가 결정할 수 없고 아무것도 바뀌지 않는다', async ({
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const approvingMe = await meOf(secondAdmin);

    const askingContext = await browser.newContext();
    try {
      const asking = await askingContext.newPage();
      await signIn(asking, adminAccount.email, adminAccount.password);
      await asking.goto(`/admin/moderation/users/${member.id}`);
      await asking.getByTestId('moderation-account-restrict').click();
      await asking.getByTestId('moderation-term-3').click();
      await asking.getByTestId('moderation-reason').selectOption('spam');
      await asking.getByTestId('moderation-note').fill(`같은 광고를 되풀이했습니다 ${tag}`);
      const request = await sendDialog<Request>(
        asking,
        `/api/v1/admin/moderation/users/${member.id}/account-restriction`,
      );
      await expect(asking.getByText(copy.adminModerationAccountRequested)).toBeVisible();

      // --- 요청 철회 on the member's page: a confirmation, no reason asked.
      const waiting = asking
        .getByTestId('moderation-account-requests')
        .getByTestId(`account-request-${request.id}`);
      await waiting.getByTestId('account-request-retract').click();
      const retract = asking.getByTestId('account-request-retract-dialog');
      await expect(retract).toContainText(copy.adminAccountRequestRetractBody);
      await expect(retract.getByTestId('moderation-record')).toHaveCount(0);
      const retracted = await sendDialog<Request & { retractedAt: string | null }>(
        asking,
        `/api/v1/admin/moderation/account-restriction-requests/${request.id}/retract`,
      );
      expect(retracted.status).toBe('retracted');
      await expect(asking.getByText(copy.adminAccountRequestRetracted)).toBeVisible();
      await expect(waiting).toHaveCount(0);

      // --- 계정 제한 요청's 철회됨: the request, 철회됨, when.
      await asking.goto('/admin/moderation/account-restriction-requests');
      await asking.getByTestId('admin-account-requests-queue-retracted').click();
      await expect(asking).toHaveURL(
        '/admin/moderation/account-restriction-requests?status=retracted',
      );
      const closed = asking.getByTestId(`account-request-${request.id}`);
      await expect(closed.getByTestId('account-request-status')).toHaveText(
        copy.approvalStatusRetracted,
      );
      await expect(closed.getByTestId('account-request-retracted-at')).toContainText(
        kst(retracted.retractedAt!),
      );
      await expect(closed.getByTestId('account-request-retract')).toHaveCount(0);

      // --- the second operator decides it no more.
      const late = await secondAdmin.post(
        `/api/v1/admin/moderation/account-restriction-requests/${request.id}/approve`,
        { data: { reason: `늦은 승인 ${tag}`, expectedAccountId: approvingMe.id } },
      );
      expect(late.status(), await late.text()).toBe(409);
      expect(
        ((await late.json()) as { error: { details: { message: string }[] } }).error.details[0]
          ?.message,
      ).toBe('retracted');

      // --- nothing in force for the member.
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
    } finally {
      await askingContext.close();
    }
  });

  test('작성 제한과 계정 제한이 함께 서 있으면 MY 요약·MY 설정의 한 띠에 둘의 제목과 끝나는 때가 보이고 조치·신고 내역 링크는 하나이며, 글쓰기 화면의 띠에는 작성 제한만 보인다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    // The one SanctionBanner keeps both owners' rules (ADR-0085 결과 5, restacked on #185 and
    // #186): MY 요약 and MY 설정 speak of every standing restriction — each its title and end, one
    // link, no appeal words (#186 답 3) — and the write page of the writing restriction alone
    // (owner decision 2026-10-23 답 10: the account restriction refuses no post, #57-12).
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const operator = await meOf(admin);
    const approver = await meOf(secondAdmin);
    const given = await admin.post(
      `/api/v1/admin/moderation/users/${member.id}/writing-restriction`,
      { data: { reason: 'spam', note: null, days: 1, expectedAccountId: operator.id } },
    );
    expect(given.status(), await given.text()).toBe(200);
    const writing = ((await given.json()) as { data: Restriction }).data;
    const asked = await admin.post(
      `/api/v1/admin/moderation/users/${member.id}/account-restriction`,
      {
        data: {
          reason: 'multi_account',
          note: `여러 계정 ${tag}`,
          days: 7,
          subject: null,
          expectedAccountId: operator.id,
        },
      },
    );
    expect(asked.status(), await asked.text()).toBe(200);
    const approved = await secondAdmin.post(
      `/api/v1/admin/moderation/account-restriction-requests/${((await asked.json()) as { data: Request }).data.id}/approve`,
      { data: { reason: `승인 ${tag}`, expectedAccountId: approver.id } },
    );
    expect(approved.status(), await approved.text()).toBe(200);
    const account = ((await approved.json()) as { data: { action: Restriction } }).data.action;
    try {
      for (const [path, testId] of [
        ['/my', 'my-sanction-banner'],
        ['/my/settings', 'settings-sanction-banner'],
      ] as const) {
        await gotoWithRestrictionRead(page, path);
        const banner = page.getByTestId(testId);
        // The writing restriction first, then the account restriction (RESTRICTION_KINDS).
        const items = banner.locator('[data-testid$="-restriction"]');
        await expect(items).toHaveCount(2);
        await expect(items.nth(0)).toHaveAttribute('data-testid', `${testId}-restriction`);
        await expect(items.nth(0)).toContainText(copy.restrictionWritingTitle);
        await expect(items.nth(1)).toHaveAttribute('data-testid', `${testId}-account-restriction`);
        await expect(items.nth(1)).toContainText(copy.restrictionAccountTitle);
        await expect(page.getByTestId(`${testId}-ends`)).toHaveText(
          `${copy.moderationEndsAt} ${kst(writing.endsAt!)}`,
        );
        await expect(page.getByTestId(`${testId}-account-ends`)).toHaveText(
          `${copy.moderationEndsAt} ${kst(account.endsAt!)}`,
        );
        await expect(page.getByTestId(`${testId}-link`)).toHaveCount(1);
        await expect(banner.getByRole('link')).toHaveCount(1);
        await expect(banner).not.toContainText('이의');
      }
      // The write page: the writing restriction's title and end alone.
      await gotoWithRestrictionRead(page, `/community/write?market=${market.id}`);
      const writeBanner = page.getByTestId('post-write-sanction-banner');
      await expect(writeBanner).toContainText(copy.restrictionWritingTitle);
      await expect(page.getByTestId('post-write-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(writing.endsAt!)}`,
      );
      await expect(writeBanner).not.toContainText(copy.restrictionAccountTitle);
      await expect(page.getByTestId('post-write-sanction-banner-account-restriction')).toHaveCount(
        0,
      );
      await expect(writeBanner).not.toContainText(kst(account.endsAt!));
      await expect(writeBanner).not.toContainText('이의');
    } finally {
      // Both end before the test does: the writing restriction lifted, the account restriction's
      // lift asked and approved.
      const lifted = await admin.post(`/api/v1/admin/moderation/actions/${writing.id}/lift`, {
        data: { reason: `시험 정리 ${tag}`, expectedAccountId: operator.id },
      });
      expect(lifted.status(), await lifted.text()).toBe(200);
      const liftAsked = await admin.post(
        `/api/v1/admin/moderation/actions/${account.id}/account-restriction/lift`,
        { data: { reason: `시험 정리 ${tag}`, expectedAccountId: operator.id } },
      );
      expect(liftAsked.status(), await liftAsked.text()).toBe(200);
      const liftApproved = await secondAdmin.post(
        `/api/v1/admin/moderation/account-restriction-requests/${((await liftAsked.json()) as { data: Request }).data.id}/approve`,
        { data: { reason: `시험 정리 ${tag}`, expectedAccountId: approver.id } },
      );
      expect(liftApproved.status(), await liftApproved.text()).toBe(200);
    }
  });
});
