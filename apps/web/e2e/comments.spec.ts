import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, freshTag, meOf, signUp, test } from './helpers';

/**
 * 댓글·대댓글 (#48, ADR-0074; owner decisions in ADR-0069 decision 2, #45-2·3·4·5): a member
 * writes a 댓글 under a post (its address a link, a `javascript:` one not, its line break kept, no
 * probability asked), answers it and answers the answer — both land under the same 댓글, oldest
 * first, the focus back on the 답글 that opened the box — edits it in place ('수정됨', the focus
 * back on 수정), and sees the count on the post and on its community card. Deleting the 댓글 says
 * so and leaves '삭제된 글입니다' with its 대댓글 and no author, and it takes no new 대댓글; deleting a
 * 대댓글 removes it; deleting the post leaves its placeholder with every comment still readable and
 * no box to write in (N04 §6), and once its last comment is deleted the open page is its 404. An
 * admin's comment carries '운영자' and offers the member 답글 only. A visitor reads the comments,
 * which the server put in the HTML, a long address wrapping inside a phone's width, and is asked
 * to sign in, coming back to the post. Leaving a new 댓글, a 답글 or an edit with text asks first
 * (staying keeps it, an empty box asks nothing); an account facing a re-consent still deletes its
 * own comment on the post page, while 답글, 수정 and 올리기 take it to the step — every box's text
 * kept in the tab and put back into its box once the step is done, an open box's 올리기·저장
 * sending nothing; and a 답글 or an edit refused because its comment was deleted meanwhile, or a new
 * 댓글 because the post was, leaves its text and why where the box stood until it is closed — the
 * focus there only from a box that held it, the reason an alert otherwise, and through a re-consent
 * step too — while every other box stays open (owner decisions 2026-10-20). A box with text and no
 * write that a read takes away keeps its text with why its place takes it no more — for an account
 * facing a re-consent too, and the focus in the box's own 취소 dialog going to it; 취소 on a 답글
 * or an edit with text asks first, in the app's own dialog, a restored box too; a failed later read
 * of `GET /me` leaves the new 댓글's box as it is; and a post gone from every view while a refused
 * text is on screen keeps its page — '없거나 삭제된 글입니다.' and the texts, through a later read
 * failing — until the last is closed, then its 404 (owner decisions 2026-10-21). The depth rule,
 * the placeholders' rules, the counts, the permissions and the link safety are the API's and the
 * shared package's tests; this walks the screens.
 */

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights, while `on`; agreeing on the step turns it off (posts.spec.ts draws it the same
 * way — no spec can bring about a re-consent for real).
 */
async function asReconsent(page: Page): Promise<{ on: boolean }> {
  const state = { on: false };
  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() !== 'GET' || !state.on) return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { data: Me };
    const { onboarding } = body.data;
    body.data.onboarding = {
      ...onboarding,
      consent: false,
      completed: false,
      nextStep: 'consent',
      consents: onboarding.consents.map((answer) =>
        answer.item === 'terms' ? { ...answer, version: 'draft-1999-01-01' } : answer,
      ),
    };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/me/consents', async (route) => {
    const response = await route.fetch();
    state.on = false;
    await route.fulfill({ response });
  });
  return state;
}

/** The consent step of a re-consent, agreed on screen. */
async function agreeAgain(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
    copy.onboardingReconsentReason,
  );
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
}

/** A write refused as the server refuses an account with a step left. */
const ONBOARDING_REFUSAL = {
  status: 409,
  json: {
    error: {
      code: 'ONBOARDING_REQUIRED',
      message: 'The onboarding is not done',
      details: { steps: ['consent'] },
    },
  },
};

/** A write refused for a frequency limit (#187's, as the server will answer it). */
const RATE_LIMIT_REFUSAL = {
  status: 429,
  json: { error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } },
};

/** The comment drafts kept in this tab's sessionStorage (lib/comment-drafts.ts), by key: text. */
function commentDraftsInTab(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('buddha.commentDraft:'))
        .map((key) => [
          key,
          (JSON.parse(sessionStorage.getItem(key) ?? '{}') as { text: string }).text,
        ]),
    ),
  );
}

/** Records each dialog the page opens and answers it with the next of `answers` (no: dismissed). */
function dialogs(page: Page): { asked: string[]; answers: boolean[] } {
  const asked: string[] = [];
  const answers: boolean[] = [];
  page.on('dialog', (dialog) => {
    asked.push(`${dialog.type()}: ${dialog.message()}`);
    void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
  });
  return { asked, answers };
}

/** A post straight at the API with the context's cookie: this spec's subject is its comments. */
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

/** A comment straight at the API with the context's cookie: a 댓글, or a 대댓글 under `parentId`. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  parentId: string | null,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The comment `id` as the thread draws it. */
const commentOf = (page: Page, id: string) => page.getByTestId(`comment-${id}`);

/** The id of the comment `article` drawn (its test id is `comment-<id>`). */
async function idOf(article: Locator): Promise<string> {
  const testId = await article.getAttribute('data-testid');
  const match = /^comment-([0-9a-f-]{36})$/.exec(testId ?? '');
  if (match?.[1] === undefined) throw new Error(`not a comment: ${String(testId)}`);
  return match[1];
}

test.describe('댓글·대댓글', () => {
  test('회원이 댓글을 달고 답글에 답해도 같은 댓글 아래로 가며, 고치면 수정됨, 지운 댓글과 지운 글은 자리표시로 남아 댓글이 읽힌다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const postId = await postThroughApi(page.request, market.id, `댓글 받을 글 ${tag}`, tag);
    // An admin's 댓글, the oldest: '운영자' on it (#45-9).
    const adminCommentId = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);

    await page.goto(`/community/posts/${postId}`);
    const heading = page.getByTestId('comments-heading');
    await expect(heading).toHaveText(`${copy.commentsHeading} 1`);
    const adminComment = commentOf(page, adminCommentId);
    await expect(adminComment.getByTestId('comment-body')).toHaveText(`운영자의 댓글 ${tag}`);
    await expect(adminComment.getByTestId('post-author-admin')).toHaveText(copy.postAuthorAdmin);
    // Another account's comment: 답글, never 수정 or 삭제.
    await expect(adminComment.getByTestId('comment-reply')).toBeVisible();
    await expect(adminComment.getByTestId('comment-edit')).toHaveCount(0);
    await expect(adminComment.getByTestId('comment-delete')).toHaveCount(0);

    // --- a 댓글: plain text, an http(s) address as a link, a `javascript:` one as text, the line
    // break kept (#45-3). Nothing asks for a probability, a position or an order (N05 §2).
    const composer = page.getByTestId('comment-composer');
    const input = composer.getByTestId('comment-input');
    const submit = composer.getByTestId('comment-submit');
    await expect(composer.locator('input')).toHaveCount(0);
    await expect(submit).toBeDisabled();
    // Past the limit, counted as the server counts, the send stays off and the box says why.
    await input.fill('가'.repeat(1_001));
    await expect(composer.getByTestId('comment-length')).toHaveText('1,001 / 1,000자');
    await expect(composer.getByTestId('comment-limit')).toHaveText(copy.errCommentBodyTooLong);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(submit).toBeDisabled();
    const text = `근거 ${tag}\n출처 https://example.com/news?id=1 참고. javascript:alert(1)`;
    await input.fill(text);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(input).toHaveValue('');
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);
    const mine = page.locator('article[data-testid^="comment-"]', { hasText: `근거 ${tag}` });
    const mineId = await idOf(mine);
    const body = mine.getByTestId('comment-body');
    const link = body.getByRole('link', { name: 'https://example.com/news?id=1' });
    await expect(link).toHaveAttribute('href', 'https://example.com/news?id=1');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(body.locator('a')).toHaveCount(1);
    await expect(body).toContainText('참고. javascript:alert(1)');
    expect(await body.evaluate((element) => (element as HTMLElement).innerText)).toContain(
      `근거 ${tag}\n출처`,
    );
    await expect(mine.getByTestId('post-author-name')).toHaveText(me.profile.nickname);
    await expect(mine.getByTestId('post-author-admin')).toHaveCount(0);

    // --- 대댓글 (#45-2): 답글 opens the thread's box; an answer to a 대댓글 is another 대댓글 of the
    // same 댓글, after it — never a third layer.
    const thread = page.getByTestId(`comment-thread-${mineId}`);
    const replies = thread.getByTestId('comment-replies').locator('article');
    const replyBox = thread.getByTestId('reply-composer');
    // Closing the box puts the focus back on the 답글 that opened it (WCAG 2.4.3).
    await mine.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-cancel').click();
    await expect(replyBox).toHaveCount(0);
    await expect(mine.getByTestId('comment-reply')).toBeFocused();
    await mine.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill(`첫 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(replies).toHaveCount(1);
    await expect(mine.getByTestId('comment-reply')).toBeFocused();
    await replies.first().getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill(`답글의 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replies).toHaveCount(2);
    await expect(replies.first().getByTestId('comment-reply')).toBeFocused();
    await expect(replies.nth(1).getByTestId('comment-body')).toHaveText(`답글의 답글 ${tag}`);
    await expect(thread.getByTestId('comment-replies').getByTestId('comment-replies')).toHaveCount(
      0,
    );
    await expect(heading).toHaveText(`${copy.commentsHeading} 4`);

    // As the server orders them (#45-2: 작성 순, oldest first), read again.
    await page.reload();
    const threads = page.getByTestId('comments-list').locator(':scope > li');
    await expect(threads).toHaveCount(2);
    await expect(threads.nth(0)).toHaveAttribute('data-testid', `comment-thread-${adminCommentId}`);
    await expect(threads.nth(1)).toHaveAttribute('data-testid', `comment-thread-${mineId}`);
    await expect(replies.nth(0).getByTestId('comment-body')).toHaveText(`첫 답글 ${tag}`);
    await expect(replies.nth(1).getByTestId('comment-body')).toHaveText(`답글의 답글 ${tag}`);
    const secondReplyId = await idOf(replies.nth(1));

    // --- edit in place (#45-4): the text only, '수정됨'.
    const own = commentOf(page, mineId);
    await expect(own.getByTestId('post-edited')).toHaveCount(0);
    await own.getByTestId('comment-edit').click();
    const editBox = own.getByTestId('comment-edit-form').getByTestId('comment-input');
    await expect(editBox).toBeFocused();
    await expect(editBox).toHaveValue(text);
    await editBox.fill(`고친 근거 ${tag}`);
    await own.getByTestId('comment-submit').click();
    await expect(own.getByTestId('comment-body')).toHaveText(`고친 근거 ${tag}`);
    await expect(own.getByTestId('post-edited')).toHaveText(copy.postEdited);
    await expect(own.getByTestId('comment-edit')).toBeFocused();

    // --- the count on the post's card (#45-7).
    await page.goto(`/community?q=${tag}`);
    await expect(
      page.getByTestId(`post-card-${postId}`).getByTestId('post-card-comments'),
    ).toHaveText(`${copy.commentsHeading} 4`);

    // --- delete the 댓글 its 대댓글 hang under (#45-5): '삭제된 글입니다', its author hidden, its
    // 대댓글 kept, and no new 대댓글 under it.
    await page.goto(`/community/posts/${postId}`);
    await own.getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    // Said, though the comment it was asked from is a placeholder by the time the answer lands.
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId('comment-delete-dialog')).toHaveCount(0);
    await expect(own).toHaveAttribute('data-state', 'deleted');
    await expect(own.getByTestId('comment-placeholder')).toHaveText(copy.commentDeletedPlaceholder);
    await expect(own).not.toContainText(me.profile.nickname);
    await expect(replies).toHaveCount(2);
    await expect(thread.getByTestId('comment-reply')).toHaveCount(0);
    await expect(heading).toHaveText(`${copy.commentsHeading} 3`);
    await page.reload();
    await expect(own.getByTestId('comment-placeholder')).toHaveText(copy.commentDeletedPlaceholder);
    await expect(replies).toHaveCount(2);

    // A 대댓글 with nothing under it leaves the thread.
    await commentOf(page, secondReplyId).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(commentOf(page, secondReplyId)).toHaveCount(0);
    await expect(replies).toHaveCount(1);
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);

    // --- delete the post: comments hang under it, so its address stays as '삭제된 글입니다' and
    // every comment is still read there (N04 §6); it takes no new comment.
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    const kept = await page.goto(`/community/posts/${postId}`);
    expect(kept?.status()).toBe(200);
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(adminComment.getByTestId('comment-body')).toHaveText(`운영자의 댓글 ${tag}`);
    await expect(replies.first().getByTestId('comment-body')).toHaveText(`첫 답글 ${tag}`);
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(page.getByTestId('comment-composer')).toHaveCount(0);
    await expect(page.getByTestId('comment-reply')).toHaveCount(0);
  });

  test('로그인하지 않은 방문자는 댓글과 대댓글을 읽고(서버가 그린 HTML에도 있다), 쓰기 대신 이 글로 돌아오는 로그인 안내를 받는다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `방문자가 읽는 글 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `읽는 댓글 ${tag}`);
    const reply = await commentThroughApi(admin, postId, top, `읽는 답글 ${tag}`);
    // An address with no place to break, still a link (under 2,048 characters).
    const longAddress = `https://example.com/${'a'.repeat(400)}`;
    const long = await commentThroughApi(admin, postId, null, `긴 주소 ${longAddress}`);

    // The first page is the server's: the HTML holds the comments before any script runs.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(`읽는 댓글 ${tag}`);
    expect(html).toContain(`읽는 답글 ${tag}`);

    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('comments-heading')).toHaveText(`${copy.commentsHeading} 3`);
    await expect(commentOf(page, top).getByTestId('comment-body')).toHaveText(`읽는 댓글 ${tag}`);
    // The long address wraps (`overflow-wrap: anywhere`): it stays inside the comment's own box
    // (a phone zooms out to fit what runs off, so the box is measured, not only the page).
    const longBody = commentOf(page, long).getByTestId('comment-body');
    await expect(longBody.getByRole('link', { name: longAddress })).toHaveAttribute(
      'href',
      longAddress,
    );
    expect(await longBody.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(
      page.getByTestId(`comment-thread-${top}`).getByTestId(`comment-${reply}`),
    ).toContainText(`읽는 답글 ${tag}`);
    await expect(page.getByTestId('comment-signed-out')).toContainText(copy.commentSignedOut);
    await expect(page.getByTestId('comment-login')).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/community/posts/${postId}`)}`,
    );
    await expect(page.getByTestId('comment-composer')).toHaveCount(0);
    await expect(page.getByTestId('comment-reply')).toHaveCount(0);
    await expect(page.getByTestId('comment-edit')).toHaveCount(0);
    await expect(page.getByTestId('comment-delete')).toHaveCount(0);
  });

  test('지운 글 아래의 마지막 댓글을 지우면 열려 있던 글 화면은 그 글의 404가 된다', async ({
    admin,
    page,
  }) => {
    // The post stays as '삭제된 글입니다' only while a comment hangs under it (#45-5): once the
    // last one is deleted it is gone, and the open page says so rather than keeping the
    // placeholder with a count and a list that no longer agree.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const postId = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, tag);
    const last = await commentThroughApi(page.request, postId, null, `마지막 댓글 ${tag}`);
    const deletion = await page.request.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deletion.status(), await deletion.text()).toBe(200);

    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-heading')).toHaveText(`${copy.commentsHeading} 1`);
    await commentOf(page, last).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId('post-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    // As a reload says it.
    const gone = await page.reload();
    expect(gone?.status()).toBe(404);
  });
  test('쓰던 댓글·답글·수정을 두고 머리의 링크로 떠나거나 답글·수정 상자를 취소하면 먼저 묻고, 머무르면 글자가 그대로이며, 빈 상자는 묻지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `떠나기 전 글 ${tag}`, tag);
    const own = await commentThroughApi(page.request, postId, null, `내 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const question = `confirm: ${copy.postLeaveConfirm}`;
    // The wordmark in the header, a Next.js link on every screen and both widths.
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');

    // --- the new 댓글's box (오너 결정 2026-10-20 답 1): refused, still here with the text.
    const newInput = page.getByTestId('comment-composer').getByTestId('comment-input');
    await newInput.fill(`쓰던 댓글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(postPage);
    await expect(newInput).toHaveValue(`쓰던 댓글 ${tag}`);
    await newInput.fill('   ');

    // --- a 답글's box.
    const ownComment = commentOf(page, own);
    await ownComment.getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${own}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`쓰던 답글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question]);
    await expect(page).toHaveURL(postPage);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    // 취소 with the text asks first, in the app's own dialog (오너 결정 2026-10-21 답 3) — opening
    // on its 취소, so nothing is lost on Enter. Dismissed (취소, Escape, a click outside), the box is
    // as it was and the focus back on its 취소.
    const cancel = replyBox.getByTestId('comment-cancel');
    const discardDialog = page.getByTestId('comment-discard-dialog');
    await cancel.click();
    await expect(discardDialog).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(
      copy.commentDiscardQuestion,
    );
    await expect(page.getByTestId('comment-discard-cancel')).toBeFocused();
    await page.getByTestId('comment-discard-cancel').click();
    await expect(discardDialog).toHaveCount(0);
    await expect(cancel).toBeFocused();
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    for (const dismiss of [
      () => page.keyboard.press('Escape'),
      () => page.mouse.click(4, 4),
    ] as const) {
      await cancel.click();
      await expect(discardDialog).toBeVisible();
      await dismiss();
      await expect(discardDialog).toHaveCount(0);
      await expect(cancel).toBeFocused();
      await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    }
    // 버리기: the box closes holding nothing, the focus back on the 답글 that opened it.
    await cancel.click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(discardDialog).toHaveCount(0);
    await expect(replyBox).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-reply')).toBeFocused();
    await expect(page.getByTestId('comment-held')).toHaveCount(0);

    // --- an edit: asks once the text differs from the comment.
    await ownComment.getByTestId('comment-edit').click();
    const editInput = ownComment.getByTestId('comment-edit-form').getByTestId('comment-input');
    await editInput.fill(`고치던 댓글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question, question]);
    await expect(editInput).toHaveValue(`고치던 댓글 ${tag}`);

    // --- answered yes: gone to the home screen.
    answers.push(true);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([question, question, question, question]);

    // --- boxes holding nothing to lose ask nothing: a 답글 empty or blank, an edit as the comment
    // stands (an unexpected dialog would be dismissed and keep us) — on leaving, nor on 취소.
    await page.goto(postPage);
    await ownComment.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill('   ');
    await replyBox.getByTestId('comment-cancel').click();
    await expect(replyBox).toHaveCount(0);
    await expect(discardDialog).toHaveCount(0);
    await ownComment.getByTestId('comment-reply').click();
    await replyBox.getByTestId('comment-input').fill('  \n ');
    await home.click();
    await expect(page).toHaveURL('/');
    await page.goto(postPage);
    await ownComment.getByTestId('comment-edit').click();
    await expect(editInput).toHaveValue(`내 댓글 ${tag}`);
    const editForm = ownComment.getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-cancel').click();
    await expect(editForm).toHaveCount(0);
    await expect(discardDialog).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-edit')).toBeFocused();
    // An edit changed asks on 취소 too; 버리기 leaves the comment as it stands, the focus on 수정.
    await ownComment.getByTestId('comment-edit').click();
    await editInput.fill(`버릴 수정 ${tag}`);
    await editForm.getByTestId('comment-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await page.getByTestId('comment-discard-confirm').click();
    await expect(editForm).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-body')).toHaveText(`내 댓글 ${tag}`);
    await expect(ownComment.getByTestId('comment-edit')).toBeFocused();
    await ownComment.getByTestId('comment-edit').click();
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(4);
  });

  test('재동의가 남은 계정은 글 화면에서 자기 댓글을 지우고, 답글·수정·올리기는 남은 단계로 가며, 쓰던 댓글·답글·수정은 단계를 마치고 돌아오면 그 상자에 되살아난다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `재동의 글 ${tag}`, tag);
    const adminMe = await meOf(admin);
    const theirs = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    // Deleted by its author while the reader is on the step: the 답글 to it has no box to go back to.
    const doomed = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const editable = await commentThroughApi(page.request, postId, null, `고칠 댓글 ${tag}`);
    const deletable = await commentThroughApi(page.request, postId, null, `지울 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;
    const reconsent = await asReconsent(page);
    const { asked } = dialogs(page);

    // --- boxes with text: a new 댓글, two 답글 and an edit.
    await page.goto(postPage);
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`새 댓글 ${tag}\n둘째 줄`);
    await commentOf(page, doomed).getByTestId('comment-reply').click();
    await page
      .getByTestId(`comment-thread-${doomed}`)
      .getByTestId('reply-composer')
      .getByTestId('comment-input')
      .fill(`갈 곳 없는 답글 ${tag}`);
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`답글 ${tag}`);
    await commentOf(page, editable).getByTestId('comment-edit').click();
    const editForm = commentOf(page, editable).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고친 댓글 ${tag}`);
    // And a 답글 under the writer's own 댓글, which it deletes below with the step known.
    await commentOf(page, deletable).getByTestId('comment-reply').click();
    await page
      .getByTestId(`comment-thread-${deletable}`)
      .getByTestId('reply-composer')
      .getByTestId('comment-input')
      .fill(`지울 댓글에 쓰던 답글 ${tag}`);

    // --- the 댓글 refused for the onboarding: a revision asked for the consent again meanwhile.
    // The page is the gate's exception for a re-consent, so it stays — every box with its text.
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await expect(page).toHaveURL(postPage);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);

    // --- deleting one's own comment needs a session alone (오너 결정 2026-10-19·20).
    await commentOf(page, deletable).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(commentOf(page, deletable)).toHaveCount(0);
    await expect(page).toHaveURL(postPage);
    // The 답글 open under it went with it, in place — the page staying (7-23): with the step left,
    // its text is shown with why its place takes it no more, as anyone's (오너 결정 2026-10-21 답 2),
    // not put away in the tab; why is read out as an alert (the focus was in 삭제's dialog).
    const held = page.getByTestId('comment-held');
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`지울 댓글에 쓰던 답글 ${tag}`);
    expect(await commentDraftsInTab(page)).toEqual({});
    // Closed, it is gone for good: not back after the step.
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);

    // --- 올리기 now goes to the step (오너 결정 2026-10-20 답 3), asking nothing: every box's text
    // is kept in this tab on the way (답 2).
    await composer.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    expect(asked).toEqual([]);
    const prefix = `buddha.commentDraft:${postId}`;
    expect(await commentDraftsInTab(page)).toEqual({
      [`${prefix}:comment`]: `새 댓글 ${tag}\n둘째 줄`,
      [`${prefix}:reply:${doomed}`]: `갈 곳 없는 답글 ${tag}`,
      [`${prefix}:reply:${theirs}`]: `답글 ${tag}`,
      [`${prefix}:edit:${editable}`]: `고친 댓글 ${tag}`,
    });
    const doomedGone = await admin.post(`/api/v1/comments/${doomed}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(doomedGone.status(), await doomedGone.text()).toBe(200);

    // --- the step done: back on the post, each box open with its text, and said so.
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(composer.getByTestId('comment-input')).toHaveValue(`새 댓글 ${tag}\n둘째 줄`);
    await expect(composer.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(replyBox.getByTestId('comment-draft-restored')).toBeVisible();
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);
    await expect(editForm.getByTestId('comment-draft-restored')).toBeVisible();
    // Said once in a toast too — the toaster's region (a polite live region) reads it out.
    const toasts = page.locator('body > [data-scope="toast"][data-part="group"]');
    await expect(toasts).toHaveAttribute('aria-live', 'polite');
    await expect(
      toasts.getByRole('status').filter({ hasText: copy.commentDraftRestored }),
    ).toHaveCount(1);
    // Taken back, they are the boxes' again — gone from the tab.
    expect(await commentDraftsInTab(page)).toEqual({});
    // The 답글 whose 댓글 went meanwhile is shown apart with why — read out as an alert, the focus
    // left where it was and the page where it was: no box on this page held it (ADR-0074 7-25).
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`갈 곳 없는 답글 ${tag}`);
    await expect(held).not.toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);

    // --- 취소 on a restored box asks first too (오너 결정 2026-10-21 답 3); kept, it is sent below.
    await replyBox.getByTestId('comment-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await page.getByTestId('comment-discard-cancel').click();
    await expect(page.getByTestId('comment-discard-dialog')).toHaveCount(0);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(replyBox.getByTestId('comment-cancel')).toBeFocused();

    // --- sent: each where it was written.
    await page.unroute(`**/api/v1/posts/${postId}/comments`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(
      page.getByTestId(`comment-thread-${theirs}`).getByTestId('comment-replies'),
    ).toContainText(`답글 ${tag}`);
    // No 답글 opened the restored box: the focus goes to the 댓글's own (WCAG 2.4.3).
    await expect(commentOf(page, theirs).getByTestId('comment-reply')).toBeFocused();
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, editable).getByTestId('comment-body')).toHaveText(
      `고친 댓글 ${tag}`,
    );
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-input')).toHaveValue('');
    await expect(composer.getByTestId('comment-draft-restored')).toHaveCount(0);
    await expect(
      page.locator('article[data-testid^="comment-"]', { hasText: `새 댓글 ${tag}` }),
    ).toHaveCount(1);
    expect(asked).toEqual([]);

    // --- with the consent asked for again, 답글 and 수정 go to the step too, and come back here.
    reconsent.on = true;
    await page.reload();
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    await expect(page).toHaveURL(viaStep);
    await page.goto(postPage);
    await commentOf(page, editable).getByTestId('comment-edit').click();
    await expect(page).toHaveURL(viaStep);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(page.getByTestId('comment-edit-form')).toHaveCount(0);
    expect(asked).toEqual([]);

    // --- boxes opened before the step was known: their 저장 and 올리기 go to it too, sending
    // nothing and keeping the text (답 2·3).
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') writes.push(`PUT ${new URL(request.url()).pathname}`);
      if (request.method() === 'POST' && request.url().endsWith(`/posts/${postId}/comments`)) {
        const parentId = (request.postDataJSON() as { parentId?: string | null }).parentId;
        if (parentId) writes.push(`POST reply ${parentId}`);
      }
    });
    await commentOf(page, editable).getByTestId('comment-edit').click();
    await editForm.getByTestId('comment-input').fill(`다시 고친 댓글 ${tag}`);
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    await replyBox.getByTestId('comment-input').fill(`다시 쓴 답글 ${tag}`);
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    // The page learns of the step from a refused 댓글, as above.
    await composer.getByTestId('comment-input').fill(`또 쓴 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await editForm.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect
      .poll(() => commentDraftsInTab(page))
      .toEqual({
        [`${prefix}:comment`]: `또 쓴 댓글 ${tag}`,
        [`${prefix}:reply:${theirs}`]: `다시 쓴 답글 ${tag}`,
        [`${prefix}:edit:${editable}`]: `다시 고친 댓글 ${tag}`,
      });
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`다시 고친 댓글 ${tag}`);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`다시 쓴 답글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await replyBox.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect
      .poll(() => commentDraftsInTab(page))
      .toMatchObject({
        [`${prefix}:reply:${theirs}`]: `다시 쓴 답글 ${tag}`,
      });
    expect(writes).toEqual([]);
    expect(asked).toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('쓰는 사이 그 댓글이 지워져 답글과 수정이 거절되면 상자가 사라져도 거절의 까닭과 쓰던 글자가 닫을 때까지 남는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(page.request, market.id, `거절될 글 ${tag}`, tag);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const mine = await commentThroughApi(page.request, postId, null, `곧 지울 내 댓글 ${tag}`);
    const other = await commentThroughApi(admin, postId, null, `또 지워질 댓글 ${tag}`);
    const kept = await commentThroughApi(admin, postId, null, `남는 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');

    // --- a 답글 to a 댓글 its author deletes meanwhile: with nothing under it, it leaves the view,
    // and the thread read again holds neither it nor the box (오너 결정 2026-10-20 답 4).
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`보내지 못한 답글 ${tag}\n둘째 줄`);
    const gone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(gone.status(), await gone.text()).toBe(200);
    await replyBox.getByTestId('comment-submit').click();
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 답글 ${tag}\n둘째 줄`,
    );
    // The focus the box held comes here, named by why (and so not an alert besides).
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errCommentParentGone);
    await expect(held.getByRole('alert')).toHaveCount(0);

    // --- an edit of a comment deleted meanwhile (another tab of the same account).
    await commentOf(page, mine).getByTestId('comment-edit').click();
    const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`보내지 못한 수정 ${tag}`);
    const deleted = await page.request.post(`/api/v1/comments/${mine}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine)).toHaveCount(0);
    await expect(held).toHaveCount(2);
    await expect(held.nth(1).getByTestId('comment-held-reason')).toHaveText(copy.errCommentGone);
    await expect(held.nth(1).getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 수정 ${tag}`,
    );

    // --- a 답글 whose box goes while the reader is in another box: the text stays, the focus
    // where the reader put it, and why is read out as an alert.
    await commentOf(page, other).getByTestId('comment-reply').click();
    const otherBox = page.getByTestId(`comment-thread-${other}`).getByTestId('reply-composer');
    await otherBox.getByTestId('comment-input').fill(`딴 상자에 있던 답글 ${tag}`);
    const otherGone = await admin.post(`/api/v1/comments/${other}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(otherGone.status(), await otherGone.text()).toBe(200);
    let release = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await sending;
      await route.continue();
    });
    await otherBox.getByTestId('comment-submit').click();
    await expect(otherBox.getByTestId('comment-input')).toBeDisabled();
    const newInput = page.getByTestId('comment-composer').getByTestId('comment-input');
    await newInput.focus();
    release();
    await expect(held).toHaveCount(3);
    await expect(held.nth(2).getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.nth(2).getByTestId('comment-held-text')).toHaveValue(
      `딴 상자에 있던 답글 ${tag}`,
    );
    await expect(newInput).toBeFocused();
    await page.unroute(`**/api/v1/posts/${postId}/comments`);

    // --- a refusal that leaves the box where it is (a limit): 취소 — asked first, its text changed
    // (오너 결정 2026-10-21 답 3) — and 버리기 close it holding nothing.
    await page.route(`**/api/v1/posts/${postId}/comments`, (route) =>
      route.request().method() === 'POST' ? route.fulfill(RATE_LIMIT_REFUSAL) : route.fallback(),
    );
    await commentOf(page, kept).getByTestId('comment-reply').click();
    const keptBox = page.getByTestId(`comment-thread-${kept}`).getByTestId('reply-composer');
    await keptBox.getByTestId('comment-input').fill(`한도에 걸린 답글 ${tag}`);
    await keptBox.getByTestId('comment-submit').click();
    await expect(keptBox.getByTestId('comment-error')).toBeVisible();
    await keptBox.getByTestId('comment-cancel').click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(keptBox).toHaveCount(0);
    await expect(held).toHaveCount(3);
    await page.unroute(`**/api/v1/posts/${postId}/comments`);

    // --- a re-consent asked for meanwhile, learnt from a refused 댓글: 답글 goes to the step, asking
    // nothing, and the texts shown apart go with the boxes' texts into the tab, each as the draft
    // of the box it stood for (답 2·4) — and are shown apart again, with why, once the step is done.
    const reconsent = await asReconsent(page);
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await newInput.fill(`단계 앞의 댓글 ${tag}`);
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await commentOf(page, kept).getByTestId('comment-reply').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(postPage)}`);
    const prefix = `buddha.commentDraft:${postId}`;
    await expect
      .poll(() => commentDraftsInTab(page))
      .toEqual({
        [`${prefix}:comment`]: `단계 앞의 댓글 ${tag}`,
        [`${prefix}:reply:${theirs}`]: `보내지 못한 답글 ${tag}\n둘째 줄`,
        [`${prefix}:edit:${mine}`]: `보내지 못한 수정 ${tag}`,
        [`${prefix}:reply:${other}`]: `딴 상자에 있던 답글 ${tag}`,
      });
    await page.unroute(`**/api/v1/posts/${postId}/comments`);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(newInput).toHaveValue(`단계 앞의 댓글 ${tag}`);
    await expect(held).toHaveCount(3);
    // Their boxes cannot open: each is apart with why, read out as an alert (no box here held it).
    await expect(held.getByRole('alert')).toHaveCount(3);
    const shown = await held.evaluateAll((texts) =>
      texts.map((text) => [
        text.querySelector('[data-testid="comment-held-reason"]')?.textContent,
        text.querySelector('textarea')?.value,
      ]),
    );
    expect(shown.map((pair) => pair.join(' | ')).sort()).toEqual(
      [
        `${copy.errCommentParentGone} | 보내지 못한 답글 ${tag}\n둘째 줄`,
        `${copy.errCommentGone} | 보내지 못한 수정 ${tag}`,
        `${copy.errCommentParentGone} | 딴 상자에 있던 답글 ${tag}`,
      ].sort(),
    );
    expect(await commentDraftsInTab(page)).toEqual({});
    expect(asked).toEqual([]);
    await newInput.fill('');

    // --- leaving while they are shown asks first; staying keeps them.
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(3);

    // --- closed, they are gone — the focus on the comments' heading — and leaving asks nothing.
    await held.nth(0).getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(2);
    await expect(page.getByTestId('comments-heading')).toBeFocused();
    await held.nth(0).getByTestId('comment-held-close').click();
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(1);
  });

  test('쓰는 사이 글이 지워져 새 댓글이 거절되면 목록 아래에 까닭과 글자가 남고, 열어 둔 수정 상자는 그대로 저장된다', async ({
    admin,
    page,
  }) => {
    // The post turns into its placeholder under the open page — read again after the refusal —
    // and the comment section stays the same one: the refused 댓글's text is kept (오너 결정
    // 2026-10-20 답 4) and the edit open beside it too, an author editing under a deleted post (7-6).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `곧 지워질 글 ${tag}`, tag);
    const mine = await commentThroughApi(page.request, postId, null, `내 댓글 ${tag}`);
    await page.goto(`/community/posts/${postId}`);
    const section = await page.getByTestId('post-comments').elementHandle();
    const held = page.getByTestId('comment-held');

    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`보내지 못한 댓글 ${tag}\n둘째 줄`);
    await commentOf(page, mine).getByTestId('comment-edit').click();
    const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고친 댓글 ${tag}`);

    // Its author deletes the post meanwhile: a comment hangs under it, so it is '삭제된 글입니다'.
    const deletion = await admin.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(deletion.status(), await deletion.text()).toBe(200);
    await composer.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.commentClosedPostDeleted);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 댓글 ${tag}\n둘째 줄`,
    );
    await expect(held).toBeFocused();
    // Not drawn afresh: the section the page had.
    expect(await section?.evaluate((element) => element.isConnected)).toBe(true);

    // The open edit, still open with its text, saves.
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(`고친 댓글 ${tag}`);
    await expect(commentOf(page, mine).getByTestId('post-edited')).toHaveText(copy.postEdited);

    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
  });

  test('보내지 않은 상자가 다시 읽기로 사라지면 그 자리가 받지 않는 까닭과 쓰던 글자가 닫을 때까지 남는다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 답 2: a box with text and no write, gone because its place changed under
    // it — the writer's own 댓글 deleted under an open 답글, another's 댓글 and the writer's own
    // comment deleted elsewhere and the thread read again after a new 댓글, the post deleted and
    // read again after a deletion — keeps its text with why, as a refused write's does (2026-10-20
    // 답 4).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `다시 읽힐 글 ${tag}`, tag);
    const mine = await commentThroughApi(page.request, postId, null, `곧 지울 내 댓글 ${tag}`);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const edited = await commentThroughApi(
      page.request,
      postId,
      null,
      `딴 탭에서 지울 댓글 ${tag}`,
    );
    const spare = await commentThroughApi(page.request, postId, null, `나중에 지울 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');
    const shownHeld = async () =>
      (
        await held.evaluateAll((texts) =>
          texts.map((text) =>
            [
              text.querySelector('[data-testid="comment-held-reason"]')?.textContent,
              text.querySelector('textarea')?.value,
            ].join(' | '),
          ),
        )
      ).sort();

    // --- a 답글 under the writer's own 댓글, which the writer deletes: with nothing under it, the
    // 댓글 leaves the view and the box with it. The focus was in the dialog, not the box: why is
    // read out as an alert.
    await commentOf(page, mine).getByTestId('comment-reply').click();
    const mineBox = page.getByTestId(`comment-thread-${mine}`).getByTestId('reply-composer');
    await mineBox.getByTestId('comment-input').fill(`내 댓글에 쓰던 답글 ${tag}\n둘째 줄`);
    await commentOf(page, mine).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId(`comment-thread-${mine}`)).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `내 댓글에 쓰던 답글 ${tag}\n둘째 줄`,
    );
    await expect(held).not.toBeFocused();

    // --- a 답글 to another's 댓글 and an edit of the writer's own, each deleted elsewhere: the
    // thread read again after a new 댓글 (its page read on to the end, ADR-0074 7-14) holds
    // neither.
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const theirBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await theirBox.getByTestId('comment-input').fill(`남의 댓글에 쓰던 답글 ${tag}`);
    await commentOf(page, edited).getByTestId('comment-edit').click();
    const editForm = commentOf(page, edited).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고치던 댓글 ${tag}`);
    const theirsGone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(theirsGone.status(), await theirsGone.text()).toBe(200);
    const editedGone = await page.request.post(`/api/v1/comments/${edited}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(editedGone.status(), await editedGone.text()).toBe(200);
    const composer = page.getByTestId('comment-composer');
    const newInput = composer.getByTestId('comment-input');
    await newInput.fill(`새 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(newInput).toHaveValue('');
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(commentOf(page, edited)).toHaveCount(0);
    await expect(held).toHaveCount(3);
    expect(await shownHeld()).toEqual(
      [
        `${copy.errCommentParentGone} | 내 댓글에 쓰던 답글 ${tag}\n둘째 줄`,
        `${copy.errCommentParentGone} | 남의 댓글에 쓰던 답글 ${tag}`,
        `${copy.errCommentGone} | 고치던 댓글 ${tag}`,
      ].sort(),
    );
    // None of those boxes held the focus as it went: each reason is an alert.
    await expect(held.getByRole('alert')).toHaveCount(3);

    // --- the new 댓글's box, the post deleted meanwhile (comments hang under it: '삭제된 글입니다')
    // and read again after the writer deletes a comment.
    await newInput.fill(`닫힌 글에 쓰던 댓글 ${tag}`);
    const postGone = await admin.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(postGone.status(), await postGone.text()).toBe(200);
    await commentOf(page, spare).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(4);
    expect(await shownHeld()).toContain(
      `${copy.commentClosedPostDeleted} | 닫힌 글에 쓰던 댓글 ${tag}`,
    );

    // --- leaving while they are shown asks first; closed, they are gone and leaving asks nothing.
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(4);
    for (const left of [3, 2, 1, 0]) {
      await held.first().getByTestId('comment-held-close').click();
      await expect(held).toHaveCount(left);
    }
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(1);
  });

  test('다시 읽기가 상자를 거두거나 실패해도 쓰던 글자는 남는다: 취소의 확인 창이 열린 채 거둔 상자는 초점을 남긴 글자로 넘기고, 내 정보를 다시 읽지 못해도 새 댓글 상자는 그대로다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `다시 읽기의 글 ${tag}`, tag);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    await page.goto(`/community/posts/${postId}`);
    const held = page.getByTestId('comment-held');
    const composer = page.getByTestId('comment-composer');
    const newInput = composer.getByTestId('comment-input');
    const comments = `**/api/v1/posts/${postId}/comments`;

    // --- a 답글 whose 취소 is asking (its dialog, in a portal, has the focus) when a read takes the
    // box away — the 댓글 deleted elsewhere, its thread read again after a new 댓글 lands (7-14):
    // the dialog goes with the box, and the focus the box held — in its own dialog — goes to the
    // text it left, named by why (ADR-0074 7-25), not to the page's start.
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`창이 열린 채 거둔 답글 ${tag}`);
    let release = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(comments, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await sending;
      await route.continue();
    });
    await newInput.fill(`새 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(newInput).toBeDisabled();
    await replyBox.getByTestId('comment-cancel').click();
    await expect(page.getByTestId('comment-discard-cancel')).toBeFocused();
    const gone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(gone.status(), await gone.text()).toBe(200);
    release();
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(page.getByTestId('comment-discard-dialog')).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `창이 열린 채 거둔 답글 ${tag}`,
    );
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errCommentParentGone);
    await expect(held.getByRole('alert')).toHaveCount(0);
    await page.unroute(comments);
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toBeFocused();

    // --- `GET /me` read again and failing (after its retries) while the account it named is
    // still held: the new 댓글's box stays with its text, as the 답글 and 수정 boxes do — it does
    // not turn into '내 정보를 불러오지 못했습니다.' and come back empty (2026-10-21 답 2). A refusal
    // for the onboarding is what reads it again here.
    let meReads = 0;
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      meReads += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.route(comments, (route) =>
      route.request().method() === 'POST' ? route.fulfill(ONBOARDING_REFUSAL) : route.fallback(),
    );
    await newInput.fill(`내 정보를 다시 읽지 못한 댓글 ${tag}\n둘째 줄`);
    await composer.getByTestId('comment-submit').click();
    await expect.poll(() => meReads).toBeGreaterThanOrEqual(3);
    // The refusal is said once its side effects — the read of `GET /me` — are done.
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await expect(page.getByTestId('comment-composer-failed')).toHaveCount(0);
    await expect(newInput).toHaveValue(`내 정보를 다시 읽지 못한 댓글 ${tag}\n둘째 줄`);
    await expect(held).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('쓰는 사이 글이 모든 화면에서 빠지면 거절된 쓰기와 쓰던 글자를 닫을 때까지 404를 미루고, 모두 닫으면 404가 된다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 답 1: a write refused because the post is gone (NOT_FOUND) — no
    // comment under it, so it left every view — holds off the page's 404 while its text is on
    // screen: '없거나 삭제된 글입니다.' in place of the post, the texts with why, leaving asking
    // first; once the last is closed, the 404, as a reload says it.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');
    const composer = page.getByTestId('comment-composer');

    // --- the first 댓글 of a post its author deletes meanwhile.
    const first = await postThroughApi(admin, market.id, `곧 사라질 글 ${tag}`, tag);
    await page.goto(`/community/posts/${first}`);
    await composer.getByTestId('comment-input').fill(`첫 댓글 ${tag}\n둘째 줄`);
    const firstGone = await admin.post(`/api/v1/posts/${first}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(firstGone.status(), await firstGone.text()).toBe(200);
    await composer.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errPostGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`첫 댓글 ${tag}\n둘째 줄`);
    // The box held the focus as it went: it comes here, named by why.
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errPostGone);
    await expect(page.getByTestId('post-market')).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await expect(page).toHaveURL(`/community/posts/${first}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(1);
    // Gone for good: a later read of the post failing otherwise (5xx, after its retries — a refocus,
    // the query still stale from the refusal's read) does not bring back the post, its market or
    // its boxes over the text.
    let failedReads = 0;
    const postRead = `**/api/v1/posts/${first}`;
    await page.route(postRead, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      failedReads += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => failedReads).toBeGreaterThanOrEqual(3);
    // Two frames: the last failure has been written to the query and drawn.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(page.getByTestId('post-gone')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('post-market')).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errPostGone);
    await page.unroute(postRead);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByTestId('post-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    expect((await page.reload())?.status()).toBe(404);

    // --- a 답글 to the last comment under a post deleted meanwhile, and a new 댓글 beside it with no
    // write: both held with why until closed, then the 404.
    const second = await postThroughApi(admin, market.id, `댓글 하나의 글 ${tag}`, tag);
    const last = await commentThroughApi(admin, second, null, `마지막 댓글 ${tag}`);
    await page.goto(`/community/posts/${second}`);
    await composer.getByTestId('comment-input').fill(`옆에 쓰던 댓글 ${tag}`);
    await commentOf(page, last).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${last}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`마지막 댓글에 쓰던 답글 ${tag}`);
    for (const path of [`/api/v1/posts/${second}/delete`, `/api/v1/comments/${last}/delete`]) {
      const res = await admin.post(path, { data: { expectedAccountId: adminMe.id } });
      expect(res.status(), await res.text()).toBe(200);
    }
    await replyBox.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(2);
    await expect(held.getByTestId('comment-held-reason')).toHaveText([
      copy.errPostGone,
      copy.errPostGone,
    ]);
    const values = await held
      .getByTestId('comment-held-text')
      .evaluateAll((texts) => texts.map((text) => (text as HTMLTextAreaElement).value).sort());
    expect(values).toEqual([`마지막 댓글에 쓰던 답글 ${tag}`, `옆에 쓰던 댓글 ${tag}`].sort());
    // The refused 답글's box held the focus: its text has it now; the other is read out as an alert.
    const focused = page.locator('[data-testid="comment-held"]:focus');
    await expect(focused).toHaveCount(1);
    await expect(focused.getByTestId('comment-held-text')).toHaveValue(
      `마지막 댓글에 쓰던 답글 ${tag}`,
    );
    await expect(held.getByRole('alert')).toHaveCount(1);
    // One closed: the other stays and the page with it, the focus on what the page says — named
    // by it, so that is what is read out.
    await focused.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(1);
    await expect(page.getByTestId('post-gone')).toBeFocused();
    await expect(page.getByTestId('post-gone')).toHaveAccessibleName(copy.postNotFound);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();

    // --- an account facing a re-consent (the page is the gate's exception, 7-23) deletes its own
    // last comment under a post deleted meanwhile, its new 댓글's box holding text: the box goes
    // with the post, in place — its text shown with why, not put away in the tab for a post now
    // gone — and the 404 waits until it is closed (2026-10-21 답 1·2).
    const third = await postThroughApi(admin, market.id, `재동의 계정의 글 ${tag}`, tag);
    const own = await commentThroughApi(page.request, third, null, `내 마지막 댓글 ${tag}`);
    const reconsent = await asReconsent(page);
    reconsent.on = true;
    await page.goto(`/community/posts/${third}`);
    await composer.getByTestId('comment-input').fill(`재동의 중에 쓰던 댓글 ${tag}`);
    const thirdGone = await admin.post(`/api/v1/posts/${third}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(thirdGone.status(), await thirdGone.text()).toBe(200);
    await commentOf(page, own).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errPostGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`재동의 중에 쓰던 댓글 ${tag}`);
    expect(await commentDraftsInTab(page)).toEqual({});
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    expect(asked).toHaveLength(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
