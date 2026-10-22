import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 신고와 운영 처리 (#50, ADR-0081; owner decisions in ADR-0069 decision 2 #45-10…#45-15, decision 3
 * #37-10, decision 4 #50 rows, decision 7), walked on the screens with three browsers — the author,
 * a reporter and an operator:
 *
 * - a member reports a 근거 글 and a 댓글 from the post page, one reason each ('기타' needs a
 *   description), told in the dialog that a wrong forecast is not a reason; nothing is hidden by it;
 *   the same post again is refused while the first report waits; the author is offered no 신고 on
 *   their own; a visitor's press goes to the login page;
 * - the reporter reads both as 접수 on 조치·신고 내역, reached from MY 설정;
 * - the operator finds the post in the queue, hides it with a reason and an explanation, and
 *   dismisses the comment's report with a reason of their own, the comment reached from the post's
 *   page;
 * - the author sees the placeholder, '숨김' with the reason on MY 내 글, and the action with its
 *   reason and the appeal on 조치·신고 내역 — never who reported nor who acted; the reporter sees
 *   조치함 and 기각;
 * - a profile reported, its 소개 emptied by the operator from the member's page (kept for operators,
 *   not restored by a cancellation), and an operator's own post offering no action — its report
 *   read without the reporter and the description, and the hiding another operator gives it read
 *   without who gave it (owner decision 2026-10-21);
 * - 신고 on the cards of the community list and of a profile's 글·댓글 tabs, named by its item, which
 *   reports without opening the post and sits outside the card's link, none on one's own (the list
 *   and both tabs) and a visitor's press back to the list; the operator's '운영' links on the post,
 *   its comment and the profile, shown to no one else; a warning given from the profile's link
 *   shows its banner on the member's MY summary — not the write page — until it is cancelled
 *   (owner decisions 2026-10-21);
 * - the report dialog names the post or comment it reports on one line — from the post page, a
 *   comment, a 대댓글 whose first line is cut with '…', and the cards (owner decision 2026-10-22 답 4);
 *   the reported operator still reads the count of reporters (답 1);
 * - a nickname reset: the member reads on 조치·신고 내역 that the former nickname cannot be used for
 *   30 days and is refused it, as another member is (the approved refusal); the cancellation's
 *   dialog says the hold becomes the member's, the line goes, and the member takes the nickname
 *   back at once while the other member is still refused (owner decisions 2026-10-22 답 2·3).
 *
 * Every report a test files is processed before it ends, so a persistent database's queue does not
 * grow run after run; the queue is walked page by page all the same (`showInQueue`). A check that
 * something is absent is made once what decides it has been read: GET /me for 신고, the member's
 * actions for the banners (`gotoWithActionsRead`).
 *
 * The rules' every branch (the daily limit, the same person by number, the onboarding, the
 * concurrency, the audit rows) is the API's tests' (reports.controller.test.ts,
 * moderation.controller.test.ts); deleting a really hidden item from MY is authored.spec.ts's.
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

/** A 댓글 — or a 대댓글 under `parentId` — straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
  parentId: string | null = null,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/**
 * The queue's entry, shown: the pending half lists the target waiting longest first, and an
 * earlier run's reports — or another test's, filed at the same time — may wait before it, so 더 보기
 * until it is there. The entry and 더 보기 are on screen together whenever a page after this one
 * exists (`.first()` of the two), and each 더 보기 is waited out — its page read and drawn — before
 * the entry is looked for again.
 */
async function showInQueue(page: Page, entry: Locator): Promise<void> {
  const more = page.getByTestId('admin-reports-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(entry).first()).toBeVisible();
    if (await entry.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/reports',
    );
    await more.click();
    await next;
    await expect(page.locator('[data-testid="admin-reports-more"][data-loading]')).toHaveCount(0);
  }
  await expect(entry).toBeVisible();
}

/**
 * Opens `path` and waits until the member's own actions (`GET /me/moderation/actions`, read in the
 * browser once the session is known) have answered and been drawn: the banners — the warning's on
 * the MY summary, the sanction's there and on the write page — are drawn from it and draw nothing
 * while it is read, so a check that one is absent proves nothing before it. Two frames after the
 * answer: React Query hands it over and React draws it.
 */
async function gotoWithActionsRead(page: Page, path: string): Promise<void> {
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/me/moderation/actions',
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

/** The areas' links a reader at this width has: the tab bar below md, header row 1 from md up. */
function shownNav(page: Page): Locator {
  const width = page.viewportSize()?.width ?? 0;
  return width < 768
    ? page.getByTestId('bottom-tabs')
    : page.getByRole('navigation', { name: copy.navPrimary });
}

/** A nickname nobody has: a prefix and the run's random tail, within the 20 characters. */
function freshNickname(prefix: string): string {
  return `${prefix}${freshTag().slice(-10)}`.slice(0, 20);
}

/**
 * The open report dialog names `item` on one line under its title (owner decision 2026-10-22 답 4)
 * — the line is the dialog's name after the title — and a line wider than the dialog is cut with
 * an ellipsis rather than wrapped.
 */
async function expectReportItem(page: Page, title: string, item: string): Promise<void> {
  const line = page.getByTestId('report-dialog').getByTestId('report-dialog-item');
  await expect(line).toHaveText(item);
  await expect(page.getByRole('dialog')).toHaveAccessibleName(`${title} ${item}`);
  expect(
    await line.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.whiteSpace, style.textOverflow, style.overflow];
    }),
  ).toEqual(['nowrap', 'ellipsis', 'hidden']);
}

/** Sends the open report dialog and waits for its answer, returning the report's id. */
async function sendReport(page: Page, path: string): Promise<string> {
  const answer = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === path,
  );
  await page.getByTestId('report-submit').click();
  const response = await answer;
  expect(response.status(), await response.text()).toBe(201);
  await expect(page.getByText(copy.reportSubmitted)).toBeVisible();
  await expect(page.getByTestId('report-dialog')).toHaveCount(0);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

test.describe('신고와 운영 처리', () => {
  test('회원이 글과 댓글을 신고하면 접수로 보이고, 운영자가 글을 숨기면 작성자는 숨김과 사유·이의 안내를, 신고자는 조치함을 보며, 댓글의 신고를 기각하면 신고자는 기각을 본다', async ({
    admin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    const operator = await meOf(admin);
    await signUp(page, freshEmail());
    const postTitle = `신고될 글 ${tag}`;
    const postId = await postThroughApi(page.request, market.id, postTitle, `본문 ${tag}`);
    const commentId = await commentThroughApi(page.request, postId, `신고될 댓글 ${tag}`);

    const reporterContext = await browser.newContext();
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      // The author is offered no 신고 on their own post or comment (#45-10).
      await page.goto(`/community/posts/${postId}`);
      await expect(page.getByTestId('post-edit')).toBeVisible();
      await expect(
        page.getByTestId(`comment-${commentId}`).getByTestId('comment-edit'),
      ).toBeVisible();
      await expect(page.getByTestId('report-open')).toHaveCount(0);

      // A visitor's 신고 goes to the login page, back to the post.
      const visitor = await visitorContext.newPage();
      await visitor.goto(`/community/posts/${postId}`);
      await visitor.getByTestId('post-reactions').getByTestId('report-open').click();
      await expect(visitor).toHaveURL(
        `/login?next=${encodeURIComponent(`/community/posts/${postId}`)}`,
      );

      // The reporter reports the post: one reason, '기타' needs a description, the note that a
      // wrong forecast is not a reason is the dialog's description.
      const reporter = await reporterContext.newPage();
      await signUp(reporter, freshEmail());
      const reporterMe = await meOf(reporter.request);
      await reporter.goto(`/community/posts/${postId}`);
      const postReport = reporter.getByTestId('post-reactions').getByTestId('report-open');
      await postReport.click();
      const dialog = reporter.getByTestId('report-dialog');
      await expect(dialog).toContainText(copy.reportPostTitle);
      // Which post: its title, on one line under the dialog's title (owner decision 2026-10-22).
      await expectReportItem(reporter, copy.reportPostTitle, postTitle);
      await expect(reporter.getByRole('dialog')).toHaveAccessibleDescription(copy.reportNotAReason);
      await expect(dialog.getByRole('radio')).toHaveCount(8);
      await expect(
        dialog.locator('[data-testid^="report-reason-"] [data-part="item-text"]'),
      ).toHaveText([
        copy.reportReasonSpam,
        copy.reportReasonHarassment,
        copy.reportReasonPersonalInfo,
        copy.reportReasonImpersonation,
        copy.reportReasonCollusionManipulation,
        copy.reportReasonOffTopic,
        copy.reportReasonRightsInfringement,
        copy.reportReasonOther,
      ]);
      await reporter.getByTestId('report-submit').click();
      await expect(reporter.getByTestId('report-reason-error')).toHaveText(
        copy.errReportReasonRequired,
      );
      await reporter.getByTestId('report-reason-other').click();
      await reporter.getByTestId('report-submit').click();
      await expect(reporter.getByTestId('report-description-error')).toHaveText(
        copy.errReportDescriptionRequired,
      );
      await reporter.getByTestId('report-reason-spam').click();
      const description = `같은 광고 링크 ${tag}`;
      await reporter.getByTestId('report-description').fill(description);
      const postReportId = await sendReport(reporter, `/api/v1/posts/${postId}/reports`);

      // Nothing is hidden by a report (#45-10): the post reads as before.
      await reporter.reload();
      await expect(reporter.getByTestId('post-title')).toHaveText(postTitle);

      // The same post again while that report waits: refused (decision 7), the dialog keeps it.
      await postReport.click();
      await reporter.getByTestId('report-reason-harassment').click();
      await reporter.getByTestId('report-submit').click();
      await expect(reporter.getByTestId('report-error')).toHaveText(copy.errReportDuplicate);
      await reporter.getByTestId('report-cancel').click();
      await expect(dialog).toHaveCount(0);

      // A 대댓글 whose first line is longer than the cap: named by its first 300 characters and
      // '…' — the dialog's line cut by its width besides — and left unreported.
      const longLine = `긴 답글 ${tag} ${'가나다라마바사'.repeat(60)}`;
      const replyId = await commentThroughApi(
        page.request,
        postId,
        `${longLine}\n둘째 줄`,
        commentId,
      );
      await reporter.reload();
      await reporter.getByTestId(`comment-${replyId}`).getByTestId('report-open').click();
      await expect(dialog).toContainText(copy.reportCommentTitle);
      await expectReportItem(
        reporter,
        copy.reportCommentTitle,
        `${[...longLine].slice(0, 300).join('').trimEnd()}…`,
      );
      const item = dialog.getByTestId('report-dialog-item');
      expect(await item.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      await reporter.getByTestId('report-cancel').click();
      await expect(dialog).toHaveCount(0);

      // The comment, 괴롭힘, from its own 신고: named by its first line.
      await reporter.getByTestId(`comment-${commentId}`).getByTestId('report-open').click();
      await expect(dialog).toContainText(copy.reportCommentTitle);
      await expectReportItem(reporter, copy.reportCommentTitle, `신고될 댓글 ${tag}`);
      await reporter.getByTestId('report-reason-harassment').click();
      const commentReportId = await sendReport(reporter, `/api/v1/comments/${commentId}/reports`);

      // 조치·신고 내역, from MY 설정: both 접수, the newest first.
      await reporter.goto('/my/settings');
      await reporter.getByTestId('settings-moderation-open').click();
      await expect(reporter).toHaveURL('/my/moderation');
      // Not a tab: the page names itself.
      await expect(
        reporter.getByRole('heading', { level: 3, name: copy.myModeration }),
      ).toBeVisible();
      const reports = reporter.getByTestId('my-reports-list');
      await expect(reports.locator('article')).toHaveCount(2);
      const postItem = reporter.getByTestId(`my-report-${postReportId}`);
      const commentItem = reporter.getByTestId(`my-report-${commentReportId}`);
      await expect(reports.locator('article').first()).toHaveAttribute(
        'data-testid',
        `my-report-${commentReportId}`,
      );
      await expect(postItem.getByTestId('my-report-status')).toHaveText(copy.reportStatusPending);
      await expect(postItem.getByTestId('my-report-target')).toHaveText(postTitle);
      await expect(postItem.getByTestId('my-report-reason')).toContainText(copy.reportReasonSpam);
      await expect(postItem).toContainText(description);
      await expect(commentItem.getByTestId('my-report-status')).toHaveText(
        copy.reportStatusPending,
      );
      await expect(commentItem.getByTestId('my-report-target')).toHaveText(`신고될 댓글 ${tag}`);
      await expect(reporter.getByTestId('my-actions-list-empty')).toHaveText(
        copy.myModerationActionsEmpty,
      );

      // The operator: the post's entry in the queue, its page, 숨기기 with a reason.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/markets');
      await adminPage
        .getByTestId('admin-nav')
        .getByRole('link', { name: copy.adminModeration, exact: true })
        .click();
      await expect(adminPage).toHaveURL('/admin/reports');
      const entry = adminPage.getByTestId(`admin-report-group-post-${postId}`);
      await showInQueue(adminPage, entry);
      await expect(entry).toContainText(postTitle);
      await expect(entry.getByTestId('admin-report-group-reasons')).toHaveText(
        `${copy.reportReasonSpam} 1`,
      );
      await entry.getByTestId('admin-report-group-open').click();
      await expect(adminPage).toHaveURL(`/admin/moderation/posts/${postId}`);
      const reportsBlock = adminPage.getByTestId('moderation-reports-block');
      await expect(reportsBlock).toContainText(reporterMe.profile.nickname);
      await expect(reportsBlock).toContainText(description);
      await expect(adminPage.getByTestId('moderation-reporter-count')).toHaveText(
        `${copy.adminReporterCount} 1${copy.adminCountUnitPeople}`,
      );
      await adminPage.getByTestId('moderation-hide').click();
      const hideDialog = adminPage.getByTestId('moderation-hide-dialog');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(hideDialog).toContainText(copy.errModerationReasonRequired);
      await adminPage.getByTestId('moderation-reason').selectOption('spam');
      const note = `같은 광고를 되풀이했습니다 ${tag}`;
      await adminPage.getByTestId('moderation-note').fill(note);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationHidden)).toBeVisible();
      await expect(hideDialog).toHaveCount(0);
      await expect(adminPage.getByTestId('moderation-item-state')).toHaveText(
        copy.adminModerationStateHidden,
      );
      await expect(reportsBlock.getByTestId('moderation-report-status')).toHaveText(
        copy.reportStatusActioned,
      );
      await expect(adminPage.getByTestId('moderation-item-actions')).toContainText(
        copy.moderationActionHide,
      );
      await expect(adminPage.getByTestId('moderation-hide')).toHaveCount(0);

      // The comment's report dismissed (기각), with the operators' own reason — its page reached
      // from the post's list of comments (a comment has no public address of its own).
      await adminPage
        .getByTestId(`moderation-comment-${commentId}`)
        .getByTestId('moderation-comment-open')
        .click();
      await expect(adminPage).toHaveURL(`/admin/moderation/comments/${commentId}`);
      await adminPage.getByTestId('moderation-dismiss').click();
      const dismissDialog = adminPage.getByTestId('moderation-dismiss-dialog');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(dismissDialog.getByTestId('moderation-text-error')).toHaveText(
        copy.errModerationRecordRequired,
      );
      await adminPage.getByTestId('moderation-record').fill(`의견 차이일 뿐입니다 ${tag}`);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationDismissed)).toBeVisible();
      await expect(adminPage.getByTestId('moderation-report-status')).toHaveText(
        copy.reportStatusDismissed,
      );
      await expect(adminPage.getByTestId('moderation-dismiss')).toHaveCount(0);
      await expect(adminPage.getByTestId('moderation-item-state')).toHaveText(
        copy.adminModerationStatePublished,
      );

      // The author: the placeholder, '숨김' with the reason on MY 내 글, and the action on
      // 조치·신고 내역 with its reason and the appeal — nothing of who reported or who acted.
      await page.goto(`/community/posts/${postId}`);
      await expect(page.getByTestId('post-hidden')).toContainText(copy.postHiddenPlaceholder);
      await page.goto('/my/posts');
      const hiddenLine = page
        .getByTestId('my-posts-list')
        .getByRole('listitem')
        .filter({ has: page.getByTestId(`post-card-${postId}`) });
      await expect(hiddenLine.getByTestId('authored-hidden-reason')).toHaveText(
        `${copy.authoredHiddenReason}: ${copy.reportReasonSpam}`,
      );
      await expect(hiddenLine.getByTestId('authored-hidden-note')).toHaveText(
        `${copy.authoredHiddenNote}: ${note}`,
      );
      await page.goto('/my/moderation');
      const actions = page.getByTestId('my-actions-list');
      await expect(actions.locator('article')).toHaveCount(1);
      await expect(actions.getByTestId('my-action-type')).toHaveText(copy.moderationActionHide);
      await expect(actions.getByTestId('my-action-subject')).toHaveText(postTitle);
      await expect(actions.getByTestId('my-action-reason')).toContainText(copy.reportReasonSpam);
      await expect(actions.getByTestId('my-action-note')).toContainText(note);
      await expect(actions.getByTestId('my-action-appeal')).toContainText(
        copy.moderationAppealDeadline,
      );
      await expect(actions.getByTestId('my-action-cancelled')).toHaveCount(0);
      await expect(page.getByTestId('my-moderation-appeal')).toContainText('14일');
      await expect(page.getByTestId('my-reports-list-empty')).toHaveText(
        copy.myModerationReportsEmpty,
      );
      const authorView = (await page.getByTestId('my-moderation').textContent()) ?? '';
      expect(authorView).not.toContain(reporterMe.profile.nickname);
      expect(authorView).not.toContain(operator.profile.nickname);
      expect(authorView).not.toContain(description);
      // A hiding is no sanction (#45-12): no banner on MY or the write page, once the actions they
      // are drawn from have been read.
      await gotoWithActionsRead(page, '/my');
      await expect(page.getByTestId('my-preview-wallet')).toBeVisible();
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
      await gotoWithActionsRead(page, `/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-write-market')).toBeVisible();
      await expect(page.getByTestId('post-write-sanction-banner')).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      // The reporter: 조치함 for the post — now its placeholder — and 기각 for the comment.
      await reporter.goto('/my/moderation');
      await expect(postItem.getByTestId('my-report-status')).toHaveText(copy.reportStatusActioned);
      await expect(postItem.getByTestId('my-report-target')).toHaveText(copy.postHiddenPlaceholder);
      await expect(postItem.getByTestId('my-report-resolved')).toBeVisible();
      await expect(commentItem.getByTestId('my-report-status')).toHaveText(
        copy.reportStatusDismissed,
      );
      const reporterView = (await reporter.getByTestId('my-moderation').textContent()) ?? '';
      expect(reporterView).not.toContain(operator.profile.nickname);
      expect(reporterView).not.toContain(note);

      // Processed, the post's entry is in the queue's other half.
      await adminPage.goto('/admin/reports?status=resolved');
      await expect(adminPage.getByTestId(`admin-report-group-post-${postId}`)).toBeVisible();
      await adminPage.goto('/admin/moderation/actions');
      await expect(adminPage.getByTestId('admin-moderation-actions')).toContainText(note);
    } finally {
      await reporterContext.close();
      await visitorContext.close();
      await adminContext.close();
    }
  });

  test('회원의 프로필을 신고하면 운영자가 회원 화면에서 소개를 비우고 그 소개는 운영자만 보며, 조치를 취소해도 되살리지 않고, 운영자 자신의 글에는 처리 단추 없이 다른 운영자가 처리한다고 보이며, 다른 운영자가 처리하면 그 조치를 누가 했는지 없이 본다', async ({
    admin,
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const memberEmail = freshEmail();
    await signUp(page, memberEmail);
    const member = await meOf(page.request);
    const bio = `연락처 010-0000-0000 ${tag}`;
    const saved = await page.request.put('/api/v1/me/bio', {
      data: { bio, expectedAccountId: member.id },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const profileUrl = `/u/${member.profile.publicId}`;

    const reporterContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      // The member's own profile offers MY 설정, never 신고.
      await page.goto(profileUrl);
      await expect(page.getByTestId('profile-edit')).toBeVisible();
      await expect(page.getByTestId('report-open')).toHaveCount(0);

      // Another member reports the profile (#37-10).
      const reporter = await reporterContext.newPage();
      await signUp(reporter, freshEmail());
      await reporter.goto(profileUrl);
      await reporter.getByTestId('profile-actions').getByTestId('report-open').click();
      await expect(reporter.getByTestId('report-dialog')).toContainText(copy.reportProfileTitle);
      // A profile's dialog names no post or comment: its title says what is reported.
      await expect(reporter.getByTestId('report-dialog-item')).toHaveCount(0);
      await reporter.getByTestId('report-reason-personal_info').click();
      const reportId = await sendReport(
        reporter,
        `/api/v1/profiles/${member.profile.publicId}/reports`,
      );

      // The operator finds the member on 사용자 and opens their page.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/users');
      await adminPage.getByTestId('admin-user-search').fill(memberEmail);
      await adminPage.getByTestId('admin-user-search').press('Enter');
      await adminPage
        .getByTestId(`admin-user-${member.id}`)
        .getByTestId('admin-user-moderation')
        .click();
      await expect(adminPage).toHaveURL(`/admin/moderation/users/${member.id}`);
      await expect(adminPage.getByTestId('moderation-profile-bio')).toContainText(bio);
      await expect(adminPage.getByTestId(`moderation-report-${reportId}`)).toContainText(
        copy.reportReasonPersonalInfo,
      );

      // 소개 비우기, with a reason the member reads.
      await adminPage.getByTestId('moderation-bio-clear').click();
      await adminPage.getByTestId('moderation-reason').selectOption('personal_info');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationBioCleared)).toBeVisible();
      await expect(adminPage.getByTestId('moderation-profile-bio')).toContainText(
        copy.adminModerationNone,
      );
      await expect(adminPage.getByTestId('moderation-bio-clear')).toHaveCount(0);
      await expect(
        adminPage
          .getByTestId(`moderation-report-${reportId}`)
          .getByTestId('moderation-report-status'),
      ).toHaveText(copy.reportStatusActioned);
      const memberActions = adminPage.getByTestId('moderation-author-actions');
      // What it took away stays for operators.
      await expect(memberActions.getByTestId('moderation-action-removed')).toContainText(bio);

      // The public profile no longer shows it.
      await page.goto(profileUrl);
      await expect(page.getByTestId('profile-nickname')).toBeVisible();
      await expect(page.getByTestId('profile-bio')).toHaveCount(0);

      // Cancelled with the operators' reason: recorded, and the 소개 is not restored (#37-10).
      await memberActions.getByTestId('moderation-action-cancel').click();
      await adminPage.getByTestId('moderation-record').fill(`이의를 받아들임 ${tag}`);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationCancelDone)).toBeVisible();
      await expect(memberActions.getByTestId('moderation-action-cancelled')).toHaveText(
        copy.moderationCancelled,
      );
      await expect(memberActions.getByTestId('moderation-action-cancel')).toHaveCount(0);
      await expect(adminPage.getByTestId('moderation-profile-bio')).toContainText(
        copy.adminModerationNone,
      );

      // The member reads the action as cancelled, with no appeal left to make.
      await page.goto('/my/moderation');
      const action = page.getByTestId('my-actions-list').locator('article');
      await expect(action).toHaveCount(1);
      await expect(action.getByTestId('my-action-type')).toHaveText(copy.moderationActionBioClear);
      await expect(action.getByTestId('my-action-subject')).toHaveText(
        copy.moderationSubjectProfile,
      );
      await expect(action.getByTestId('my-action-cancelled')).toHaveText(copy.moderationCancelled);
      await expect(action.getByTestId('my-action-appeal')).toHaveCount(0);

      // An operator's own post: its page offers no action — another operator processes it.
      const operatorMarket = await createOpenMarket(admin);
      const ownPost = await postThroughApi(
        admin,
        operatorMarket.id,
        `운영자의 글 ${tag}`,
        `운영자 본문 ${tag}`,
      );
      // A member reports it: the operator reads that report without who sent it, nor what they
      // wrote (owner decision 2026-10-21) — the reason and the time stay.
      const reporterMe = await meOf(reporter.request);
      const onOwn = await reporter.request.post(`/api/v1/posts/${ownPost}/reports`, {
        data: {
          reason: 'other',
          description: `운영자 글 신고 ${tag}`,
          expectedAccountId: reporterMe.id,
        },
      });
      expect(onOwn.status(), await onOwn.text()).toBe(201);
      await adminPage.goto(`/admin/moderation/posts/${ownPost}`);
      await expect(adminPage.getByTestId('moderation-own')).toHaveText(
        copy.adminModerationOwnNotice,
      );
      await expect(adminPage.getByTestId('moderation-action-bar')).toHaveCount(0);
      const ownReports = adminPage.getByTestId('moderation-reports-block');
      await expect(ownReports.getByTestId('moderation-report-withheld')).toHaveText(
        copy.adminModerationWithheldReport,
      );
      await expect(ownReports).toContainText(copy.reportReasonOther);
      await expect(ownReports).not.toContainText(reporterMe.profile.nickname);
      await expect(ownReports).not.toContainText(`운영자 글 신고 ${tag}`);
      // The count of reporters stays (owner decision 2026-10-22 답 1).
      await expect(adminPage.getByTestId('moderation-reporter-count')).toHaveText(
        `${copy.adminReporterCount} 1${copy.adminCountUnitPeople}`,
      );

      // Another operator processes it — hides the post, which closes that report (and leaves no
      // report waiting in a persistent database). The operator reads the action on their own post
      // with its reason and time and without who took it (owner decision 2026-10-21): the line
      // that says so, and no operator's name — not even '삭제된 계정'.
      const second = await meOf(secondAdmin);
      const secondNote = `다른 운영자의 숨김 ${tag}`;
      const hidden = await secondAdmin.post(`/api/v1/admin/moderation/posts/${ownPost}/hide`, {
        data: { reason: 'other', note: secondNote, expectedAccountId: second.id },
      });
      expect(hidden.status(), await hidden.text()).toBe(200);
      await adminPage.reload();
      const ownActions = adminPage.getByTestId('moderation-item-actions');
      await expect(ownActions.getByTestId('moderation-action-type')).toHaveText(
        copy.moderationActionHide,
      );
      await expect(ownActions.getByTestId('moderation-action-withheld')).toHaveText(
        copy.adminModerationWithheldAction,
      );
      await expect(ownActions).toContainText(secondNote);
      await expect(ownActions).toContainText(copy.moderationTakenAt);
      await expect(ownActions).not.toContainText(copy.adminModerationCreatedBy);
      await expect(ownActions).not.toContainText(copy.adminAccountsTargetGone);
      await expect(adminPage.getByTestId('admin-post-moderation')).not.toContainText(
        second.profile.nickname,
      );
      await expect(ownReports.getByTestId('moderation-report-status')).toHaveText(
        copy.reportStatusActioned,
      );
    } finally {
      await reporterContext.close();
      await adminContext.close();
    }
  });

  test('카드의 신고는 글을 열지 않고 신고하며, 운영자에게만 공개 화면의 운영 링크가 보이고, 그 링크로 준 경고는 취소될 때까지 MY 요약에 안내 띠로 보인다', async ({
    admin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    // The author, with a post and a comment under it.
    await signUp(page, freshEmail());
    const author = await meOf(page.request);
    const postTitle = `카드에서 신고될 글 ${tag}`;
    const postId = await postThroughApi(page.request, market.id, postTitle, `본문 ${tag}`);
    const commentId = await commentThroughApi(page.request, postId, `카드에서 신고될 댓글 ${tag}`);
    const listPath = `/community?market=${market.id}`;
    const profileUrl = `/u/${author.profile.publicId}`;

    const reporterContext = await browser.newContext();
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      // The author's own card offers no 신고, on the list and on their profile — checked once
      // GET /me has answered: the button waits for it, and the card is in the server's HTML before
      // (the 잔고 chip leaves its skeleton in the same draw).
      await page.goto(listPath);
      const ownCard = page.getByTestId(`post-card-${postId}`);
      await expect(page.getByTestId('balance-chip')).toBeVisible();
      await expect(ownCard.getByTestId('post-card-likes')).toBeVisible();
      await expect(ownCard.getByTestId('report-open')).toHaveCount(0);
      await page.goto(profileUrl);
      await expect(page.getByTestId('profile-edit')).toBeVisible();
      const ownPostCard = page.getByTestId('profile-posts-list').getByTestId(`post-card-${postId}`);
      await expect(ownPostCard).toBeVisible();
      await expect(ownPostCard.getByTestId('report-open')).toHaveCount(0);
      await page.getByTestId('profile-authored-tab-comments').click();
      const ownCommentCard = page.getByTestId(`authored-comment-${commentId}`);
      await expect(ownCommentCard).toBeVisible();
      await expect(ownCommentCard.getByTestId('report-open')).toHaveCount(0);
      // Nor 운영 for a member, anywhere.
      await page.goto(`/community/posts/${postId}`);
      await expect(page.getByTestId('post-edit')).toBeVisible();
      await expect(page.getByTestId('post-operator-link')).toHaveCount(0);
      await expect(page.getByTestId('comment-operator-link')).toHaveCount(0);

      // A visitor's press on a card goes to the login page, back to the list as it was filtered.
      const visitor = await visitorContext.newPage();
      await visitor.goto(listPath);
      await visitor.getByTestId(`post-card-${postId}`).getByTestId('report-open').click();
      await expect(visitor).toHaveURL(`/login?next=${encodeURIComponent(listPath)}`);

      // Another member reports the post from its card: the dialog opens over the list — the
      // press opens no post — and the button is no part of the card's link.
      const reporter = await reporterContext.newPage();
      await signUp(reporter, freshEmail());
      await reporter.goto(listPath);
      const card = reporter.getByTestId(`post-card-${postId}`);
      const cardReport = card.getByTestId('report-open');
      await expect(cardReport).toBeVisible();
      await expect(card.getByTestId('post-card-link').getByTestId('report-open')).toHaveCount(0);
      // Named by its post, as every repeated per-item button (ADR-0080 7-19); the words stay 신고.
      await expect(cardReport).toHaveText(copy.reportAction);
      await expect(cardReport).toHaveAccessibleName(`${postTitle} ${copy.reportAction}`);
      await cardReport.click();
      await expect(reporter.getByTestId('report-dialog')).toContainText(copy.reportPostTitle);
      await expectReportItem(reporter, copy.reportPostTitle, postTitle);
      await expect(reporter).toHaveURL(listPath);
      await reporter.getByTestId('report-reason-spam').click();
      const postReportId = await sendReport(reporter, `/api/v1/posts/${postId}/reports`);
      await expect(reporter).toHaveURL(listPath);

      // And the comment from the 댓글 tab of the author's profile; the 글 tab's card has it too.
      await reporter.goto(profileUrl);
      await expect(
        reporter
          .getByTestId('profile-posts-list')
          .getByTestId(`post-card-${postId}`)
          .getByTestId('report-open'),
      ).toBeVisible();
      await reporter.getByTestId('profile-authored-tab-comments').click();
      const commentCard = reporter.getByTestId(`authored-comment-${commentId}`);
      const commentReport = commentCard.getByTestId('report-open');
      await expect(commentReport).toBeVisible();
      await expect(
        commentCard.getByTestId('authored-comment-link').getByTestId('report-open'),
      ).toHaveCount(0);
      await expect(commentReport).toHaveAccessibleName(
        `카드에서 신고될 댓글 ${tag} ${copy.reportAction}`,
      );
      await commentReport.click();
      await expect(reporter.getByTestId('report-dialog')).toContainText(copy.reportCommentTitle);
      await expectReportItem(reporter, copy.reportCommentTitle, `카드에서 신고될 댓글 ${tag}`);
      await reporter.getByTestId('report-reason-off_topic').click();
      const commentReportId = await sendReport(reporter, `/api/v1/comments/${commentId}/reports`);
      await expect(reporter).toHaveURL(new RegExp(`/u/${author.profile.publicId}\\?tab=comments$`));
      await expect(reporter.getByTestId('profile-operator-link')).toHaveCount(0);

      // The operator: '운영' on the post, on its comment and on the profile, each to its page.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/community/posts/${postId}`);
      const postLink = adminPage.getByTestId('post-operator-link');
      await expect(postLink).toHaveText(copy.operatorModerationLink);
      await expect(postLink).toHaveAccessibleName(copy.operatorModerationPostLabel);
      await expect(postLink).toHaveAttribute('href', `/admin/moderation/posts/${postId}`);
      const commentLink = adminPage
        .getByTestId(`comment-${commentId}`)
        .getByTestId('comment-operator-link');
      await expect(commentLink).toHaveAttribute('href', `/admin/moderation/comments/${commentId}`);
      await commentLink.click();
      await expect(adminPage).toHaveURL(`/admin/moderation/comments/${commentId}`);
      await expect(adminPage.getByTestId('moderation-reports-block')).toContainText(
        copy.reportReasonOffTopic,
      );
      await adminPage.goto(profileUrl);
      await adminPage.getByTestId('profile-operator-link').click();
      await expect(adminPage).toHaveURL(`/admin/moderation/profiles/${author.profile.publicId}`);
      await expect(adminPage.getByTestId('moderation-user-nickname')).toContainText(
        author.profile.nickname,
      );
      // The two reports dismissed, so none is left waiting in a persistent database's queue.
      const operator = await meOf(admin);
      const dismissed = await admin.post('/api/v1/admin/reports/dismiss', {
        data: {
          reportIds: [postReportId, commentReportId],
          reason: `카드 신고 시험의 정리 ${tag}`,
          expectedAccountId: operator.id,
        },
      });
      expect(dismissed.status(), await dismissed.text()).toBe(200);

      // A warning from there, about nothing in particular.
      await adminPage.getByTestId('moderation-warn').click();
      await adminPage.getByTestId('moderation-reason').selectOption('harassment');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationWarned)).toBeVisible();
      const warning = adminPage
        .getByTestId('moderation-author-actions')
        .getByTestId('moderation-action-type')
        .filter({ hasText: copy.moderationActionWarning });
      await expect(warning).toHaveCount(1);

      // The member: its banner on the MY summary, leading to 조치·신고 내역 — not on the write page,
      // which keeps its banner for restrictions: once the actions are read there, nothing on it
      // says a warning was received.
      await page.goto('/my');
      const banner = page.getByTestId('my-warning-banner');
      await expect(banner).toContainText(copy.moderationWarningReceived);
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
      await gotoWithActionsRead(page, `/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-write-market')).toBeVisible();
      await expect(page.getByText(copy.moderationWarningReceived)).toHaveCount(0);
      await expect(page.getByTestId('post-write-sanction-banner')).toHaveCount(0);
      await page.goto('/my');
      await page.getByTestId('my-warning-banner').getByRole('link').click();
      await expect(page).toHaveURL('/my/moderation');
      await expect(page.getByTestId('my-actions-list').getByTestId('my-action-type')).toHaveText(
        copy.moderationActionWarning,
      );

      // Cancelled, the banner is gone.
      await adminPage
        .getByTestId('moderation-author-actions')
        .getByTestId('moderation-action-cancel')
        .click();
      await adminPage.getByTestId('moderation-record').fill(`이의를 받아들임 ${tag}`);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationCancelDone)).toBeVisible();
      // 조치·신고 내역 reads the warning as cancelled; the summary, reached from there by the MY
      // link, draws from those very actions at once — so its banner would be there with the page.
      await page.goto('/my/moderation');
      await expect(
        page.getByTestId('my-actions-list').getByTestId('my-action-cancelled'),
      ).toHaveText(copy.moderationCancelled);
      await shownNav(page).getByRole('link', { name: copy.navMy, exact: true }).click();
      await expect(page).toHaveURL('/my');
      await expect(page.getByTestId('my-preview-wallet')).toBeVisible();
      await expect(page.getByTestId('my-warning-banner')).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      await reporterContext.close();
      await visitorContext.close();
      await adminContext.close();
    }
  });

  test('닉네임 강제 변경을 받은 회원은 조치·신고 내역에서 이전 닉네임을 30일 동안 다시 쓸 수 없다는 줄을 보고 다른 회원처럼 그 닉네임을 거절당하며, 운영자가 취소하면 취소 창이 그 보류를 말하고 회원만 곧바로 다시 고른다', async ({
    page,
    browser,
  }) => {
    const nickname = freshNickname('Ns');
    await signUp(page, freshEmail(), undefined, { nickname });
    const member = await meOf(page.request);
    expect(member.profile.nickname).toBe(nickname);

    const otherContext = await browser.newContext();
    const adminContext = await browser.newContext();
    /** Tries `wanted` on MY 설정's nickname form of `who`. */
    const pick = async (who: Page, wanted: string) => {
      await who.goto('/my/settings');
      const input = who.getByTestId('nickname-input');
      await expect(input).toBeEditable();
      await input.fill(wanted);
      await who.getByTestId('settings-profile').getByRole('button', { name: copy.save }).click();
    };
    try {
      // The operator gives the nickname back to an auto nickname from the member's page.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/moderation/users/${member.id}`);
      await adminPage.getByTestId('moderation-nickname-reset').click();
      await adminPage.getByTestId('moderation-reason').selectOption('impersonation');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationNicknameResetDone)).toBeVisible();
      const memberActions = adminPage.getByTestId('moderation-author-actions');
      await expect(memberActions.getByTestId('moderation-action-removed')).toContainText(nickname);

      // The member: the reset on 조치·신고 내역 with the line about the former nickname — never
      // the nickname itself (#37-3).
      await page.goto('/my/moderation');
      const action = page.getByTestId('my-actions-list').locator('article');
      await expect(action).toHaveCount(1);
      await expect(action.getByTestId('my-action-type')).toHaveText(
        copy.moderationActionNicknameReset,
      );
      await expect(action.getByTestId('my-action-nickname-held')).toHaveText(
        copy.moderationNicknameHeld,
      );
      await expect(page.getByTestId('my-moderation')).not.toContainText(nickname);
      // Held from the member too, with the approved words — and from another member.
      await pick(page, nickname);
      await expect(page.getByTestId('nickname-error')).toHaveText(copy.errNicknameTaken);
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      await pick(other, nickname.toUpperCase());
      await expect(other.getByTestId('nickname-error')).toHaveText(copy.errNicknameTaken);

      // Cancelled: the dialog says the former nickname is the member's alone to pick again.
      await adminPage.reload();
      await memberActions.getByTestId('moderation-action-cancel').click();
      const cancelDialog = adminPage.getByTestId('moderation-cancel-dialog');
      await expect(cancelDialog).toContainText(copy.adminModerationCancelNicknameResetBody);
      await expect(cancelDialog).not.toContainText(copy.adminModerationCancelBody);
      await adminPage.getByTestId('moderation-record').fill('이의를 받아들임');
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationCancelDone)).toBeVisible();
      await expect(memberActions.getByTestId('moderation-action-cancelled')).toHaveText(
        copy.moderationCancelled,
      );

      // The member: cancelled, without the line; the nickname is not restored, theirs to pick.
      await page.goto('/my/moderation');
      await expect(action.getByTestId('my-action-cancelled')).toHaveText(copy.moderationCancelled);
      await expect(action.getByTestId('my-action-nickname-held')).toHaveCount(0);
      expect((await meOf(page.request)).profile.nickname).not.toBe(nickname);
      // The other member is still refused it, in any case; the member, who has picked no
      // nickname since the reset, takes it back at once.
      for (const wanted of [nickname, nickname.toUpperCase()]) {
        await pick(other, wanted);
        await expect(other.getByTestId('nickname-error')).toHaveText(copy.errNicknameTaken);
      }
      await pick(page, nickname);
      await expect(page.getByText(copy.nicknameSaved)).toBeVisible();
      await expect(page.getByTestId('nickname-input')).toHaveValue(nickname);
      expect((await meOf(page.request)).profile.nickname).toBe(nickname);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      await otherContext.close();
      await adminContext.close();
    }
  });
});
