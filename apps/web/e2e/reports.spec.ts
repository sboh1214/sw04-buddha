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
 *   not restored by a cancellation), and an operator's own post offering no action.
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

/** A 댓글 straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId: null, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/**
 * The queue's entry, shown: the pending half lists the target waiting longest first, and an
 * earlier run's reports may still wait in a persistent database, so 더 보기 until it is there.
 */
async function showInQueue(page: Page, entry: Locator): Promise<void> {
  for (let pages = 0; pages < 50; pages += 1) {
    if (await entry.isVisible()) return;
    const more = page.getByTestId('admin-reports-more');
    await expect(more.or(entry)).toBeVisible();
    if (await entry.isVisible()) return;
    await more.click();
  }
  await expect(entry).toBeVisible();
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

      // The comment, 괴롭힘, from its own 신고.
      await reporter.getByTestId(`comment-${commentId}`).getByTestId('report-open').click();
      await expect(dialog).toContainText(copy.reportCommentTitle);
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
      // A hiding is no sanction (#45-12): no banner on MY or the write page.
      await page.goto('/my');
      await expect(page.getByTestId('my-preview-wallet')).toBeVisible();
      await expect(page.getByTestId('my-sanction-banner')).toHaveCount(0);
      await page.goto(`/community/write?market=${market.id}`);
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

  test('회원의 프로필을 신고하면 운영자가 회원 화면에서 소개를 비우고 그 소개는 운영자만 보며, 조치를 취소해도 되살리지 않고, 운영자 자신의 글에는 처리 단추 없이 다른 운영자가 처리한다고 보인다', async ({
    admin,
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
      await adminPage.goto(`/admin/moderation/posts/${ownPost}`);
      await expect(adminPage.getByTestId('moderation-own')).toHaveText(
        copy.adminModerationOwnNotice,
      );
      await expect(adminPage.getByTestId('moderation-action-bar')).toHaveCount(0);
    } finally {
      await reporterContext.close();
      await adminContext.close();
    }
  });
});
