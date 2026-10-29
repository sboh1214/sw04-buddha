import { type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';
import { copy } from '../src/copy';
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
 * 작성 제한 (#185, ADR-0082; owner decisions in ADR-0069 decision 2 #45-12 and #45-14, decision 3
 * #37-9, decision 4 #185 rows, decision 7), walked on the screens with two browsers — the member
 * and an operator:
 *
 * - the operator restricts the member for 1 day from the member's page (a term picked, none by
 *   default, with a reason); the member's write page and MY summary show the banner with the end
 *   and the way to 조치·신고 내역 — no reason, no appeal (owner decision 2026-10-22 evening); a new
 *   post, an edit of their own, a 댓글 and a new 소개 are refused with the end and that way, no
 *   appeal sentence — the edit's form stays editable under its refusal and sends again, the post
 *   not read for it: not the held form of a post taken from under it (#46·#48·#50); two post images
 *   picked at once are refused in one toast with the end and no button, the second never sent
 *   (owner decision 2026-10-23 answer 12; the refusal ends the batch); a like and deleting their
 *   own stay open; 조치·신고 내역 lists it '진행 중'; the operator lifts it early with a reason of
 *   their own — the banner goes, the member writes again, and 조치·신고 내역 says '조기 해제됨',
 *   the changed end and the end it was given, not the reason (owner decision 2026-10-23 answer 4;
 *   the brief: «admin restricts a user for 1 day → write button shows restriction message, likes
 *   still work, admin lifts → can write»);
 * - from a reported post's page the operator restricts its author 무기한 about that post — its
 *   pending report is resolved (조치함) — the member's banner and refusal say 무기한, clearing the
 *   소개 stays open, and the operator's 감경 brings the end forward to a time, which the member
 *   reads as the new end with '감경됨' and the end it was given (무기한) — and, lifted after,
 *   '조기 해제됨' with that same original end;
 * - an operator another operator restricted still writes a notice with an image (owner decision
 *   2026-10-23 answer 13): the notice editor uploads it as a notice's (`purpose=notice`), while the
 *   operator's post image stays refused at the upload.
 *
 * Every rule's branch (each blocked and open write, the end by the clock, the later end governing,
 * the refusals of a 감경 and a lift, the audit rows, the profile lock) is the API's test
 * (restrictions.controller.test.ts); the wording's is the web's unit tests (lib/restriction.test.ts).
 * Every report a test files is processed before it ends.
 */

/** A 1×1 PNG, as posts.spec.ts sends: refused here before it is looked at. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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
 * Opens `path` and waits until the member's own restriction (`GET /me/moderation/restriction`,
 * read in the browser once the session is known) has answered and been drawn: the banner is drawn
 * from it and draws nothing while it is read, so a check that it is absent proves nothing before
 * it. The page before is left for a blank one first: it may be reading the same restriction still
 * — a write refused with RESTRICTED reads it again (query-client.ts) — and that answer is not the
 * new page's.
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

/**
 * An instant as the screens write it in Korean time — the member's here too, whose browser is in
 * Asia/Seoul and who picked no zone (ADR-0063) — `formatKst`'s rule: ko-KR's medium date and short
 * time, the day period as 오전·오후 whichever ICU renders it.
 */
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

/** The `datetime-local` value of an instant in Korean time, as the admin's input reads it. */
function kstLocal(ms: number): string {
  const shifted = new Date(ms + 9 * 60 * 60 * 1_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * The appeal's guidance as 조치·신고 내역 words it, up to its email: never on a banner nor in a
 * refusal (owner decision 2026-10-22 evening, via #186 — the end and the way there only).
 */
const APPEAL_START = copy.myModerationAppeal.slice(0, copy.myModerationAppeal.indexOf('{{'));

/**
 * A refusal's way to 조치·신고 내역 (`RefusalText`): the link under the end, and no appeal sentence
 * in the refusal.
 */
async function expectModerationLink(refusal: Locator): Promise<void> {
  await expect(refusal.getByTestId('restricted-moderation-link')).toHaveAttribute(
    'href',
    '/my/moderation',
  );
  await expect(refusal.getByTestId('restricted-moderation-link')).toHaveText(copy.myModerationOpen);
  await expect(refusal).not.toContainText(APPEAL_START);
  await expect(refusal).not.toContainText('이의');
}

/** A writing restriction as the API answers it. */
interface Restriction {
  id: string;
  createdAt: string;
  endsAt: string | null;
}

/** Sends the open restriction dialog and waits for its answer. */
async function sendRestriction(adminPage: Page, userId: string): Promise<Restriction> {
  const answer = adminPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/v1/admin/moderation/users/${userId}/writing-restriction`,
  );
  await adminPage.getByTestId('moderation-submit').click();
  const response = await answer;
  expect(response.status(), await response.text()).toBe(200);
  await expect(adminPage.getByText(copy.adminModerationRestricted)).toBeVisible();
  await expect(adminPage.getByTestId('moderation-restrict-dialog')).toHaveCount(0);
  return ((await response.json()) as { data: Restriction }).data;
}

test.describe('작성 제한', () => {
  test('운영자가 회원 화면에서 1일 작성 제한을 걸면 회원의 글쓰기 화면과 MY 요약에 끝나는 때와 조치·신고 내역 링크의 안내 띠가 보이고, 글·수정·댓글·소개의 새 값은 끝나는 때와 조치·신고 내역 링크로, 글 이미지는 단추 없는 토스트로 거절되며 좋아요와 지우기는 그대로이고, 운영자가 조기 해제하면 띠가 사라지고 다시 쓰며 조치·신고 내역에 조기 해제됨과 원래 끝나는 때가 보인다', async ({
    admin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const ownPost = await postThroughApi(page.request, market.id, `제한 전 글 ${tag}`, tag);
    const toDelete = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, tag);
    const othersPost = await postThroughApi(admin, market.id, `운영자의 글 ${tag}`, tag);

    const adminContext = await browser.newContext();
    try {
      // --- the operator: the member's page, 작성 제한 — a term and a reason are needed.
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/moderation/users/${member.id}`);
      await adminPage.getByTestId('moderation-restrict').click();
      const dialog = adminPage.getByTestId('moderation-restrict-dialog');
      await expect(
        dialog.locator('[data-testid^="moderation-term-"] [data-part="item-text"]'),
      ).toHaveText(['1일', '3일', '7일', '30일', copy.restrictionIndefinite]);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(dialog.getByTestId('moderation-term-error')).toHaveText(
        copy.errModerationTermRequired,
      );
      await expect(dialog).toContainText(copy.errModerationReasonRequired);
      await adminPage.getByTestId('moderation-term-1').click();
      await adminPage.getByTestId('moderation-reason').selectOption('spam');
      const note = `같은 링크를 되풀이했습니다 ${tag}`;
      await adminPage.getByTestId('moderation-note').fill(note);
      const restriction = await sendRestriction(adminPage, member.id);
      expect(restriction.endsAt).not.toBeNull();
      const endsAt = restriction.endsAt!;
      // A day is 24 hours from the restriction's own time.
      expect(Date.parse(endsAt) - Date.parse(restriction.createdAt)).toBe(24 * 60 * 60 * 1_000);
      const row = adminPage.getByTestId(`moderation-action-${restriction.id}`);
      await expect(row.getByTestId('moderation-action-type')).toHaveText(
        copy.moderationActionWritingRestriction,
      );
      await expect(row.getByTestId('moderation-action-standing')).toHaveText(
        copy.restrictionStanding,
      );
      await expect(row.getByTestId('moderation-action-ends')).toContainText(kst(endsAt));

      // --- the member: the write page's banner — the end and the way to 내역, nothing more:
      // neither the reason nor the appeal (owner decision 2026-10-22 evening).
      const until = `(${kst(endsAt)}${copy.restrictionUntil}).`;
      const writing = `${copy.errRestrictedWriting}${until}`;
      await gotoWithRestrictionRead(page, `/community/write?market=${market.id}`);
      const banner = page.getByTestId('post-write-sanction-banner');
      await expect(banner).toContainText(copy.restrictionWritingTitle);
      await expect(banner.getByTestId('post-write-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(endsAt)}`,
      );
      await expect(banner.getByTestId('post-write-sanction-banner-link')).toHaveAttribute(
        'href',
        '/my/moderation',
      );
      await expect(banner).not.toContainText(note);
      await expect(banner).not.toContainText(copy.reportReasonSpam);
      await expect(banner).not.toContainText(APPEAL_START);
      await expect(banner).not.toContainText('이의');
      // A new post: refused with the end and the way to 내역, the form kept.
      await page.getByTestId('post-title-input').fill(`제한 중 글 ${tag}`);
      await page.getByTestId('post-editor-content').click();
      await page.keyboard.type(`제한 중 본문 ${tag}`);
      await page.getByTestId('post-submit').click();
      const postRefusal = page.getByTestId('post-form-error');
      await expect(postRefusal).toContainText(writing);
      await expectModerationLink(postRefusal);
      await expect(page).toHaveURL(`/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-title-input')).toHaveValue(`제한 중 글 ${tag}`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // A post image: refused in a toast that says the end and has no button — the banner above
      // has the way to 내역 (owner decision 2026-10-23 answer 12). Nothing goes into the editor.
      // Two picked at once: the refusal is the account's, so it ends the batch — the second is
      // never sent, and the refusal is said once (`refusesImageBatch`).
      const uploads: string[] = [];
      const countUpload = (request: Request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/v1/media/images'
        ) {
          uploads.push(request.url());
        }
      };
      page.on('request', countUpload);
      const refused = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/media/images',
      );
      await page.getByTestId('post-editor-file').setInputFiles([
        { name: 'evidence.png', mimeType: 'image/png', buffer: PNG },
        { name: 'evidence-2.png', mimeType: 'image/png', buffer: PNG },
      ]);
      expect((await refused).status()).toBe(403);
      const toast = page.locator('[data-scope="toast"][data-part="root"]').filter({
        hasText: writing,
      });
      await expect(toast).toBeVisible();
      // The batch is over once nothing uploads: the second file was never sent.
      await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
      await expect(toast).toHaveCount(1);
      expect(uploads).toHaveLength(1);
      page.off('request', countUpload);
      await expect(toast.locator('[data-part="action-trigger"]')).toHaveCount(0);
      await expect(toast.getByRole('button', { name: copy.myModerationOpen })).toHaveCount(0);
      await expect(toast).not.toContainText(copy.myModerationOpen);
      await expect(
        page.getByTestId('post-editor-content').locator('img[data-media-id]'),
      ).toHaveCount(0);

      // An edit of their own post: refused the same way.
      await page.goto(`/community/posts/${ownPost}/edit`);
      await page.getByTestId('post-title-input').fill(`제한 중 고친 글 ${tag}`);
      await page.getByTestId('post-submit').click();
      await expect(page.getByTestId('post-form-error')).toContainText(writing);
      await expectModerationLink(page.getByTestId('post-form-error'));
      // Not the post taken from under the form (the held form of #46·#48·#50 — ADR-0073 9-52,
      // ADR-0074 7-35, ADR-0081 7-29): the refusal is the writer's, asked before the post, so the
      // form stays editable under it with 저장 — no held notice, no 닫기 — and the post is not
      // read again for it (ADR-0082 결과 5 «다시 쌓기(2026-10-25)»). Typed on and sent again, it
      // is refused the same way.
      const editTitle = page.getByTestId('post-title-input');
      const editBody = page.getByTestId('post-editor-content');
      await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
      await expect(page.getByTestId('post-form-close')).toHaveCount(0);
      await expect(page.getByTestId('post-edit-unavailable')).toHaveCount(0);
      await expect(editTitle).toBeEditable();
      await expect(editTitle).toHaveValue(`제한 중 고친 글 ${tag}`);
      await expect(editBody).toHaveAttribute('contenteditable', 'true');
      await expect(page.getByTestId('post-submit')).toBeEnabled();
      const postReads: string[] = [];
      const edits: string[] = [];
      const countPostRequest = (request: Request) => {
        if (new URL(request.url()).pathname !== `/api/v1/posts/${ownPost}`) return;
        if (request.method() === 'GET') postReads.push(request.url());
        if (request.method() === 'PUT') edits.push(request.url());
      };
      page.on('request', countPostRequest);
      await editTitle.fill(`제한 중 다시 고친 글 ${tag}`);
      await editBody.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' 덧붙임');
      await expect(editBody).toContainText('덧붙임');
      const refusedAgain = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === `/api/v1/posts/${ownPost}`,
      );
      await page.getByTestId('post-submit').click();
      expect((await refusedAgain).status()).toBe(403);
      await expect(page.getByTestId('post-form-error')).toContainText(writing);
      await expectModerationLink(page.getByTestId('post-form-error'));
      await page.waitForTimeout(1_000);
      expect(edits).toHaveLength(1);
      expect(postReads).toEqual([]);
      page.off('request', countPostRequest);
      await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
      await expect(editTitle).toBeEditable();
      await expect(editTitle).toHaveValue(`제한 중 다시 고친 글 ${tag}`);
      await expect(editBody).toHaveAttribute('contenteditable', 'true');
      await expect(page).toHaveURL(`/community/posts/${ownPost}/edit`);

      // On another's post: a 댓글 is refused under its box, the like goes through (#45-12).
      await page.goto(`/community/posts/${othersPost}`);
      const composer = page.getByTestId('comment-composer');
      await composer.getByTestId('comment-input').fill(`제한 중 댓글 ${tag}`);
      await composer.getByTestId('comment-submit').click();
      await expect(composer.getByTestId('comment-error')).toContainText(writing);
      await expectModerationLink(composer.getByTestId('comment-error'));
      await expect(composer.getByTestId('comment-input')).toHaveValue(`제한 중 댓글 ${tag}`);
      const like = page.getByTestId('post-like');
      await expect(like).not.toHaveAttribute('aria-busy');
      await expect(like).toHaveAttribute('aria-pressed', 'false');
      await like.click();
      await expect(like).not.toHaveAttribute('aria-busy');
      await expect(like).toHaveAttribute('aria-pressed', 'true');
      // As the server took it: read again.
      await page.reload();
      await expect(like).not.toHaveAttribute('aria-busy');
      await expect(like).toHaveAttribute('aria-pressed', 'true');

      // Deleting their own stays open (#45-12 확인).
      await page.goto(`/community/posts/${toDelete}`);
      await page.getByTestId('post-delete').click();
      await page.getByTestId('post-delete-confirm').click();
      await expect(page).toHaveURL('/community');

      // A new 소개 (#37-9): refused, clearing said to stay open.
      await page.goto('/my/settings');
      await page.getByTestId('bio-input').fill(`제한 중 소개 ${tag}`);
      await page.getByTestId('bio-save').click();
      const bioNotice = page.getByTestId('bio-notice');
      await expect(bioNotice).toContainText(`${copy.errRestrictedProfile}${until}`);
      await expect(bioNotice).toContainText(copy.errRestrictedClearAllowed);
      await expectModerationLink(bioNotice);

      // MY summary's banner, and 조치·신고 내역 by its link: 작성 제한, 진행 중, its end and reason.
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(endsAt)}`,
      );
      await expect(page.getByTestId('my-sanction-banner')).not.toContainText(note);
      await page.getByTestId('my-sanction-banner-link').click();
      await expect(page).toHaveURL('/my/moderation');
      const item = page.getByTestId(`my-action-${restriction.id}`);
      await expect(item.getByTestId('my-action-type')).toHaveText(
        copy.moderationActionWritingRestriction,
      );
      await expect(item.getByTestId('my-action-standing')).toHaveText(copy.restrictionStanding);
      await expect(item.getByTestId('my-action-ends')).toContainText(kst(endsAt));
      await expect(item.getByTestId('my-action-reason')).toContainText(copy.reportReasonSpam);
      await expect(item.getByTestId('my-action-appeal')).toBeVisible();
      // Given about nothing in particular: no subject — not '내 프로필'.
      await expect(item.getByTestId('my-action-subject')).toHaveCount(0);
      // Its end never changed: no 조기 해제됨·감경됨, no original end.
      await expect(item.getByTestId('my-action-end-change')).toHaveCount(0);
      await expect(item.getByTestId('my-action-original-ends')).toHaveCount(0);

      // --- the operator lifts it early, with a reason of their own.
      await adminPage.reload();
      await row.getByTestId('moderation-action-lift').click();
      const liftDialog = adminPage.getByTestId('moderation-lift-dialog');
      await expect(liftDialog).toContainText(copy.adminModerationLiftBody);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(liftDialog.getByTestId('moderation-text-error')).toHaveText(
        copy.errModerationRecordRequired,
      );
      await adminPage.getByTestId('moderation-record').fill(`소명을 받아들였습니다 ${tag}`);
      const liftAnswer = adminPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/v1/admin/moderation/actions/${restriction.id}/lift`,
      );
      await adminPage.getByTestId('moderation-submit').click();
      const liftResponse = await liftAnswer;
      expect(liftResponse.status(), await liftResponse.text()).toBe(200);
      const liftedEnd = ((await liftResponse.json()) as { data: Restriction }).data.endsAt!;
      await expect(adminPage.getByText(copy.adminModerationLifted)).toBeVisible();
      await expect(row.getByTestId('moderation-action-standing')).toHaveCount(0);
      await expect(row.getByTestId('moderation-action-lift')).toHaveCount(0);
      await expect(row.getByTestId('moderation-end-change')).toContainText(
        `${copy.adminModerationEndChangeLift} · ${kst(endsAt)} →`,
      );
      await expect(row).toContainText(`소명을 받아들였습니다 ${tag}`);

      // --- the member: no banner, and the post goes up.
      await gotoWithRestrictionRead(page, `/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-write-market')).toBeVisible();
      await expect(page.getByTestId('post-write-sanction-banner')).toHaveCount(0);
      await page.getByTestId('post-title-input').fill(`해제 뒤 글 ${tag}`);
      await page.getByTestId('post-editor-content').click();
      await page.keyboard.type(`해제 뒤 본문 ${tag}`);
      await page.getByTestId('post-submit').click();
      await expect(page).toHaveURL(/\/community\/posts\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('post-title')).toHaveText(`해제 뒤 글 ${tag}`);
      // 조치·신고 내역: 조기 해제됨, the changed end and the end it was given — not the reason
      // (owner decision 2026-10-23 answer 4).
      await page.goto('/my/moderation');
      await expect(item.getByTestId('my-action-standing')).toHaveCount(0);
      await expect(item.getByTestId('my-action-cancelled')).toHaveCount(0);
      await expect(item.getByTestId('my-action-end-change')).toHaveText(copy.moderationEndLifted);
      await expect(item.getByTestId('my-action-ends')).toContainText(kst(liftedEnd));
      const originalEnds = item.getByTestId('my-action-original-ends');
      await expect(originalEnds).toContainText(copy.moderationOriginalEndsAt);
      await expect(originalEnds).toContainText(kst(endsAt));
      await expect(page.getByTestId('my-moderation')).not.toContainText(
        `소명을 받아들였습니다 ${tag}`,
      );
    } finally {
      await adminContext.close();
    }
  });

  test('신고된 글의 운영 화면에서 그 작성자에게 무기한 작성 제한을 걸면 그 글의 신고가 조치함으로 닫히고, 회원은 무기한의 띠와 거절을 보며 소개는 비울 수 있고, 운영자가 감경하면 회원은 앞당긴 끝나는 때와 감경됨·원래 끝나는 때(무기한)를 본다', async ({
    admin,
    secondAdmin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const postTitle = `신고된 글 ${tag}`;
    const postId = await postThroughApi(page.request, market.id, postTitle, tag);
    const bio = await page.request.put('/api/v1/me/bio', {
      data: { bio: `제한 전 소개 ${tag}`, expectedAccountId: member.id },
    });
    expect(bio.status(), await bio.text()).toBe(200);
    // Reported by the second operator (an operator reports as anyone does, #45-10).
    const reporter = await meOf(secondAdmin);
    const report = await secondAdmin.post(`/api/v1/posts/${postId}/reports`, {
      data: { reason: 'harassment', description: null, expectedAccountId: reporter.id },
    });
    expect(report.status(), await report.text()).toBe(201);

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/moderation/posts/${postId}`);
      await adminPage.getByTestId('moderation-restrict').click();
      const dialog = adminPage.getByTestId('moderation-restrict-dialog');
      // About this post by default: its pending report is resolved by the restriction.
      await expect(
        dialog.getByRole('radio', { name: copy.adminModerationWarnSubjectThis }),
      ).toBeChecked();
      await adminPage.getByTestId('moderation-term-none').click();
      await adminPage.getByTestId('moderation-reason').selectOption('harassment');
      const restriction = await sendRestriction(adminPage, member.id);
      expect(restriction.endsAt).toBeNull();
      await expect(
        adminPage.getByTestId('moderation-reports-block').getByTestId('moderation-report-status'),
      ).toHaveText(copy.reportStatusActioned);
      const row = adminPage
        .getByTestId('moderation-item-actions')
        .getByTestId(`moderation-action-${restriction.id}`);
      await expect(row.getByTestId('moderation-action-ends')).toContainText(
        copy.restrictionIndefinite,
      );

      // --- the member: 무기한 on the banner and in the refusal; clearing the 소개 stays open.
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${copy.restrictionIndefinite}`,
      );
      await expect(page.getByTestId('my-sanction-banner')).not.toContainText(
        copy.reportReasonHarassment,
      );
      // MY 설정 says it above the public items (ADR-0078 결과 5).
      await gotoWithRestrictionRead(page, '/my/settings');
      await expect(page.getByTestId('settings-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${copy.restrictionIndefinite}`,
      );
      const bioInput = page.getByTestId('bio-input');
      await expect(bioInput).toHaveValue(`제한 전 소개 ${tag}`);
      await bioInput.fill(`다른 소개 ${tag}`);
      await page.getByTestId('bio-save').click();
      await expect(page.getByTestId('bio-notice')).toContainText(
        `${copy.errRestrictedProfile}(${copy.restrictionIndefinite}).`,
      );
      await expectModerationLink(page.getByTestId('bio-notice'));
      await bioInput.fill('');
      await page.getByTestId('bio-save').click();
      await expect(page.getByText(copy.bioCleared)).toBeVisible();

      // --- the operator's 감경: 무기한 to a time two days on, with a reason.
      await row.getByTestId('moderation-action-shorten').click();
      const shorten = adminPage.getByTestId('moderation-shorten-dialog');
      await expect(shorten).toContainText(copy.adminModerationShortenBody);
      await adminPage.getByTestId('moderation-record').fill(`이의를 일부 받아들였습니다 ${tag}`);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(shorten.getByTestId('moderation-end-error')).toHaveText(
        copy.errModerationEndRequired,
      );
      const local = kstLocal(Date.now() + 2 * 24 * 60 * 60 * 1_000);
      const newEnd = new Date(`${local}:00+09:00`).toISOString();
      await adminPage.getByTestId('moderation-end').fill(local);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationShortened)).toBeVisible();
      await expect(row.getByTestId('moderation-action-ends')).toContainText(kst(newEnd));
      await expect(row.getByTestId('moderation-end-change')).toContainText(
        `${copy.adminModerationEndChangeShorten} · ${copy.restrictionIndefinite} → ${kst(newEnd)}`,
      );
      await expect(row.getByTestId('moderation-action-standing')).toHaveText(
        copy.restrictionStanding,
      );

      // --- the member reads the new end, 감경됨 and the end it was given (무기한); nothing says
      // who changed it or why (owner decision 2026-10-23 answer 4).
      await gotoWithRestrictionRead(page, '/my');
      await expect(page.getByTestId('my-sanction-banner-ends')).toHaveText(
        `${copy.moderationEndsAt} ${kst(newEnd)}`,
      );
      await page.goto('/my/moderation');
      const item = page.getByTestId(`my-action-${restriction.id}`);
      await expect(item.getByTestId('my-action-standing')).toHaveText(copy.restrictionStanding);
      await expect(item.getByTestId('my-action-end-change')).toHaveText(
        copy.moderationEndShortened,
      );
      await expect(item.getByTestId('my-action-ends')).toContainText(kst(newEnd));
      await expect(item.getByTestId('my-action-original-ends')).toContainText(
        copy.restrictionIndefinite,
      );
      await expect(item.getByTestId('my-action-subject')).toHaveText(postTitle);
      await expect(page.getByTestId('my-moderation')).not.toContainText(
        `이의를 일부 받아들였습니다 ${tag}`,
      );

      // The restriction ends here, so a persistent database keeps no standing one behind.
      await row.getByTestId('moderation-action-lift').click();
      await adminPage.getByTestId('moderation-record').fill(`시험 정리 ${tag}`);
      await adminPage.getByTestId('moderation-submit').click();
      await expect(adminPage.getByText(copy.adminModerationLifted)).toBeVisible();
      // Lifted after its 감경: 조기 해제됨, the end it was given still 무기한.
      await page.reload();
      await expect(item.getByTestId('my-action-end-change')).toHaveText(copy.moderationEndLifted);
      await expect(item.getByTestId('my-action-standing')).toHaveCount(0);
      await expect(item.getByTestId('my-action-original-ends')).toContainText(
        copy.restrictionIndefinite,
      );
    } finally {
      await adminContext.close();
    }
  });

  test('작성 제한 중인 운영자도 공지 편집기에서 이미지를 공지의 것으로 올려 공지를 쓰고, 그 운영자의 글 이미지 올리기는 그대로 거절된다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    // Owner decision 2026-10-23 answer 13: a writing restriction does not block notices (#138),
    // the notice editor's image upload included — the editor says its images are a notice's
    // (`purpose=notice`, an admin's upload alone), and a post's image stays refused at the
    // upload (answer 2), an operator's too (answer 5, ADR-0082 7-9). The first seed admin
    // restricts the second for a day, and cancels it at the end: the seed admin is every spec's,
    // and none of theirs writes a post or a comment as it (a notice, a report and a moderation
    // action stay open under a restriction).
    const tag = freshTag();
    const operator = await meOf(admin);
    const second = await meOf(secondAdmin);
    const given = await admin.post(
      `/api/v1/admin/moderation/users/${second.id}/writing-restriction`,
      {
        data: { reason: 'spam', note: `공지 시험 ${tag}`, days: 1, expectedAccountId: operator.id },
      },
    );
    expect(given.status(), await given.text()).toBe(200);
    const restriction = ((await given.json()) as { data: Restriction }).data;
    try {
      const postImage = await secondAdmin.post(
        `/api/v1/media/images?expectedAccountId=${second.id}`,
        { data: PNG, headers: { 'content-type': 'image/png' } },
      );
      expect(postImage.status(), await postImage.text()).toBe(403);
      expect(((await postImage.json()) as { error: { code: string } }).error.code).toBe(
        'RESTRICTED',
      );

      await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
      await page.goto('/admin/notices/new');
      const editor = page.getByTestId('post-editor-content');
      await editor.click();
      await page.keyboard.type(`점검 안내 ${tag}`);
      const upload = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/media/images',
      );
      await page
        .getByTestId('post-editor-file')
        .setInputFiles({ name: 'notice.png', mimeType: 'image/png', buffer: PNG });
      const uploaded = await upload;
      expect(uploaded.status(), await uploaded.text()).toBe(201);
      expect(new URL(uploaded.url()).searchParams.get('purpose')).toBe('notice');
      await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
      await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
      const title = `제한 중에 쓴 공지 ${tag}`;
      await page.getByTestId('post-title-input').fill(title);
      await page.getByTestId('post-submit').click();
      await expect(page.getByText(copy.adminNoticeCreated)).toBeVisible();
      await expect(page).toHaveURL('/admin/notices');
      await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
    } finally {
      const cancelled = await admin.post(
        `/api/v1/admin/moderation/actions/${restriction.id}/cancel`,
        { data: { reason: `시험 정리 ${tag}`, expectedAccountId: operator.id } },
      );
      expect(cancelled.status(), await cancelled.text()).toBe(200);
    }
  });
});
